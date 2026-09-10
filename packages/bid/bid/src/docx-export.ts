/** S6 按确认目录组合已完成章节；项目锁和阶段 checkpoint 由 Host 持有。 */
import { readFile } from 'node:fs/promises'
import { posix, sep } from 'node:path'
import { readDocxXml } from './docx-template.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { collectDocxChapterBody } from './docx-content.ts'
import { parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { BidStageExecutionError, type BidStage, type StageArtifact, type StageValidationResult } from './control-plane-contract.ts'
import type { BidWorkspace } from './index.ts'
import { outlineArtifactSha256, parseConfirmedOutlineArtifact } from './outline-confirmation-artifacts.ts'
import { buildOutlineView } from './outline-confirmation-browser.ts'
import { buildWritableSectionWorklist } from './section-evidence-context.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { estimateChapterWritingPages } from './page-estimate.ts'
import { assessPageTarget, parseWritingPlan } from './writing-requirements.ts'

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
 * @returns 项目输出目录中的 DOCX 产物引用。
 */
export async function executeDocxExport(
  workspace: BidWorkspace,
  signal?: AbortSignal,
  destination = posix.join(workspace.config.outputDirectory, 'bid.docx'),
): Promise<StageArtifact[]> {
  const markdown = await collectDocxMarkdown(workspace, signal)
  if (!destination.endsWith('.docx')) throw new Error('bid-output-must-be-docx')
  const source = destination.slice(0, -'.docx'.length) + '.md'
  const absolute = within(workspace.projectRoot, source)
  await assertNoLinkedPath(workspace.root, absolute)
  signal?.throwIfAborted()
  await writeFileAtomic(absolute, markdown, { mode: 0o600, dirMode: 0o700 })
  await workspace.exportDocx(source, destination)
  return [{ stage: 'docx_export', type: 'docx', path: destination }]
}

/** 读取确认目录和全部章节为固定 Markdown 快照；不修改源章节。
 * @param workspace 当前项目。
 * @param signal 取消信号。
 * @returns 完整文档 Markdown。
 */
export async function collectDocxMarkdown(workspace: BidWorkspace, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const outline = parseConfirmedOutlineArtifact(JSON.parse(await readProjectFile(workspace, 'outline/confirmed-outline.json')))
  const manifest = parseChapterWritingManifest(JSON.parse(await readProjectFile(workspace, 'chapters/manifest.json')))
  if (manifest.confirmed_outline_sha256 !== outlineArtifactSha256(outline)) {
    throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_OUTLINE_MISMATCH', message: '章节记录与当前确认目录不匹配。', artifact: 'chapters/manifest.json' }])
  }
  const worklist = buildWritableSectionWorklist(outline)
  const chapters = new Map(manifest.chapters.map(chapter => [chapter.section_id, chapter]))
  if (chapters.size !== manifest.chapters.length || chapters.size !== worklist.length
    || worklist.some((section, index) => chapters.get(section.id)?.content_path !== `chapters/sections/${String(index + 1).padStart(4, '0')}.md`)) {
    throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_CHAPTER_SET_INVALID', message: '章节记录必须完整对应确认目录中的可写章节及正文路径。', artifact: 'chapters/manifest.json' }])
  }
  const parts = [`# ${outline.document_title}`]
  for (const { section, number, depth } of buildOutlineView(outline.sections)) {
    signal?.throwIfAborted()
    const headingDepth = Math.min(6, depth)
    parts.push(`${'#'.repeat(headingDepth)} ${number} ${section.title}`)
    if (!section.writable && section.summary !== undefined) parts.push(section.summary)
    const chapter = chapters.get(section.id)
    if (chapter === undefined) continue
    const markdown = await readProjectFile(workspace, chapter.content_path)
    if (markdown.trim().length === 0) throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_CONTENT_EMPTY', message: '章节正文为空，不能导出。', artifact: chapter.content_path }])
    parts.push(collectDocxChapterBody(markdown, section.title, section.id, number, headingDepth))
  }
  return `${parts.join('\n\n')}\n`
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
  try {
    const outline = parseConfirmedOutlineArtifact(JSON.parse(await readProjectFile(workspace, 'outline/confirmed-outline.json')))
    let writingPlan: ReturnType<typeof parseWritingPlan>
    try {
      writingPlan = parseWritingPlan(JSON.parse(await readProjectFile(workspace, 'chapters/writing-plan.json')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true }
      throw error
    }
    if (writingPlan.confirmed_outline_sha256 !== outlineArtifactSha256(outline)) {
      throw new Error('写作计划与当前确认目录不一致。')
    }
    const estimate = await estimateChapterWritingPages(workspace, outline)
    const assessment = assessPageTarget(writingPlan.page_target, estimate.total)
    if (assessment.status === 'below' || assessment.status === 'above') {
      return { ok: false, issues: [{
        code: assessment.status === 'below' ? 'DOCX_EXPORT_PAGE_TARGET_BELOW' : 'DOCX_EXPORT_PAGE_TARGET_ABOVE',
        message: assessment.status === 'below'
          ? `当前格式下正文估算 ${estimate.total.toFixed(2)} 页，低于已确认下限，尚差 ${assessment.difference.toFixed(2)} 页。`
          : `当前格式下正文估算 ${estimate.total.toFixed(2)} 页，高于已确认上限，超出 ${Math.abs(assessment.difference).toFixed(2)} 页。`,
        artifact: 'chapters/writing-plan.json',
      }] }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, issues: [{
      code: 'DOCX_EXPORT_PAGE_ESTIMATE_UNAVAILABLE',
      message: `导出文件可读取，但当前正文篇幅无法核验：${error instanceof Error ? error.message : String(error)}`,
      artifact: 'chapters/writing-plan.json',
    }] }
  }
}
