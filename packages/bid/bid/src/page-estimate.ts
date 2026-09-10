/** Lightweight deterministic page estimates over the Markdown that Word will export. */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { FormatValues } from './docx-format-contract.ts'
import { readDocxFormat } from './docx-format-store.ts'
import { collectDocxChapterBody } from './docx-content.ts'
import { docxImageDimensions } from './docx-render.ts'
import type { BidWorkspace } from './index.ts'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'
import { buildOutlineView } from './outline-confirmation-browser.ts'
import { buildWritableSectionWorklist } from './section-evidence-context.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  identifier?: string
  depth?: number
  ordered?: boolean | null
  start?: number | null
  children?: MarkdownNode[]
}

/** A section's already-normalized own export content, without its outline heading. */
export interface PageEstimateSection {
  readonly section_id: string
  readonly parent_id: string | null
  readonly number: string
  readonly depth: number
  readonly title: string
  readonly markdown: string
  readonly writable: boolean
}

/** Result used by the Host view without exposing filesystem details. */
export interface PageEstimateResult {
  readonly total: number
  readonly sections: ReadonlyMap<string, { readonly pages: number; readonly incomplete: boolean; readonly hasContent: boolean }>
}

/** 当前 S5 正文、确认目录与实际 Word 配置共同形成的测算快照。 */
export interface ChapterWritingPageEstimate extends PageEstimateResult {
  readonly format: {
    readonly revision: number
    readonly source: 'default' | 'template'
    readonly template_hash: string | null
  }
}

type CacheEntry = {
  key: string
  result: PageEstimateResult
  assets: readonly { path: string; mtimeMs: number; size: number }[]
}

const cache = new Map<string, CacheEntry>()
const cacheGenerations = new Map<string, number>()
const pointsPerMm = 72 / 25.4

function value(values: FormatValues, key: string): number { return Number(values[key]) }
function text(node: MarkdownNode): string { return node.value ?? (node.children ?? []).map(text).join('') }
function roleFor(node: MarkdownNode, first: boolean): string {
  if (node.type === 'heading') return node.depth === 1 && first ? 'title' : `heading${node.depth ?? 1}`
  const source = text(node)
  return /^图\s*\d/u.test(source) ? 'figureCaption' : /^表\s*\d/u.test(source) ? 'tableCaption' : 'body'
}
function pageSize(values: FormatValues): { width: number; height: number } {
  const paper: [number, number] = values['page.paper'] === 'A3'
    ? [297, 420]
    : values['page.paper'] === 'Letter' ? [215.9, 279.4] : [210, 297]
  return values['page.orientation'] === 'landscape'
    ? { width: paper[1], height: paper[0] }
    : { width: paper[0], height: paper[1] }
}
function lineHeight(values: FormatValues, role: string): number {
  const size = value(values, `${role}.size`)
  return values[`${role}.lineRule`] === 'auto' ? size * value(values, `${role}.line`) : value(values, `${role}.line`)
}
function characterWidth(source: string): number {
  return Array.from(source).reduce((width, character) => width + (/^[\x00-\x7f]$/u.test(character) ? 0.52 : 1), 0)
}
function paragraphHeight(values: FormatValues, role: string, source: string, width: number, indent = 0): number {
  const size = value(values, `${role}.size`)
  const usable = Math.max(18, width - indent)
  const lines = Math.max(1, Math.ceil(characterWidth(source) / Math.max(1, usable / Math.max(size * 0.95, 1))))
  return value(values, `${role}.before`) + value(values, `${role}.after`) + lines * lineHeight(values, role)
}
async function imageHeight(
  workspace: BidWorkspace,
  url: string,
  assets: Array<{ path: string; mtimeMs: number; size: number }>,
): Promise<number> {
  if (/^[a-z][a-z\d+.-]*:|^\/\//iu.test(url)) throw new Error('正文图片必须保存到项目内，不自动访问外部资源。')
  const path = within(workspace.projectRoot, decodeURIComponent(url))
  await assertNoLinkedPath(workspace.root, path)
  const info = await stat(path)
  if (!info.isFile()) throw new Error('正文图片必须为普通文件。')
  assets.push({ path, mtimeMs: info.mtimeMs, size: info.size })
  const { width, height } = docxImageDimensions(await readFile(path))
  const ratio = Math.min(1, 500 / width, 700 / height)
  return height * ratio * 0.75
}

async function markdownHeight(
  workspace: BidWorkspace,
  markdown: string,
  values: FormatValues,
  width: number,
  assets: Array<{ path: string; mtimeMs: number; size: number }>,
  firstHeadingIsTitle = false,
): Promise<number> {
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MarkdownNode
  const definitions = new Map((root.children ?? []).filter(node => node.type === 'definition').map(node => [node.identifier, node.url]))
  const imagesIn = (node: MarkdownNode): MarkdownNode[] => {
    const images: MarkdownNode[] = []
    const visit = (item: MarkdownNode): void => {
      if (item.type === 'image' || item.type === 'imageReference') images.push(item)
      for (const child of item.children ?? []) visit(child)
    }
    visit(node)
    return images
  }
  const blocks = async (nodes: readonly MarkdownNode[], level = 0): Promise<number> => {
    let height = 0
    for (const [index, node] of nodes.entries()) {
      if (node.type === 'definition') continue
      if (node.type === 'heading' || node.type === 'paragraph' || node.type === 'code') {
        const role = roleFor(node, index === 0 && firstHeadingIsTitle)
        if (values[`${role}.pageBreak`]) height += (pageSize(values).height - value(values, 'page.top') - value(values, 'page.bottom')) * pointsPerMm
        height += paragraphHeight(values, role, node.type === 'code' ? node.value ?? '' : text(node), width, level * 6 * pointsPerMm)
        for (const image of imagesIn(node)) height += await imageHeight(workspace, image.url ?? definitions.get(image.identifier) ?? '', assets)
        continue
      }
      if (node.type === 'list' || node.type === 'blockquote') {
        height += await blocks(node.children ?? [], level + 1)
        continue
      }
      if (node.type === 'listItem') {
        height += await blocks(node.children ?? [], level)
        continue
      }
      if (node.type === 'thematicBreak') { height += 12; continue }
      if (node.type === 'table') {
        const rows = node.children ?? []
        const columns = Math.max(1, ...rows.map(row => row.children?.length ?? 0))
        for (const [rowIndex, row] of rows.entries()) {
          const role = rowIndex === 0 ? 'tableHeader' : 'tableCell'
          const cellWidth = width / columns
          const cells = await Promise.all((row.children ?? []).map(async cell => paragraphHeight(values, role, text(cell), cellWidth)
            + (await Promise.all(imagesIn(cell).map(image => imageHeight(workspace, image.url ?? definitions.get(image.identifier) ?? '', assets)))).reduce((sum, image) => sum + image, 0)))
          height += Math.max(...cells, lineHeight(values, role))
        }
        continue
      }
      throw new Error(`正文不支持 ${node.type}。`)
    }
    return height
  }
  return blocks(root.children ?? [])
}

function pagesFromHeight(height: number, values: FormatValues): number {
  const page = pageSize(values)
  const usableHeight = (page.height - value(values, 'page.top') - value(values, 'page.bottom')) * pointsPerMm
  return height / Math.max(1, usableHeight)
}
function cacheKey(documentTitle: string, sections: readonly PageEstimateSection[], values: FormatValues): string {
  return createHash('sha256').update(JSON.stringify({ documentTitle, sections, values })).digest('hex')
}
async function cachedAssetsStillMatch(entry: CacheEntry): Promise<boolean> {
  return Promise.all(entry.assets.map(async (asset) => {
    const current = await stat(asset.path).catch(() => undefined)
    return current?.isFile() === true && current.mtimeMs === asset.mtimeMs && current.size === asset.size
  })).then(checks => checks.every(Boolean))
}

/**
 * Estimate actual generated export content in document order.  It never rounds a block or leaf section.
 * @param workspace Project whose local images may be read.
 * @param documentTitle The export document title.
 * @param sections Confirmed outline sections in document order.
 * @param values The same resolved Word values used by DOCX rendering.
 * @returns Whole-document and non-leaf subtree estimates before display rounding.
 */
export async function estimateReviewPages(
  workspace: BidWorkspace,
  documentTitle: string,
  sections: readonly PageEstimateSection[],
  values: FormatValues,
): Promise<PageEstimateResult> {
  const key = cacheKey(documentTitle, sections, values)
  const previous = cache.get(workspace.projectRoot)
  if (previous?.key === key && await cachedAssetsStillMatch(previous)) return previous.result
  const generation = (cacheGenerations.get(workspace.projectRoot) ?? 0) + 1
  cacheGenerations.set(workspace.projectRoot, generation)
  const page = pageSize(values)
  const width = (page.width - value(values, 'page.left') - value(values, 'page.right')) * pointsPerMm
  const byParent = new Map<string | null, PageEstimateSection[]>()
  for (const section of sections) byParent.set(section.parent_id, [...(byParent.get(section.parent_id) ?? []), section])
  const own = new Map<string, number>()
  const assets: Array<{ path: string; mtimeMs: number; size: number }> = []
  for (const section of sections) own.set(section.section_id, section.markdown.trim() === '' ? 0 : await markdownHeight(workspace, section.markdown, values, width, assets))
  const active = new Map<string, boolean>()
  const visit = (section: PageEstimateSection): boolean => {
    const hasContent = (own.get(section.section_id) ?? 0) > 0 || (byParent.get(section.section_id) ?? []).some(visit)
    active.set(section.section_id, hasContent)
    return hasContent
  }
  for (const root of byParent.get(null) ?? []) visit(root)
  const heading = new Map<string, number>()
  for (const section of sections) {
    heading.set(section.section_id, active.get(section.section_id) ? await markdownHeight(workspace,
      `${'#'.repeat(Math.min(6, section.depth))} ${section.number} ${section.title}`, values, width, assets) : 0)
  }
  const leavesReady = new Map<string, boolean>()
  for (const section of sections) {
    if ((byParent.get(section.section_id)?.length ?? 0) === 0 && section.writable) {
      leavesReady.set(section.section_id, (own.get(section.section_id) ?? 0) > 0)
    }
  }
  const aggregates = new Map<string, { height: number; complete: boolean; content: boolean }>()
  const subtree = (section: PageEstimateSection): { height: number; complete: boolean; content: boolean } => {
    const known = aggregates.get(section.section_id)
    if (known !== undefined) return known
    const children = (byParent.get(section.section_id) ?? []).map(subtree)
    const branch = {
      height: (heading.get(section.section_id) ?? 0) + (own.get(section.section_id) ?? 0)
        + children.reduce((sum, child) => sum + child.height, 0),
      complete: (leavesReady.get(section.section_id) ?? true) && children.every(child => child.complete),
      content: active.get(section.section_id) === true,
    }
    aggregates.set(section.section_id, branch)
    return branch
  }
  const resultSections = new Map<string, { pages: number; incomplete: boolean; hasContent: boolean }>()
  for (const section of sections) {
    const branch = subtree(section)
    resultSections.set(section.section_id, {
      pages: pagesFromHeight(branch.height, values), incomplete: !branch.complete, hasContent: branch.content,
    })
  }
  const roots = (byParent.get(null) ?? []).map(subtree)
  const totalContent = roots.some(branch => branch.content)
  const titleHeight = totalContent ? await markdownHeight(workspace, `# ${documentTitle}`, values, width, assets, true) : 0
  const result: PageEstimateResult = {
    total: pagesFromHeight(titleHeight + roots.reduce((sum, branch) => sum + branch.height, 0), values),
    sections: resultSections,
  }
  if (cacheGenerations.get(workspace.projectRoot) === generation) cache.set(workspace.projectRoot, { key, result, assets })
  return result
}

/**
 * 按正式导出顺序测算当前 S5 正文；缺失章节保持为空，不把预算计作正文。
 * @param workspace 当前 Bid 项目。
 * @param outline 当前确认目录。
 * @returns 未取整总页数、分支页数及实际格式身份。
 */
export async function estimateChapterWritingPages(
  workspace: BidWorkspace,
  outline: OutlineArtifact,
): Promise<ChapterWritingPageEstimate> {
  const positions = new Map(buildOutlineView(outline.sections).map(item => [item.section.id, item]))
  const paths = new Map(buildWritableSectionWorklist(outline).map((section, index) => (
    [section.id, `chapters/sections/${String(index + 1).padStart(4, '0')}.md`] as const
  )))
  const sections: PageEstimateSection[] = await Promise.all(outline.sections.map(async (section) => {
    const position = positions.get(section.id)
    if (position === undefined) throw new Error(`目录章节缺少导出位置：${section.id}`)
    let markdown = section.writable ? '' : section.summary ?? ''
    const path = paths.get(section.id)
    if (path !== undefined) {
      const absolute = within(workspace.projectRoot, path)
      await assertNoLinkedPath(workspace.root, absolute)
      try { markdown = await readFile(absolute, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (markdown.trim() !== '') {
        markdown = collectDocxChapterBody(
          markdown, section.title, section.id, position.number, Math.min(6, position.depth),
        )
      }
    }
    return {
      section_id: section.id,
      parent_id: section.parent_id,
      number: position.number,
      depth: position.depth,
      title: section.title,
      writable: section.writable,
      markdown,
    }
  }))
  const format = await readDocxFormat(workspace)
  const estimate = await estimateReviewPages(workspace, outline.document_title, sections, format.values)
  return {
    ...estimate,
    format: {
      revision: format.state.revision,
      source: format.state.template ? 'template' : 'default',
      template_hash: format.state.template?.hash ?? null,
    },
  }
}

/**
 * Measure one in-memory Writer candidate with the same format and body normalization as export.
 * @param workspace Current Bid workspace.
 * @param outline Current confirmed outline.
 * @param sectionId Writable section receiving the candidate.
 * @param markdown Unpersisted Writer candidate.
 * @returns Page estimate and effective format identity.
 */
export async function estimateChapterCandidatePages(
  workspace: BidWorkspace,
  outline: OutlineArtifact,
  sectionId: string,
  markdown: string,
): Promise<ChapterWritingPageEstimate> {
  const position = buildOutlineView(outline.sections).find(item => item.section.id === sectionId)
  if (position === undefined || !position.section.writable) throw new Error(`目录中缺少可写章节：${sectionId}`)
  const section: PageEstimateSection = {
    section_id: sectionId,
    parent_id: null,
    number: position.number,
    depth: position.depth,
    title: position.section.title,
    writable: true,
    markdown: collectDocxChapterBody(markdown, position.section.title, sectionId, position.number, Math.min(6, position.depth)),
  }
  const format = await readDocxFormat(workspace)
  const estimate = await estimateReviewPages(workspace, outline.document_title, [section], format.values)
  return {
    ...estimate,
    format: {
      revision: format.state.revision,
      source: format.state.template ? 'template' : 'default',
      template_hash: format.state.template?.hash ?? null,
    },
  }
}

/** Clear estimates for focused tests or a disposed Host. */
export function clearPageEstimateCache(): void { cache.clear(); cacheGenerations.clear() }
