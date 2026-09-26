/** Writing Plan 能力在 Work 候选中复用 S5 的用户原话、patch 和 AC 身份规则。 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import type { BidCapabilityCall, BidCapabilityExecutionContext, BidCapabilityResult } from './bid-capability-contract.ts'
import { capabilityFileHash } from './bid-capability-files.ts'
import { parseConfirmedOutlineArtifact, outlineArtifactSha256 } from './outline-confirmation-artifacts.ts'
import { buildWritableSectionWorklist } from './section-evidence-context.ts'
import { recordOnlySchemaVersion } from './schema-version.ts'
import { applyWritingPlanInput, parseWritingPlan, resolveWritingRequirementMessages,
  validateWritingPlan, validateWritingPlanInput, writingRequestSchema,
  WRITING_PLAN_SCHEMA_VERSION, type WritingPlan } from './writing-requirements.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

type WritingPlanCall = Extract<BidCapabilityCall, { capability: 'writing.plan' }>
const PLAN_PATH = 'chapters/writing-plan.json'
const REQUEST_PATH = 'chapters/writing-request.json'
const APPLIED_PATH = 'chapters/applied-writing-plan.json'

async function optionalJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return JSON.parse(await readFile(absolute, 'utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Writing Plan 及首次问题状态是本能力仅有的可写文件。
 * @returns 精确文件许可。
 */
export function allowedWritingPlanCapabilityWrites(): ReadonlySet<string> {
  return new Set([PLAN_PATH, REQUEST_PATH])
}

/**
 * 把用户原话绑定的语义 patch 写入独立候选，未变章节和 AC 身份保持原值。
 * @param call 已解析的 Writing Plan 输入。
 * @param context Host 步骤身份及原 Interaction Session。
 * @returns 实际改变的计划文件与受影响叶节。
 */
export async function executeWritingPlanCapability(
  call: WritingPlanCall, context: BidCapabilityExecutionContext,
): Promise<{ readonly result: BidCapabilityResult }> {
  const workspace = context.working
  const session = context.sourceSession
  if (session === undefined || session.id !== context.authorization.session_id) {
    throw new Error('BID_WRITING_PLAN_USER_SESSION_UNAVAILABLE')
  }
  const outlineRaw = await optionalJson(workspace, 'outline/confirmed-outline.json')
  if (outlineRaw === undefined) throw new Error('BID_WRITING_PLAN_OUTLINE_REQUIRED')
  const outline = parseConfirmedOutlineArtifact(outlineRaw)
  const hash = outlineArtifactSha256(outline)
  const previousRaw = await optionalJson(workspace, PLAN_PATH)
  const previous = previousRaw === undefined ? undefined : parseWritingPlan(previousRaw)
  if (previous !== undefined && previous.confirmed_outline_sha256 !== hash) {
    throw new Error('BID_WRITING_PLAN_OUTLINE_MISMATCH')
  }
  const input = call.input
  const issues = validateWritingPlanInput(input, outline, previous)
  if (issues.length > 0) throw new Error(`BID_WRITING_PLAN_INVALID: ${issues.join('；')}`)
  if (!input.user_message_refs.some(ref => ref.message_id === context.authorization.message_id
    && ref.session_id === context.authorization.session_id)) {
    throw new Error('BID_WRITING_PLAN_AUTHORIZATION_MESSAGE_MISSING')
  }
  let marker: ReturnType<typeof writingRequestSchema.parse> | undefined
  if (input.update_kind === 'initial') {
    const raw = await optionalJson(workspace, REQUEST_PATH)
    if (raw === undefined) throw new Error('BID_WRITING_PLAN_INITIAL_REQUEST_REQUIRED')
    marker = writingRequestSchema.parse(raw)
    if (marker.request_id !== input.writing_request_id || marker.attempt_id !== input.attempt_id
      || marker.confirmed_outline_sha256 !== hash || marker.owner_session_id !== session.id
      || marker.state !== 'answered' || marker.answer === undefined || marker.continuation !== 'allowed') {
      throw new Error('BID_WRITING_PLAN_INITIAL_REQUEST_INVALID')
    }
  }
  const resolved = resolveWritingRequirementMessages(session, input.user_message_refs)
  let materialized = applyWritingPlanInput(input, resolved, previous)
  if (marker?.answer?.kind === 'custom') {
    materialized = { ...materialized,
      user_requirements: [...materialized.user_requirements, marker.answer.custom ?? ''] }
  }
  const { affected_section_ids: affectedByPatch, ...fields } = materialized
  const leaves = buildWritableSectionWorklist(outline).map(section => section.id)
  const globalChanged = previous !== undefined
    && (JSON.stringify(fields.global_instructions) !== JSON.stringify(previous.global_instructions)
      || JSON.stringify(fields.document_acceptance) !== JSON.stringify(previous.document_acceptance))
  if (context.sectionIds !== null && (globalChanged || affectedByPatch.some(id => !context.sectionIds?.has(id)))) {
    throw new Error('BID_WRITING_PLAN_SCOPE_INVALID')
  }
  let affected = globalChanged || previous === undefined ? leaves : [...affectedByPatch]
  if (previous !== undefined && input.update_kind === 'patch') {
    const appliedRaw = await optionalJson(workspace, APPLIED_PATH)
    const appliedVersion = appliedRaw === undefined ? previous.plan_version
      : z.object({ schema_version: recordOnlySchemaVersion(1), plan_version: z.number().int().positive() }).strict()
        .parse(appliedRaw).plan_version
    if (appliedVersion < previous.plan_version && previous.revision !== null) {
      affected = [...new Set([...previous.revision.affected_section_ids, ...affected])]
    }
  }
  const plan: WritingPlan = parseWritingPlan({
    ...fields, schema_version: WRITING_PLAN_SCHEMA_VERSION, scope: 'technical_bid',
    confirmed: true, confirmed_outline_sha256: hash, plan_version: (previous?.plan_version ?? 0) + 1,
    revision: previous === undefined ? null : { summary: input.update_kind === 'patch'
      ? input.summary : '首次写作计划', affected_section_ids: affected,
    base_plan_version: previous.plan_version },
  })
  const planIssues = validateWritingPlan(plan, outline)
  if (planIssues.length > 0) throw new Error(`BID_WRITING_PLAN_INVALID: ${planIssues.join('；')}`)
  const before = new Map(await Promise.all([...allowedWritingPlanCapabilityWrites()]
    .map(async path => [path, await capabilityFileHash(workspace, path)] as const)))
  await context.run.commits.publish(async (lease) => {
    await lease.writeJson(within(workspace.projectRoot, PLAN_PATH), plan)
    if (marker !== undefined) await lease.writeJson(within(workspace.projectRoot, REQUEST_PATH), {
      ...marker, state: 'consumed', applied_plan_version: plan.plan_version,
      error: undefined, processing: undefined, processing_message_id: undefined,
    })
  })
  const changed: string[] = []
  for (const path of allowedWritingPlanCapabilityWrites()) {
    if (before.get(path) !== await capabilityFileHash(workspace, path)) changed.push(path)
  }
  return { result: { target_section_ids: affected, changed_artifacts: changed,
    change_summary: `写作计划已更新至 v${String(plan.plan_version)}，影响 ${String(affected.length)} 个章节`,
    warnings: [], missing_topics: [], needs_input: false } }
}

/**
 * 对照确认目录复核步骤写出的完整 Writing Plan。
 * @param context 当前步骤候选。
 */
export async function validateWritingPlanCapability(
  context: Pick<BidCapabilityExecutionContext, 'working'>,
): Promise<void> {
  const outlineRaw = await optionalJson(context.working, 'outline/confirmed-outline.json')
  const planRaw = await optionalJson(context.working, PLAN_PATH)
  if (outlineRaw === undefined || planRaw === undefined) throw new Error('BID_WRITING_PLAN_REQUIRED')
  const outline = parseConfirmedOutlineArtifact(outlineRaw)
  const plan = parseWritingPlan(planRaw)
  if (plan.confirmed_outline_sha256 !== outlineArtifactSha256(outline)
    || validateWritingPlan(plan, outline).length > 0) throw new Error('BID_WRITING_PLAN_INVALID')
}
