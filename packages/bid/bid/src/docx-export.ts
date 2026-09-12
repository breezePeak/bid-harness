/** 按确认目录组合完整正文或已完成章节快照；项目 operation 和阶段 checkpoint 由 Host 持有。 */
import { readFile } from 'node:fs/promises'
import { posix, sep } from 'node:path'
import { readDocxXml } from './docx-template.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { collectDocxChapterBody } from './docx-content.ts'
import { parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { parseChapterExecutionLog } from './chapter-writing-plan-artifacts.ts'
import { BidStageExecutionError, type BidStage, type StageArtifact, type StageValidationIssue, type StageValidationResult } from './control-plane-contract.ts'
import type { BidWorkspace } from './index.ts'
import { outlineArtifactSha256, parseConfirmedOutlineArtifact } from './outline-confirmation-artifacts.ts'
import { buildOutlineView } from './outline-confirmation-browser.ts'
import { buildWritableSectionWorklist } from './section-evidence-context.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { estimateChapterWritingPages } from './page-estimate.ts'
import { parseWritingPlan } from './writing-requirements.ts'
import { assessBoundedMetric } from './acceptance-criteria.ts'
import { findBidInternalIdentifiers } from './customer-facing-prose.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'

async function readProjectFile(workspace: BidWorkspace, path: string): Promise<string> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  return readFile(absolute, 'utf8')
}

export { collectDocxChapterBody } from './docx-content.ts'

/**
 * 按确认目录导出父节点概述及完整叶节正文；章节记录必须匹配当前目录。
 * @param workspace 已由 Host 锁定的项目。
 * @param signal 本次阶段操作的取消信号。
 * @param destination 项目内输出路径；省略时写入固定交付文件。
 * @param contentScope 完整 Manifest，或当前已完成章节的稳定快照。
 * @returns 项目输出目录中的 DOCX 产物引用。
 */
export async function executeDocxExport(
  workspace: BidWorkspace,
  signal?: AbortSignal,
  destination = posix.join(workspace.config.outputDirectory, 'bid.docx'),
  contentScope: 'complete' | 'completed_chapters' = 'complete',
): Promise<StageArtifact[]> {
  const markdown = await collectDocxMarkdown(workspace, signal, contentScope)
  if (!destination.endsWith('.docx')) throw new Error('bid-output-must-be-docx')
  const source = destination.slice(0, -'.docx'.length) + '.md'
  const absolute = within(workspace.projectRoot, source)
  await assertNoLinkedPath(workspace.root, absolute)
  signal?.throwIfAborted()
  await writeFileAtomic(absolute, markdown, { mode: 0o600, dirMode: 0o700 })
  await workspace.exportDocx(source, destination)
  return [{ stage: 'docx_export', type: 'docx', path: destination }]
}

/** 读取确认目录和完整章节或当前已完成章节为固定 Markdown 快照；不修改源章节。
 * @param workspace 当前项目。
 * @param signal 取消信号。
 * @param contentScope 完整 Manifest，或 execution-log 中前后身份稳定的已完成章节。
 * @returns 当前导出范围的文档 Markdown。
 */
export async function collectDocxMarkdown(
  workspace: BidWorkspace,
  signal?: AbortSignal,
  contentScope: 'complete' | 'completed_chapters' = 'complete',
): Promise<string> {
  signal?.throwIfAborted()
  const [outline, requirements, scoring, compliance, responsePoints, writingPlan] = await Promise.all([
    readProjectFile(workspace, 'outline/confirmed-outline.json').then(value => parseConfirmedOutlineArtifact(JSON.parse(value))),
    readProjectFile(workspace, 'analysis/requirements.json').then(value => parseTenderRequirementsArtifact(JSON.parse(value))),
    readProjectFile(workspace, 'analysis/scoring.json').then(value => parseTenderScoringArtifact(JSON.parse(value))),
    readProjectFile(workspace, 'analysis/compliance.json').then(value => parseTenderComplianceArtifact(JSON.parse(value))),
    readProjectFile(workspace, 'analysis/scoring-response-points.json').then(value => parseScoringResponsePointCatalog(JSON.parse(value))),
    readProjectFile(workspace, 'chapters/writing-plan.json').then(value => parseWritingPlan(JSON.parse(value))),
  ])
  const worklist = buildWritableSectionWorklist(outline)
  const chapters = new Map<string, { content_path: string; markdown?: string }>()
  if (contentScope === 'complete') {
    const manifest = parseChapterWritingManifest(JSON.parse(await readProjectFile(workspace, 'chapters/manifest.json')))
    if (manifest.confirmed_outline_sha256 !== outlineArtifactSha256(outline)) {
      throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_OUTLINE_MISMATCH', message: '章节记录与当前确认目录不匹配。', artifact: 'chapters/manifest.json' }])
    }
    for (const chapter of manifest.chapters) chapters.set(chapter.section_id, chapter)
    if (chapters.size !== manifest.chapters.length || chapters.size !== worklist.length
      || worklist.some((section, index) => chapters.get(section.id)?.content_path !== `chapters/sections/${String(index + 1).padStart(4, '0')}.md`)) {
      throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_CHAPTER_SET_INVALID', message: '章节记录必须完整对应确认目录中的可写章节及正文路径。', artifact: 'chapters/manifest.json' }])
    }
  } else {
    const outlineHash = outlineArtifactSha256(outline)
    const matchesCurrentPlan = (log: ReturnType<typeof parseChapterExecutionLog>): boolean =>
      log.confirmed_outline_sha256 === outlineHash
      && log.writing_plan_version === writingPlan.plan_version
      && log.sections.length === worklist.length
      && worklist.every((section, index) => log.sections[index]?.section_id === section.id)
    const before = parseChapterExecutionLog(JSON.parse(await readProjectFile(workspace, 'chapters/execution-log.json')))
    if (!matchesCurrentPlan(before)) {
      throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_EXECUTION_LOG_INVALID', message: '章节执行记录与当前确认目录或写作计划不匹配。', artifact: 'chapters/execution-log.json' }])
    }
    for (const [index, section] of worklist.entries()) {
      const execution = before.sections[index]
      if (execution?.status !== 'completed') continue
      if (execution.final_writer_child_session_id === null || execution.final_reviewer_child_session_id === null) {
        throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_EXECUTION_LOG_INVALID', message: `章节 ${section.id} 缺少完成身份。`, artifact: 'chapters/execution-log.json' }])
      }
      const content_path = `chapters/sections/${String(index + 1).padStart(4, '0')}.md`
      chapters.set(section.id, { content_path, markdown: await readProjectFile(workspace, content_path) })
    }
    if (chapters.size === 0) {
      throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_NO_COMPLETED_CHAPTERS', message: '当前还没有已完成并保存的章节。', artifact: 'chapters/execution-log.json' }])
    }
    const after = parseChapterExecutionLog(JSON.parse(await readProjectFile(workspace, 'chapters/execution-log.json')))
    if (!matchesCurrentPlan(after)) {
      throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_SNAPSHOT_CHANGED', message: '章节执行记录在导出快照期间发生变化，请重新导出。', artifact: 'chapters/execution-log.json' }])
    }
    for (const [index, section] of worklist.entries()) {
      if (!chapters.has(section.id)) continue
      const left = before.sections[index]
      const right = after.sections[index]
      if (left?.status !== 'completed' || right?.status !== 'completed'
        || left.epoch !== right.epoch
        || left.final_writer_child_session_id !== right.final_writer_child_session_id
        || left.final_reviewer_child_session_id !== right.final_reviewer_child_session_id) {
        throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_SNAPSHOT_CHANGED', message: `章节 ${section.id} 在导出快照期间发生变化，请重新导出。`, artifact: 'chapters/execution-log.json' }])
      }
    }
  }
  const included = new Set(chapters.keys())
  if (contentScope === 'completed_chapters') {
    const byId = new Map(outline.sections.map(section => [section.id, section]))
    for (const sectionId of [...included]) {
      let parentId = byId.get(sectionId)?.parent_id ?? null
      while (parentId !== null) {
        included.add(parentId)
        parentId = byId.get(parentId)?.parent_id ?? null
      }
    }
  }
  const parts = [`# ${outline.document_title}`]
  for (const { section, number, depth } of buildOutlineView(outline.sections)) {
    signal?.throwIfAborted()
    if (contentScope === 'completed_chapters' && !included.has(section.id)) continue
    const headingDepth = Math.min(6, depth)
    parts.push(`${'#'.repeat(headingDepth)} ${number} ${section.title}`)
    if (!section.writable && section.summary !== undefined) parts.push(section.summary)
    const chapter = chapters.get(section.id)
    if (chapter === undefined) continue
    const markdown = chapter.markdown ?? await readProjectFile(workspace, chapter.content_path)
    if (markdown.trim().length === 0) throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_CONTENT_EMPTY', message: '章节正文为空，不能导出。', artifact: chapter.content_path }])
    parts.push(collectDocxChapterBody(markdown, section.title, section.id, number, headingDepth))
  }
  const markdown = `${parts.join('\n\n')}\n`
  const leaked = findBidInternalIdentifiers(markdown, {
    outline, requirements, scoring, compliance, responsePoints,
    acceptanceCriterionIds: [
      ...writingPlan.document_acceptance.map(item => item.id),
      ...writingPlan.sections.flatMap(section => section.acceptance_criteria.map(item => item.id)),
    ],
  })
  if (leaked.length > 0) {
    throw new BidStageExecutionError([{
      code: 'DOCX_EXPORT_INTERNAL_ID_VISIBLE',
      message: `标书客户可见内容包含系统内部编号 ${leaked.join('、')}；请先修订对应标题、总述或正文。`,
    }])
  }
  return markdown
}

/**
 * 检查 S6 返回预期产物且 DOCX 文件已经保存。
 * @param workspace 当前项目。
 * @param stage 被验证的阶段。
 * @param artifacts 本次导出返回的产物引用。
 * @returns 可完成 S6 的结果，或未发布有效 DOCX 的原因。
 */
export async function validateDocxExport(
  workspace: BidWorkspace,
  stage: BidStage,
  artifacts: readonly StageArtifact[],
): Promise<StageValidationResult> {
  const path = artifacts[0]?.path ?? posix.join(workspace.config.outputDirectory, 'bid.docx')
  try {
    if (stage !== 'docx_export' || artifacts.length !== 1 || artifacts[0]?.stage !== stage || artifacts[0].type !== 'docx'
      || !path.startsWith(`${workspace.config.outputDirectory}/`) || !path.endsWith('.docx')) {
      throw new Error('invalid-export-artifact')
    }
    const absolute = within(workspace.projectRoot, path)
    if (!absolute.startsWith(`${workspace.outputRoot}${sep}`)) throw new Error('invalid-export-path')
    await assertNoLinkedPath(workspace.root, absolute)
    const bytes = await readFile(absolute)
    await readDocxXml(bytes)
  } catch {
    return { ok: false, issues: [{ code: 'DOCX_EXPORT_ARTIFACT_INVALID', message: '导出目录中缺少有效的 DOCX 产物。', artifact: path }] }
  }
  return { ok: true }
}

/**
 * Independently report the confirmed page target for an already valid DOCX export.
 * @param workspace Current project whose canonical chapter Markdown was exported.
 * @returns Warnings that describe an unmet or unavailable estimate without invalidating the file.
 */
export async function assessDocxExportPageTarget(workspace: BidWorkspace): Promise<StageValidationIssue[]> {
  try {
    const outline = parseConfirmedOutlineArtifact(JSON.parse(await readProjectFile(workspace, 'outline/confirmed-outline.json')))
    let writingPlan: ReturnType<typeof parseWritingPlan>
    try {
      writingPlan = parseWritingPlan(JSON.parse(await readProjectFile(workspace, 'chapters/writing-plan.json')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (writingPlan.confirmed_outline_sha256 !== outlineArtifactSha256(outline)) throw new Error('写作计划与当前确认目录不一致。')
    const documentCriteria = writingPlan.document_acceptance.filter(item =>
      item.evaluator.kind === 'deterministic' && item.evaluator.metric === 'estimated_pages')
    const sectionCriteria = writingPlan.sections.flatMap(section => section.acceptance_criteria
      .filter(item => item.evaluator.kind === 'deterministic' && item.evaluator.metric === 'estimated_pages')
      .map(item => ({ section_id: section.section_id, criterion: item })))
    if (documentCriteria.length === 0 && sectionCriteria.length === 0) return []
    const estimate = await estimateChapterWritingPages(workspace, outline)
    const measured = [
      ...documentCriteria.map(criterion => ({ criterion, value: estimate.total })),
      ...sectionCriteria.flatMap(({ section_id, criterion }) => {
        const value = estimate.sections.get(section_id)?.pages
        return value === undefined ? [] : [{ criterion, value }]
      }),
    ]
    return measured.flatMap(({ criterion, value }): StageValidationIssue[] => {
      if (criterion.evaluator.kind !== 'deterministic') return []
      const assessment = assessBoundedMetric(criterion.evaluator.min, criterion.evaluator.max, value)
      if (assessment.status === 'met') return []
      return [{
        code: assessment.status === 'below' ? 'DOCX_EXPORT_PAGE_TARGET_BELOW' : 'DOCX_EXPORT_PAGE_TARGET_ABOVE',
        message: assessment.status === 'below'
          ? `Word 已生成；${criterion.id} 当前格式估算 ${value.toFixed(2)} 页，低于下限，尚差 ${assessment.difference.toFixed(2)} 页，实际分页尚未核验。`
          : `Word 已生成；${criterion.id} 当前格式估算 ${value.toFixed(2)} 页，高于上限，超出 ${assessment.difference.toFixed(2)} 页，实际分页尚未核验。`,
        artifact: 'chapters/writing-plan.json',
      }]
    })
  } catch (error) {
    return [{
      code: 'DOCX_EXPORT_PAGE_ESTIMATE_UNAVAILABLE',
      message: `Word 已生成，但当前正文篇幅无法估算，实际分页尚未核验：${error instanceof Error ? error.message : String(error)}`,
      artifact: 'chapters/writing-plan.json',
    }]
  }
}
