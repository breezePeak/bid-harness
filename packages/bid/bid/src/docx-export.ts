/** 按确认目录导出已保存正文；导出不依赖执行记录、审核结果或章节 Manifest。 */
import { readFile } from 'node:fs/promises'
import { posix, sep } from 'node:path'
import { readDocxXml } from './docx-template.ts'
import { collectDocxChapterBody } from './docx-content.ts'
import { BidStageExecutionError, type BidStage, type StageArtifact, type StageValidationIssue, type StageValidationResult } from './control-plane-contract.ts'
import type { BidWorkspace } from './index.ts'
import { outlineArtifactSha256, parseConfirmedOutlineArtifact } from './outline-confirmation-artifacts.ts'
import { TECHNICAL_DEVIATION_SECTION_ID } from './outline-generation-artifacts.ts'
import { buildOutlineView } from './outline-confirmation-browser.ts'
import { buildWritableSectionWorklist } from './section-evidence-context.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { estimateChapterWritingPages } from './page-estimate.ts'
import { parseWritingPlan } from './writing-requirements.ts'
import { assessBoundedMetric } from './acceptance-criteria.ts'
import type { DocxTemplateId } from './docx-format-contract.ts'
import { readDocxFormat } from './docx-format-store.ts'
import { captionRole } from './docx-numbering.ts'
import type { BidRunContext } from './run-coordinator.ts'
import { parseChapterMetadata } from './chapter-writing-artifacts.ts'
import { resolveFlowchartAnchors, validateFlowchartAnchors, validateFlowchartSpec, type FlowchartSpec } from './flowchart.ts'
import type { NativeVisioExport } from './native-visio.ts'
import { parseTechnicalDeviationTable, type TechnicalDeviationTable } from './technical-deviation-table.ts'
import type { VisualReviewModel } from './docx-visual-review.ts'

/** 同一次正文读取产生的 DOCX Markdown 与固定技术偏离表数据。 */
export interface DocxExportSnapshot {
  readonly markdown: string
  readonly technicalDeviation:
    | { status: 'ready'; table: TechnicalDeviationTable; artifact: string }
    | { status: 'pending'; artifact: string; issue: StageValidationIssue }
    | { status: 'absent' }
}

async function readProjectFile(workspace: BidWorkspace, path: string): Promise<string> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  return readFile(absolute, 'utf8')
}

async function readSavedChapter(workspace: BidWorkspace, path: string): Promise<string> {
  try { return await readProjectFile(workspace, path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function readSavedFlowcharts(workspace: BidWorkspace, serial: string): Promise<readonly FlowchartSpec[]> {
  try {
    const metadata = parseChapterMetadata(JSON.parse(await readProjectFile(workspace, `chapters/meta/${serial}.json`)))
    for (const flowchart of metadata.flowcharts) {
      const issues = validateFlowchartSpec(flowchart)
      if (issues.length > 0) throw new Error(`流程图无法导出：${issues.join('；')}`)
    }
    return metadata.flowcharts
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export { collectDocxChapterBody } from './docx-content.ts'

/**
 * 按完整确认目录导出父节点概述和已保存叶节正文；缺失正文保留标题并标注。
 * @param workspace 已由 Host 锁定的项目。
 * @param run 本次阶段的唯一执行与正式提交权限。
 * @param destination 项目内输出路径；省略时写入固定交付文件。
 * @param templateId 本次导出模板；省略时使用 S5 页数基准，null 使用系统默认模板。
 * @param nativeExport 可选的 Visio/Word 能力注入；省略时使用当前 Windows COM 实现。
 * @param visualReviewer 可选的最终 Word 页面视觉审核端。
 * @returns 项目输出目录中的 DOCX 产物引用。
 */
export async function executeDocxExport(
  workspace: BidWorkspace,
  run: BidRunContext,
  destination = posix.join(workspace.config.outputDirectory, 'bid.docx'),
  templateId?: DocxTemplateId | null,
  nativeExport?: NativeVisioExport,
  visualReviewer?: VisualReviewModel,
): Promise<StageArtifact[]> {
  run.reportProgress({ phase: 'collecting', summary: '正在收集确认目录、正文与图表' })
  const snapshot = await collectDocxExportSnapshot(workspace, run.signal, templateId)
  if (snapshot.technicalDeviation.status === 'pending') {
    throw new BidStageExecutionError([{
      ...snapshot.technicalDeviation.issue,
      message: '第一章“技术偏离表”正文缺失或结构不完整，请先修复该章节后重新导出 Word。',
    }])
  }
  if (!destination.endsWith('.docx')) throw new Error('bid-output-must-be-docx')
  const source = destination.slice(0, -'.docx'.length) + '.md'
  const absolute = within(workspace.projectRoot, source)
  await assertNoLinkedPath(workspace.root, absolute)
  run.signal.throwIfAborted()
  run.reportProgress({ phase: 'exporting', summary: '正在生成并渲染 Word 文档' })
  await run.commits.writeText(absolute, snapshot.markdown)
  await workspace.exportDocxMarkdown(snapshot.markdown, destination, templateId, run.commits, undefined, nativeExport,
    snapshot.technicalDeviation.status === 'ready'
      ? { mode: 'fill', table: snapshot.technicalDeviation.table }
      : undefined,
    visualReviewer,
    run.signal)
  run.reportProgress({ phase: 'finalizing', summary: 'Word 文档已生成，正在提交导出结果' })
  return [{ stage: 'docx_export', type: 'docx', path: destination }]
}

/** 读取确认目录和已保存正文为固定 Markdown 快照；读取期间目录或正文变化时拒绝导出。
 * @param workspace 当前项目。
 * @param signal 取消信号。
 * @param templateId 本次导出模板；用于识别与 Word 相同的显式图题编号。
 * @returns 当前导出范围的文档 Markdown。
 */
export async function collectDocxMarkdown(
  workspace: BidWorkspace,
  signal?: AbortSignal,
  templateId?: DocxTemplateId | null,
): Promise<string> {
  return (await collectDocxExportSnapshot(workspace, signal, templateId)).markdown
}

/**
 * 从同一次章节读取生成 Markdown 与固定技术偏离表结构；二次读取通过后才返回。
 * @param workspace 当前项目。
 * @param signal 取消信号。
 * @param templateId 本次导出模板；用于识别与 Word 相同的显式图题编号。
 * @returns 一致的导出快照。
 */
export async function collectDocxExportSnapshot(
  workspace: BidWorkspace,
  signal?: AbortSignal,
  templateId?: DocxTemplateId | null,
): Promise<DocxExportSnapshot> {
  signal?.throwIfAborted()
  const outlinePath = 'outline/confirmed-outline.json'
  const outlineSource = await readProjectFile(workspace, outlinePath)
  const outline = parseConfirmedOutlineArtifact(JSON.parse(outlineSource))
  const worklist = buildWritableSectionWorklist(outline)
  const chapters = new Map<string, { content_path: string; markdown: string }>()
  for (const [index, section] of worklist.entries()) {
    signal?.throwIfAborted()
    const content_path = `chapters/sections/${String(index + 1).padStart(4, '0')}.md`
    chapters.set(section.id, { content_path, markdown: await readSavedChapter(workspace, content_path) })
  }
  const technicalChapter = chapters.get(TECHNICAL_DEVIATION_SECTION_ID)
  let technicalDeviation: DocxExportSnapshot['technicalDeviation'] = { status: 'absent' }
  if (technicalChapter !== undefined) {
    try {
      technicalDeviation = {
        status: 'ready',
        table: parseTechnicalDeviationTable(technicalChapter.markdown),
        artifact: technicalChapter.content_path,
      }
    } catch {
      const issue = {
        code: 'DOCX_EXPORT_TECHNICAL_DEVIATION_INVALID',
        message: '第一章“技术偏离表”正文缺失或结构不完整，请先修复该章节。',
        artifact: technicalChapter.content_path,
      }
      technicalDeviation = { status: 'pending', artifact: technicalChapter.content_path, issue }
    }
  }
  if (!outline.sections.some(section => section.writable ? chapters.get(section.id)?.markdown.trim() : section.summary?.trim())) {
    throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_NO_SAVED_CHAPTERS', message: '当前还没有已保存的正文。' }])
  }
  const flowchartsBySection = new Map<string, readonly FlowchartSpec[]>()
  const figureNumbers = new Map<string, number>()
  let figureNumber = 0
  const format = await readDocxFormat(workspace, templateId)
  for (const [sectionId, chapter] of chapters) {
    const flowcharts = await readSavedFlowcharts(workspace, chapter.content_path.slice(-7, -3))
    flowchartsBySection.set(sectionId, flowcharts)
    const anchorIssues = validateFlowchartAnchors(chapter.markdown, flowcharts)
    if (anchorIssues.length > 0) throw new Error(`流程图 anchor 无效：${anchorIssues.join('；')}`)
    const ordered = [...flowcharts].sort((left, right) => {
      const leftKey = left.key?.trim() || left.id
      const rightKey = right.key?.trim() || right.id
      return chapter.markdown.indexOf(`{{flowchart:${leftKey}}}`) - chapter.markdown.indexOf(`{{flowchart:${rightKey}}}`)
    })
    let cursor = 0
    for (const flowchart of ordered) {
      const key = flowchart.key?.trim() || flowchart.id
      if (figureNumbers.has(key)) throw new Error(`FLOWCHART_KEY_DUPLICATE:${key}`)
      const marker = `{{flowchart:${key}}}`
      const position = chapter.markdown.indexOf(marker, cursor)
      if (position < 0) throw new Error(`FLOWCHART_ANCHOR_MISSING:${key}`)
      figureNumber += chapter.markdown.slice(cursor, position).split(/\r?\n/gu)
        .filter(line => captionRole(format.state.resolved, line) === 'figureCaption').length
      figureNumbers.set(key, ++figureNumber)
      cursor = position + marker.length
    }
  }
  for (const [sectionId, chapter] of chapters) {
    if (chapter.markdown !== await readSavedChapter(workspace, chapter.content_path)) {
      throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_SNAPSHOT_CHANGED', message: `章节 ${sectionId} 在导出快照期间发生变化，请重新导出。`, artifact: chapter.content_path }])
    }
  }
  if (outlineSource !== await readProjectFile(workspace, outlinePath)) {
    throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_SNAPSHOT_CHANGED', message: '确认目录在导出快照期间发生变化，请重新导出。', artifact: outlinePath }])
  }
  const parts = [`# ${outline.document_title}`]
  for (const { section, number, depth } of buildOutlineView(outline.sections)) {
    signal?.throwIfAborted()
    const headingDepth = Math.min(6, depth)
    parts.push(`${'#'.repeat(headingDepth)} ${number} ${section.title}`)
    if (!section.writable && section.summary !== undefined) parts.push(section.summary)
    const chapter = chapters.get(section.id)
    if (chapter === undefined || chapter.markdown.trim().length === 0) {
      if (section.writable) parts.push('（本节尚无已保存正文。）')
      continue
    }
    const flowcharts = flowchartsBySection.get(section.id) ?? []
    parts.push(resolveFlowchartAnchors(
      collectDocxChapterBody(chapter.markdown, section.title, section.id, number, headingDepth),
      flowcharts,
      figureNumbers,
    ))
  }
  return { markdown: `${parts.join('\n\n')}\n`, technicalDeviation }
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
 * 独立核验已生成 DOCX 对应的页数目标，不改变文件有效性。
 * @param workspace 已导出规范章节 Markdown 的当前项目。
 * @param templateId 本次导出模板；省略时使用 S5 页数基准。
 * @returns 未满足或无法测算页数目标时的警告。
 */
export async function assessDocxExportPageTarget(
  workspace: BidWorkspace,
  templateId?: DocxTemplateId | null,
): Promise<StageValidationIssue[]> {
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
    const estimate = await estimateChapterWritingPages(workspace, outline, {
      method: 'rendered',
      ...(templateId === undefined ? {} : { templateId }),
    })
    const measured = [
      ...documentCriteria.map(criterion => ({ criterion, value: estimate.total, method: estimate.method })),
      ...sectionCriteria.flatMap(({ section_id, criterion }) => {
        const value = estimate.sections.get(section_id)?.pages
        return value === undefined ? [] : [{ criterion, value, method: 'fast' as const }]
      }),
    ]
    return measured.flatMap(({ criterion, value, method }): StageValidationIssue[] => {
      if (criterion.evaluator.kind !== 'deterministic') return []
      const assessment = assessBoundedMetric(criterion.evaluator.min, criterion.evaluator.max, value)
      if (assessment.status === 'met') return []
      return [{
        code: assessment.status === 'below' ? 'DOCX_EXPORT_PAGE_TARGET_BELOW' : 'DOCX_EXPORT_PAGE_TARGET_ABOVE',
        message: assessment.status === 'below'
          ? `Word 已生成；${criterion.id} 按${method === 'rendered' ? '渲染分页' : '快速算法'}统计 ${value.toFixed(2)} 页，低于下限，尚差 ${assessment.difference.toFixed(2)} 页。`
          : `Word 已生成；${criterion.id} 按${method === 'rendered' ? '渲染分页' : '快速算法'}统计 ${value.toFixed(2)} 页，高于上限，超出 ${assessment.difference.toFixed(2)} 页。`,
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
