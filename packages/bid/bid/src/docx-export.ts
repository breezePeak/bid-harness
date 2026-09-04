/** S6 按确认目录组合已完成章节；项目锁和阶段 checkpoint 由 Host 持有。 */
import { readFile } from 'node:fs/promises'
import { posix, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { BidStageExecutionError, type BidStage, type StageArtifact, type StageValidationResult } from './control-plane-contract.ts'
import type { BidWorkspace } from './index.ts'
import { outlineArtifactSha256, parseConfirmedOutlineArtifact } from './outline-confirmation-artifacts.ts'
import { buildOutlineView } from './outline-confirmation-browser.ts'
import { buildWritableSectionWorklist } from './section-evidence-context.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

async function readProjectFile(workspace: BidWorkspace, path: string): Promise<string> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  return readFile(absolute, 'utf8')
}

/** Markdown 标题只在当前章节内分级，代码块中的井号保持原文。 */
function chapterBody(markdown: string, title: string, sectionId: string, depth: number): string {
  const nodes = fromMarkdown(markdown).children
  for (const node of [...nodes].reverse()) {
    if (node.type !== 'heading') continue
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) throw new Error('Markdown 标题缺少源码位置。')
    const first = node.children[0]?.position?.start.offset
    const last = node.children.at(-1)?.position?.end.offset
    const inline = first === undefined || last === undefined ? '' : markdown.slice(first, last)
    const text = node === nodes[0] && (inline === title || inline === sectionId)
      ? '' : `${'#'.repeat(Math.min(6, depth + node.depth))} ${inline}`
    markdown = markdown.slice(0, start) + text + markdown.slice(end)
  }
  return markdown.trim()
}

/**
 * 仅导出与当前确认目录匹配且覆盖全部可写章节的项目正文。
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
    const headingDepth = Math.min(6, depth + 1)
    parts.push(`${'#'.repeat(headingDepth)} ${number} ${section.title}`)
    const chapter = chapters.get(section.id)
    if (chapter === undefined) continue
    const markdown = await readProjectFile(workspace, chapter.content_path)
    if (markdown.trim().length === 0) throw new BidStageExecutionError([{ code: 'DOCX_EXPORT_CONTENT_EMPTY', message: '章节正文为空，不能导出。', artifact: chapter.content_path }])
    parts.push(chapterBody(markdown, section.title, section.id, headingDepth))
  }
  if (!destination.endsWith('.docx')) throw new Error('bid-output-must-be-docx')
  const source = destination.slice(0, -'.docx'.length) + '.md'
  const absolute = within(workspace.projectRoot, source)
  await assertNoLinkedPath(workspace.root, absolute)
  signal?.throwIfAborted()
  await writeFileAtomic(absolute, `${parts.join('\n\n')}\n`, { mode: 0o600, dirMode: 0o700 })
  await workspace.exportDocx(source, destination)
  return [{ stage: 'docx_export', type: 'docx', path: destination }]
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
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('invalid-docx-file')
    return { ok: true }
  } catch {
    return { ok: false, issues: [{ code: 'DOCX_EXPORT_ARTIFACT_INVALID', message: '导出目录中缺少有效的 DOCX 产物。', artifact: path }] }
  }
}
