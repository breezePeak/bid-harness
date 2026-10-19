import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { BID_STAGES, BID_WORK_KINDS, type BidStage, type BidWorkDescriptor, type BidWorkKind } from './control-plane-contract.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const workIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)

const stageWorkKindSchema = z.enum(BID_WORK_KINDS).exclude(['capability_task'])
const workIdentitySchema = z.object({
  workId: workIdSchema,
  requestRef: z.string().min(1),
  requestSha256: sha256Schema,
  inputFingerprint: sha256Schema,
}).strict()

/** 按实际执行类型校验持久 Work 身份；独立能力没有专业阶段。 */
export const bidWorkDescriptorSchema = z.discriminatedUnion('kind', [
  workIdentitySchema.extend({ kind: z.literal('capability_task') }).strict(),
  workIdentitySchema.extend({ kind: stageWorkKindSchema, stage: z.enum(BID_STAGES) }).strict(),
])

const workRequestFields = {
  schema_version: z.literal(2),
  work_id: workIdSchema,
  input_fingerprint: sha256Schema,
  payload: z.unknown(),
}
const bidWorkRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...workRequestFields, kind: z.literal('capability_task') }).strict(),
  z.object({ ...workRequestFields, kind: stageWorkKindSchema, stage: z.enum(BID_STAGES) }).strict(),
])

type WorkWorkspace = { readonly root: string; readonly projectRoot: string }

const resetRequestMetaSchema = bidWorkRequestSchema

/**
 * Find only request and private-run roots owned by the selected stage or a later stage.
 * @param workspace 项目工作区。
 * @param stage 需要重置的阶段。
 * @returns 阶段重置时需要清理的工作路径。
 */
export async function bidResetWorkPaths(workspace: WorkWorkspace, stage: BidStage): Promise<string[]> {
  const stageIndex = BID_STAGES.indexOf(stage)
  const requestsRoot = within(workspace.projectRoot, 'requests')
  const runsRoot = within(workspace.projectRoot, 'runs')
  await assertNoLinkedPath(workspace.root, requestsRoot)
  await assertNoLinkedPath(workspace.root, runsRoot)
  const paths: string[] = []
  const requests = new Map<string, z.infer<typeof resetRequestMetaSchema>>()
  const requestDirectories: Array<{ workId: string; path: string }> = []
  const requestEntries = await readDirectoryIfPresent(requestsRoot)
  for (const entry of requestEntries) {
    const path = join(requestsRoot, entry)
    await assertNoLinkedPath(workspace.root, path)
    const info = await lstat(path)
    if (info.isDirectory()) {
      requestDirectories.push({ workId: entry, path })
      continue
    }
    if (!info.isFile() || !entry.endsWith('.json')) throw new Error(`BID_RESET_REQUEST_PATH_UNRESOLVED:${path}`)
    let meta: z.infer<typeof resetRequestMetaSchema>
    try { meta = resetRequestMetaSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error: unknown) { throw new Error(`BID_RESET_REQUEST_READ_FAILED:${path}`, { cause: error }) }
    if (entry !== `${meta.work_id}.json`) throw new Error(`BID_RESET_REQUEST_IDENTITY_MISMATCH:${path}`)
    requests.set(meta.work_id, meta)
    if (meta.kind !== 'capability_task' && BID_STAGES.indexOf(meta.stage) >= stageIndex) paths.push(path)
  }

  const runStages = new Map<string, BidStage | null>()
  const runEntries = await readDirectoryIfPresent(runsRoot)
  for (const entry of runEntries) {
    const runRoot = join(runsRoot, entry)
    await assertNoLinkedPath(workspace.root, runRoot)
    if (!(await lstat(runRoot)).isDirectory()) throw new Error(`BID_RESET_WORK_PATH_UNRESOLVED:${runRoot}`)
    const marker = join(runRoot, 'work', 'work-identity.json')
    await assertNoLinkedPath(workspace.root, marker)
    let descriptor: BidWorkDescriptor | undefined
    try {
      descriptor = bidWorkDescriptorSchema.parse(JSON.parse(await readFile(marker, 'utf8')))
    } catch (error: unknown) {
      if (recordCode(error) !== 'ENOENT') throw new Error(`BID_RESET_WORK_IDENTITY_READ_FAILED:${marker}`, { cause: error })
    }
    if (descriptor !== undefined && descriptor.workId !== entry) throw new Error(`BID_RESET_WORK_IDENTITY_MISMATCH:${marker}`)
    const request = requests.get(entry)
    if (descriptor !== undefined && request !== undefined
      && (descriptor.kind !== request.kind || descriptor.kind !== 'capability_task' && request.kind !== 'capability_task'
        && descriptor.stage !== request.stage)) {
      throw new Error(`BID_RESET_WORK_IDENTITY_MISMATCH:${marker}`)
    }
    const workStage = descriptor?.kind === 'capability_task' || request?.kind === 'capability_task' ? null
      : descriptor?.stage ?? request?.stage
    if (workStage === undefined) {
      const entries = await readDirectoryIfPresent(runRoot)
      if (!z.uuid().safeParse(entry).success || entries.length === 0
        || entries.some(name => name !== 'scratch' && name !== 'staging')) {
        throw new Error(`BID_RESET_ORPHAN_WORK_UNRESOLVED:${runRoot}`)
      }
      for (const name of entries) {
        const path = join(runRoot, name)
        await assertNoLinkedPath(workspace.root, path)
        if (!(await lstat(path)).isDirectory()) throw new Error(`BID_RESET_ORPHAN_WORK_UNRESOLVED:${runRoot}`)
      }
      paths.push(runRoot)
      continue
    }
    runStages.set(entry, workStage)
    if (workStage !== null && BID_STAGES.indexOf(workStage) >= stageIndex) paths.push(runRoot)
  }
  for (const directory of requestDirectories) {
    const request = requests.get(directory.workId)
    const requestStage = request?.kind === 'capability_task' ? null : request?.stage
    const runStage = runStages.get(directory.workId)
    if (requestStage !== undefined && runStage !== undefined && requestStage !== runStage) {
      throw new Error(`BID_RESET_REQUEST_IDENTITY_MISMATCH:${directory.path}`)
    }
    const workStage = requestStage === undefined ? runStage : requestStage
    if (workStage === undefined) throw new Error(`BID_RESET_REQUEST_DIRECTORY_UNRESOLVED:${directory.path}`)
    if (workStage !== null && BID_STAGES.indexOf(workStage) >= stageIndex) paths.push(directory.path)
  }
  return [...new Set(paths)]
}

async function readDirectoryIfPresent(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort() } catch (error: unknown) {
    if (recordCode(error) === 'ENOENT') return []
    throw error
  }
}

function recordCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/**
 * Return a stable SHA-256 identity for JSON-compatible input.
 * @param value - JSON-compatible input to identify.
 * @returns Lowercase hexadecimal SHA-256 identity.
 */
export function bidInputFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Persist a Long Run request before any Run identity is created.
 * @param workspace - Workspace that owns the request artifact.
 * @param context 实际 Work 类型及专业阶段；通用能力不携带阶段。
 * @param payload - Exact request payload required by resume.
 * @param inputIdentity - Inputs whose change invalidates exact resume.
 * @param workId - Stable work identity, generated when omitted.
 * @returns Descriptor that verifies and locates the durable request.
 */
export async function persistBidWorkRequest(
  workspace: WorkWorkspace,
  context: { kind: 'capability_task' } | { kind: Exclude<BidWorkKind, 'capability_task'>; stage: BidStage },
  payload: unknown,
  inputIdentity: unknown,
  workId: string = randomUUID(),
): Promise<BidWorkDescriptor> {
  const inputFingerprint = bidInputFingerprint(inputIdentity)
  const requestRef = `requests/${workId}.json`
  const request = bidWorkRequestSchema.parse({
    schema_version: 2,
    ...context,
    work_id: workId,
    input_fingerprint: inputFingerprint,
    payload,
  })
  const bytes = `${JSON.stringify(request, null, 2)}\n`
  const requestSha256 = createHash('sha256').update(bytes).digest('hex')
  const path = within(workspace.projectRoot, requestRef)
  await assertNoLinkedPath(workspace.root, path)
  await writeFileAtomic(path, bytes, { mode: 0o600, dirMode: 0o700 })
  return { ...context, workId, requestRef, requestSha256, inputFingerprint }
}

/**
 * Read and verify the request artifact named by a Work Descriptor.
 * @param workspace - Workspace that owns the request artifact.
 * @param descriptor - Descriptor containing the expected request identity.
 * @returns Verified request payload.
 */
export async function readBidWorkRequest(
  workspace: WorkWorkspace,
  descriptor: BidWorkDescriptor,
): Promise<unknown> {
  bidWorkDescriptorSchema.parse(descriptor)
  if (descriptor.requestRef !== `requests/${descriptor.workId}.json`) throw new Error('BID_WORK_REQUEST_REF_INVALID')
  const path = within(workspace.projectRoot, descriptor.requestRef)
  await assertNoLinkedPath(workspace.root, path)
  const bytes = await readFile(path, 'utf8')
  if (createHash('sha256').update(bytes).digest('hex') !== descriptor.requestSha256) {
    throw new Error('BID_WORK_REQUEST_IDENTITY_MISMATCH')
  }
  const request = bidWorkRequestSchema.parse(JSON.parse(bytes))
  if (request.kind !== descriptor.kind || request.work_id !== descriptor.workId
    || request.kind !== 'capability_task' && descriptor.kind !== 'capability_task' && request.stage !== descriptor.stage
    || request.input_fingerprint !== descriptor.inputFingerprint) throw new Error('BID_WORK_REQUEST_IDENTITY_MISMATCH')
  return request.payload
}

/**
 * Return the durable working directory shared by all attempts of one work item.
 * @param workspace - Workspace that owns the work item.
 * @param descriptor - Descriptor containing the stable work identity.
 * @returns Absolute working-directory path.
 */
export function bidWorkRoot(workspace: WorkWorkspace, descriptor: BidWorkDescriptor): string {
  bidWorkDescriptorSchema.parse(descriptor)
  return within(workspace.projectRoot, `runs/${descriptor.workId}/work`)
}

/**
 * 按当前项目中的真实 Work ID 加载描述符，不接受任意请求路径。
 * @param workspace 拥有请求的项目。
 * @param workId 真实 Work ID。
 * @returns 请求身份；请求不存在时为 null。
 */
export async function readBidWorkDescriptor(workspace: WorkWorkspace, workId: string): Promise<BidWorkDescriptor | null> {
  workIdSchema.parse(workId)
  const requestRef = 'requests/' + workId + '.json'
  const path = within(workspace.projectRoot, requestRef)
  await assertNoLinkedPath(workspace.root, path)
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if (recordCode(error) === 'ENOENT') return null
    throw error
  }
  const record = bidWorkRequestSchema.parse(JSON.parse(raw))
  if (record.work_id !== workId) throw new Error('BID_WORK_REQUEST_IDENTITY_MISMATCH')
  return { ...(record.kind === 'capability_task' ? { kind: record.kind } : { kind: record.kind, stage: record.stage }), workId, requestRef,
    requestSha256: createHash('sha256').update(raw).digest('hex'), inputFingerprint: record.input_fingerprint }
}
