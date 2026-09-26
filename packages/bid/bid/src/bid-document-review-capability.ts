/** 整书审核能力复用 S5 的全局合规与完成度协议，只发布审核记录。 */
import type { BidCapabilityExecutionContext, BidCapabilityResult } from './bid-capability-contract.ts'
import { capabilityFileHash, readCapabilityJson } from './bid-capability-files.ts'
import { executeDocumentReview } from './chapter-writing-executor.ts'
import { parseChapterWritingCompletionState } from './chapter-writing-completion-review.ts'
import { parseGlobalComplianceReviewArtifact } from './chapter-writing-global-review-artifacts.ts'
import { validateChapterWriting } from './chapter-writing-validator.ts'
import { parseConfirmedOutlineArtifact } from './outline-confirmation-artifacts.ts'
import { buildWritableSectionWorklist } from './section-evidence-context.ts'
import { validateWritingCapability } from './bid-writing-capability.ts'

const REVIEW_PATHS = ['chapters/global-compliance-review.json', 'chapters/completion-review.json'] as const

/**
 * 整书审核只能更新文档级报告。
 * @returns 两份审核报告的项目相对路径。
 */
export function allowedDocumentReviewWrites(): ReadonlySet<string> { return new Set(REVIEW_PATHS) }

/**
 * 重新审核已完成文档；合法的审核失败作为结论返回，不触发正文修复。
 * @param context Host 授权的项目级候选步骤。
 * @param maxRepairAttempts 审核协议的修复上限。
 * @returns 本次审核的目标章节与真实变更文件。
 */
export async function executeDocumentReviewCapability(
  context: BidCapabilityExecutionContext, maxRepairAttempts: number,
): Promise<{ readonly result: BidCapabilityResult }> {
  if (context.sectionIds !== null) throw new Error('BID_DOCUMENT_REVIEW_PROJECT_SCOPE_REQUIRED')
  const workspace = context.working
  const outline = parseConfirmedOutlineArtifact(await readCapabilityJson(workspace, 'outline/confirmed-outline.json'))
  const ids = buildWritableSectionWorklist(outline).map(section => section.id)
  await validateWritingCapability(context, ids)
  const before = new Map(await Promise.all(REVIEW_PATHS.map(async path => [path, await capabilityFileHash(workspace, path)] as const)))
  await executeDocumentReview(context.agent, workspace, context.run, maxRepairAttempts)
  await validateDocumentReviewCapability(context)
  const changed: string[] = []
  for (const path of REVIEW_PATHS) if (before.get(path) !== await capabilityFileHash(workspace, path)) changed.push(path)
  const global = parseGlobalComplianceReviewArtifact(await readCapabilityJson(workspace, REVIEW_PATHS[0]))
  const completion = parseChapterWritingCompletionState(await readCapabilityJson(workspace, REVIEW_PATHS[1]))
  const warnings = global.items.filter(item => item.status === 'fail' || item.status === 'pending')
    .map(item => `${item.compliance_id}: ${item.issue ?? item.status}`)
  const missingTopics = completion.completion?.document_acceptance_results
    .filter(item => item.status !== 'met').map(item => `${item.criterion_id}: ${item.reason}`) ?? []
  return { result: { target_section_ids: ids, changed_artifacts: changed,
    change_summary: `已重新审核全书 ${String(ids.length)} 个章节`, warnings,
    missing_topics: missingTopics, needs_input: false } }
}

/**
 * 用完整章节 Validator 核对新审核记录与当前正文身份。
 * @param context 当前候选与现有完整章节产物。
 */
export async function validateDocumentReviewCapability(
  context: Pick<BidCapabilityExecutionContext, 'working'>,
): Promise<void> {
  const artifacts = ([
    ['chapters/execution-plan.json', 'chapter_execution_plan'],
    ['chapters/execution-log.json', 'chapter_execution_log'],
    ['chapters/manifest.json', 'chapter_manifest'],
    [REVIEW_PATHS[0], 'global_compliance_review'],
    [REVIEW_PATHS[1], 'chapter_completion_review'],
  ] as const).map(([path, type]) => ({ stage: 'chapter_writing' as const, path, type }))
  const checked = await validateChapterWriting(context.working, 'chapter_writing', artifacts)
  if (!checked.ok) throw new Error(`BID_DOCUMENT_REVIEW_INVALID: ${checked.issues.map(issue => issue.code).join(', ')}`)
}
