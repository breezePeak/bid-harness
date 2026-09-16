import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { BID_STAGES, BID_WORK_KINDS, type BidStage, type BidWorkDescriptor, type BidWorkKind } from './control-plane-contract.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const workIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)

/** Strict persisted Work Descriptor schema. */
export const bidWorkDescriptorSchema = z.object({
  kind: z.enum(BID_WORK_KINDS),
  workId: workIdSchema,
  stage: z.enum(BID_STAGES),
  requestRef: z.string().min(1),
  requestSha256: sha256Schema,
  inputFingerprint: sha256Schema,
}).strict()

const bidWorkRequestSchema = z.object({
  schema_version: z.literal(1),
  kind: z.enum(BID_WORK_KINDS),
  work_id: workIdSchema,
  stage: z.enum(BID_STAGES),
  input_fingerprint: sha256Schema,
  payload: z.unknown(),
}).strict()

type WorkWorkspace = { readonly root: string; readonly projectRoot: string }

const resetRequestMetaSchema = z.object({
  schema_version: z.literal(1), kind: z.enum(BID_WORK_KINDS), work_id: workIdSchema, stage: z.enum(BID_STAGES),
}).passthrough()

/** Find only request and private-run roots owned by the selected stage or a later stage. */
export async function bidResetWorkPaths(workspace: WorkWorkspace, stage: BidStage): Promise<string[]> {
  const stageIndex = BID_STAGES.indexOf(stage)
  const requestsRoot = within(workspace.projectRoot, 'requests')
  const runsRoot = within(workspace.projectRoot, 'runs')
  await assertNoLinkedPath(workspace.root, requestsRoot)
  await assertNoLinkedPath(workspace.root, runsRoot)
  const paths: string[] = []
  const requestStages = new Map<string, BidStage>()
  const requestEntries = await readDirectoryIfPresent(requestsRoot)
  for (const entry of requestEntries) {
    const path = join(requestsRoot, entry)
    if (entry.endsWith('.json')) {
      const meta = resetRequestMetaSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      requestStages.set(meta.work_id, meta.stage)
      if (BID_STAGES.indexOf(meta.stage) >= stageIndex) paths.push(path)
    } else {
      const workStage = requestStages.get(entry)
      if (workStage !== undefined && BID_STAGES.indexOf(workStage) >= stageIndex) paths.push(path)
    }
  }
  for (const entry of requestEntries) {
    if (!entry.endsWith('.json')) continue
    const workId = entry.slice(0, -'.json'.length)
    const workStage = requestStages.get(workId)
    if (workStage !== undefined && BID_STAGES.indexOf(workStage) >= stageIndex) {
      const payloadDir = join(requestsRoot, workId)
      if (await pathExists(payloadDir)) paths.push(payloadDir)
    }
  }

  const runEntries = await readDirectoryIfPresent(runsRoot)
  for (const entry of runEntries) {
    const runRoot = join(runsRoot, entry)
    const marker = join(runRoot, 'work', 'work-identity.json')
    let descriptor: BidWorkDescriptor | undefined
    try {
      descriptor = bidWorkDescriptorSchema.parse(JSON.parse(await readFile(marker, 'utf8')))
    } catch (error: unknown) {
      if (recordCode(error) !== 'ENOENT') {
        if (requestStages.has(entry)) descriptor = undefined
        else throw new Error(`BID_RESET_ORPHAN_WORK_UNRESOLVED:${runRoot}`, { cause: error })
      }
    }
    const workStage = descriptor?.stage ?? requestStages.get(entry)
    if (workStage === undefined) throw new Error(`BID_RESET_ORPHAN_WORK_UNRESOLVED:${runRoot}`)
    if (BID_STAGES.indexOf(workStage) >= stageIndex) paths.push(runRoot)
  }
  return [...new Set(paths)]
}

async function readDirectoryIfPresent(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort() } catch (error: unknown) {
    if (recordCode(error) === 'ENOENT') return []
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error: unknown) {
    if (recordCode(error) === 'ENOENT') return false
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
 * @param kind - Resume adapter category.
 * @param stage - Workflow stage associated with the work.
 * @param payload - Exact request payload required by resume.
 * @param inputIdentity - Inputs whose change invalidates exact resume.
 * @param workId - Stable work identity, generated when omitted.
 * @returns Descriptor that verifies and locates the durable request.
 */
export async function persistBidWorkRequest(
  workspace: WorkWorkspace,
  kind: BidWorkKind,
  stage: BidStage,
  payload: unknown,
  inputIdentity: unknown,
  workId: string = randomUUID(),
): Promise<BidWorkDescriptor> {
  const inputFingerprint = bidInputFingerprint(inputIdentity)
  const requestRef = `requests/${workId}.json`
  const request = bidWorkRequestSchema.parse({
    schema_version: 1,
    kind,
    work_id: workId,
    stage,
    input_fingerprint: inputFingerprint,
    payload,
  })
  const bytes = `${JSON.stringify(request, null, 2)}\n`
  const requestSha256 = createHash('sha256').update(bytes).digest('hex')
  const path = within(workspace.projectRoot, requestRef)
  await assertNoLinkedPath(workspace.root, path)
  await writeFileAtomic(path, bytes, { mode: 0o600, dirMode: 0o700 })
  return { kind, workId, stage, requestRef, requestSha256, inputFingerprint }
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
  if (request.kind !== descriptor.kind || request.work_id !== descriptor.workId || request.stage !== descriptor.stage
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
