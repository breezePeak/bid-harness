/** S5 插图的项目风格、受控资产、位置选择与真实图片确认。 */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ToolArgsError, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import type { BidCommitScope } from './run-coordinator.ts'
import { chapterToolArgs, createChapterProtocol, type ChapterProtocol } from './chapter-writing-protocol.ts'
import type { BidImageConnectionSpec, BidImageProvider } from './bid-image-provider.ts'
import { DOCX_MAX_BODY_IMAGE_BYTES, docxImageDimensions } from './docx-image.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'
import { generateTrackedBidImage } from './bid-image-request.ts'
import { BidImageId } from './control-plane-contract.ts'

const text = z.string().trim().min(1).max(8000)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
/** 项目内生成图片的完整身份；模型只选择位置。 */
export const bidChapterImageSchema = z.object({
  id: z.string().regex(/^IMG-[a-f0-9]{64}$/u).transform(BidImageId), section_id: text,
  path: z.string().regex(/^assets\/images\/[a-f0-9]{64}\.png$/u),
  content_sha256: sha256, request_sha256: sha256,
  width: z.number().int().positive(), height: z.number().int().positive(),
  title: z.string().trim().min(1).max(200), purpose: text, prompt: text,
  style_sha256: sha256, model: text,
  visual_status: z.enum(['pending', 'accepted', 'rejected']), visual_reason: text.optional(),
}).strict()

/** 一章已发放的图片位置记录；位置追加后不重用。 */
export type BidChapterImage = z.infer<typeof bidChapterImageSchema>

const referenceSchema = bidChapterImageSchema.pick({
  id: true, path: true, content_sha256: true, request_sha256: true, width: true, height: true,
})
const styleSchema = z.object({
  schema_version: z.literal(2), prompt: text, sha256,
  model: z.string().trim().min(1).max(200), reference_image: referenceSchema.optional(),
}).strict()

/** 项目冻结的视觉描述、模型及已确认参考图。 */
export type BidImageStyle = z.infer<typeof styleSchema>

/** S5 重置时仍保留的项目风格文件。 */
export const BID_IMAGE_STYLE_PATH = 'assets/image-style.json'

const ledgerSchema = z.object({ schema_version: z.literal(1), section_id: text,
  images: z.array(bidChapterImageSchema).max(100) }).strict()

interface MarkdownNode {
  type: string
  children?: readonly MarkdownNode[] | undefined
  alt?: string | null | undefined
  url?: string | undefined
  identifier?: string | undefined
  position?: {
    start: { offset?: number | undefined }
    end: { offset?: number | undefined }
  } | undefined
}

function markdownImages(markdown: string): Array<{ url: string; node: MarkdownNode }> {
  const root = fromMarkdown(markdown)
  const definitions = new Map<string, string>()
  const collectDefinitions = (node: MarkdownNode): void => {
    if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined) definitions.set(node.identifier, node.url)
    for (const child of node.children ?? []) collectDefinitions(child)
  }
  collectDefinitions(root)
  const images: Array<{ url: string; node: MarkdownNode }> = []
  const collectImages = (node: MarkdownNode): void => {
    if (node.type === 'image' || node.type === 'imageReference') {
      const url = node.url ?? definitions.get(node.identifier ?? '') ?? ''
      images.push({ url, node })
    }
    for (const child of node.children ?? []) collectImages(child)
  }
  collectImages(root)
  return images
}

function markdownImageUrls(markdown: string): string[] { return [...new Set(markdownImages(markdown).map(image => image.url))] }

function captionText(caption: string): string { return caption.replace(/[!-/:-@[-`{-~]/gu, '\\$&') }

/**
 * 按已授权图片资产展开正文位置，图题仅影响替代文字与普通文本段落。
 * @param image Host 已绑定的图片记录。
 * @param caption 本次正文的语义图题，省略时使用资产标题。
 * @returns 不含模型指定路径或额外 Markdown 结构的图片与图题。
 */
export function chapterImageMarkdown(image: BidChapterImage, caption = image.title): string {
  return `![${captionText(caption)}](${image.path})\n\n图 ${captionText(caption)}`
}

function markdownImagePath(url: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:|^\/\//iu.test(url)) return undefined
  let decoded: string
  try { decoded = decodeURIComponent(url) } catch { return undefined }
  const path = posix.normalize(decoded.replaceAll('\\', '/'))
  return /^assets\/images\//iu.test(path) ? path.toLowerCase() : path
}

/**
 * 解析正文实际引用的生成图片，包含 reference 定义；代码中的图片文字不计作引用。
 * @param markdown 当前完整 Markdown 正文。
 * @returns 项目内生成图片的规范路径。
 */
export function chapterImagePaths(markdown: string): string[] {
  return [...new Set(markdownImageUrls(markdown).flatMap((url) => {
    const path = markdownImagePath(url)
    return path?.startsWith('assets/images/') === true ? [path] : []
  }))]
}

/**
 * 读取正文生成图片的实际替代文字，同一图片的多处展示须使用相同图题。
 * @param markdown 当前完整 Markdown 正文。
 * @returns 按规范图片路径绑定的图题；冲突时拒绝投影，避免丢失正文语义。
 */
export function chapterImageCaptions(markdown: string): ReadonlyMap<string, string> {
  const captions = new Map<string, string>()
  for (const { url, node } of markdownImages(markdown)) {
    const path = markdownImagePath(url)
    if (path?.startsWith('assets/images/') !== true) continue
    const caption = node.alt ?? ''
    if (captions.has(path) && captions.get(path) !== caption) throw new ToolArgsError([
      'markdown: 同一图片的多处展示须使用相同图题，不能将不同图题合并到一个图片位置。',
    ])
    captions.set(path, caption)
  }
  return captions
}

/**
 * 将正式图片引用投影为 Writer 位置锚点，只移除紧随图片且匹配实际替代文字的图题。
 * @param markdown 已绑定的完整正文。
 * @param positions 当前图片的程序位置表。
 * @returns 支持 inline/reference 图片的模型正文。
 */
export function projectChapterImageAnchors(markdown: string, positions: readonly { image: BidChapterImage; position: number }[]): string {
  const changes = markdownImages(markdown).flatMap(({ url, node }) => {
    const selected = positions.find(value => value.image.path === markdownImagePath(url))
    if (selected === undefined) return []
    const start = node.position?.start.offset
    let end = node.position?.end.offset
    if (start === undefined || end === undefined) throw new Error('BID_IMAGE_MARKDOWN_POSITION_INVALID')
    const caption = `\n\n图 ${captionText(node.alt ?? selected.image.title)}`
    if (markdown.slice(end).startsWith(caption)
      && /^(?:\r?\n[\t ]*\r?\n|[\r\n]*$)/u.test(markdown.slice(end + caption.length))) end += caption.length
    return [{ start, end, replacement: `{{image:${selected.position}}}` }]
  }).sort((left, right) => right.start - left.start)
  for (const change of changes) markdown = markdown.slice(0, change.start) + change.replacement + markdown.slice(change.end)
  return markdown
}

async function checkImageBudget(workspace: BidWorkspace, extra: ReadonlyMap<string, number>,
  replacement?: { path: string; markdown: string }): Promise<void> {
  const root = within(workspace.projectRoot, 'chapters/sections')
  await assertNoLinkedPath(workspace.root, root)
  let files: string[]
  try { files = await readdir(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    files = []
  }
  const urls = new Set<string>()
  for (const file of files.filter(file => /^\d{4}\.md$/u.test(file))) {
    const path = `chapters/sections/${file}`
    if (path === replacement?.path) continue
    const absolute = within(workspace.projectRoot, path)
    await assertNoLinkedPath(workspace.root, absolute)
    for (const url of markdownImageUrls(await readFile(absolute, 'utf8'))) urls.add(url)
  }
  for (const url of replacement === undefined ? [] : markdownImageUrls(replacement.markdown)) urls.add(url)
  for (const path of extra.keys()) urls.add(path)
  let total = 0
  for (const url of urls) {
    if (/^[a-z][a-z\d+.-]*:|^\/\//iu.test(url)) throw new ToolArgsError(['正文图片必须保存到项目内。'])
    const size = extra.get(url)
    if (size !== undefined) { total += size } else {
      const path = within(workspace.projectRoot, decodeURIComponent(url))
      await assertNoLinkedPath(workspace.root, path)
      const info = await lstat(path)
      if (!info.isFile()) throw new ToolArgsError(['正文图片必须是项目内普通文件。'])
      total += info.size
    }
    if (total > DOCX_MAX_BODY_IMAGE_BYTES) throw new ToolArgsError([
      '全书正文图片总大小不能超过 20 MiB。请换用更小图幅或减少配图、复用已生成图片，已有正文保持不变。',
    ])
  }
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 获取一章图片账本的确定性路径。
 * @param sectionId Host 已解析的章节身份。
 * @returns 项目内 JSON 路径。
 */
export function chapterImageLedgerPath(sectionId: string): string {
  return `assets/images/${digest(sectionId)}.json`
}

async function readJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  return JSON.parse(await readFile(absolute, 'utf8')) as unknown
}

/**
 * 读取项目冻结的图片风格；缺失返回 null，损坏记录拒绝读取。
 * @param workspace 项目工作区。
 * @returns 不含凭据值的项目风格。
 */
export async function readBidImageStyle(workspace: BidWorkspace): Promise<BidImageStyle | null> {
  let value: unknown
  try { value = await readJson(workspace, BID_IMAGE_STYLE_PATH) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const style = styleSchema.parse(value)
  if (style.sha256 !== digest(style.prompt)) throw new Error('BID_IMAGE_STYLE_HASH_INVALID')
  if (style.reference_image !== undefined && (style.reference_image.path !== `assets/images/${style.reference_image.content_sha256}.png`
    || style.reference_image.id !== `IMG-${digest(style.reference_image.request_sha256 + style.reference_image.content_sha256)}`)) {
    throw new Error('BID_IMAGE_REFERENCE_INVALID')
  }
  return style
}

/**
 * 读取一章所有已发图片；pending/rejected 位置仍用于恢复与修复。
 * @param workspace 项目工作区。
 * @param sectionId 当前允许的章节身份。
 * @returns 按发放顺序排列的图片。
 */
export async function readChapterImages(workspace: BidWorkspace, sectionId: string): Promise<BidChapterImage[]> {
  let value: unknown
  try { value = await readJson(workspace, chapterImageLedgerPath(sectionId)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const ledger = ledgerSchema.parse(value)
  if (ledger.section_id !== sectionId || ledger.images.some(image => image.section_id !== sectionId)
    || ledger.images.some(image => image.path !== `assets/images/${image.content_sha256}.png`
      || image.id !== `IMG-${digest(image.request_sha256 + image.content_sha256)}`)
    || new Set(ledger.images.map(image => image.id)).size !== ledger.images.length) throw new Error('BID_IMAGE_LEDGER_INVALID')
  return ledger.images
}

/**
 * 读取项目全部图片记录，仅扫描程序生成的账本文件。
 * @param workspace 项目工作区。
 * @returns 各章已发图片；损坏账本拒绝读取。
 */
export async function readBidImages(workspace: BidWorkspace): Promise<BidChapterImage[]> {
  const directory = within(workspace.projectRoot, 'assets/images')
  await assertNoLinkedPath(workspace.root, directory)
  let files: string[]
  try { files = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const images: BidChapterImage[] = []
  for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/u.test(file)).sort()) {
    const ledger = ledgerSchema.parse(await readJson(workspace, `assets/images/${file}`))
    if (chapterImageLedgerPath(ledger.section_id) !== `assets/images/${file}`) throw new Error('BID_IMAGE_LEDGER_INVALID')
    images.push(...await readChapterImages(workspace, ledger.section_id))
  }
  return images
}

/**
 * 复验项目风格引用的不可变图片；引用不需要旧章节账本。
 * @param workspace 图片所属项目。
 * @param image 由已解析风格或图片账本提供的身份。
 * @returns Hash、尺寸与普通文件限制验证通过的 PNG。
 */
export async function readBidImageReference(workspace: BidWorkspace, image: z.infer<typeof referenceSchema>): Promise<Buffer> {
  const path = within(workspace.projectRoot, image.path)
  await assertNoLinkedPath(workspace.root, path)
  const info = await lstat(path)
  if (!info.isFile() || info.size > DOCX_MAX_BODY_IMAGE_BYTES) throw new Error('BID_IMAGE_FILE_INVALID')
  const bytes = await readFile(path)
  const dimensions = docxImageDimensions(bytes)
  if (digest(bytes) !== image.content_sha256 || dimensions.type !== 'png'
    || dimensions.width !== image.width || dimensions.height !== image.height) throw new Error('BID_IMAGE_CONTENT_CHANGED')
  return bytes
}

/**
 * 在 Host 完成项目与正式章节授权后读取已视觉确认的图片。
 * @param workspace 已授权的项目工作区。
 * @param imageId Host 发放的图片身份，不能传文件路径。
 * @returns Hash 与尺寸复验通过的 PNG。
 */
export async function readBidImageBytes(workspace: BidWorkspace, imageId: BidImageId): Promise<Buffer> {
  const image = (await readBidImages(workspace)).find(image => image.id === imageId)
  if (image?.visual_status !== 'accepted') throw new Error('BID_IMAGE_NOT_ACCEPTED')
  return readBidImageReference(workspace, image)
}

/**
 * 安装一次项目风格规划的私有完成工具。
 * @param agent 当前 S5 规划 Agent。
 * @param workspace 目标项目。
 * @param connection 正式配置解析的连接；仅保存其中选定模型。
 * @param commits 当前 Run 的文件提交权限。
 * @param maxContinuations 未提交时的有限续行次数。
 * @returns 必须在 finally 中释放的风格协议。
 */
export function attachBidImageStyle(agent: Agent, workspace: BidWorkspace, connection: BidImageConnectionSpec,
  commits: BidCommitScope, maxContinuations: number): ChapterProtocol<BidImageStyle> {
  const runtime = createChapterProtocol<BidImageStyle>(agent, 'set_image_style', maxContinuations)
  runtime.register({
    name: 'set_image_style', description: '确定整个项目统一的插图风格，描述媒介、配色、背景、构图与视觉限制；只提交语义。',
    parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
    async execute(args, exec) {
      const input = chapterToolArgs(z.object({ prompt: text }).strict(), args)
      const saved = await readBidImageStyle(workspace)
      if (saved !== null) {
        if (saved.prompt !== input.prompt) throw new ToolArgsError(['项目图片风格已确定，不能由本轮重新覆盖。'])
        return runtime.finish(exec, saved)
      }
      const style = styleSchema.parse({ schema_version: 2, prompt: input.prompt, sha256: digest(input.prompt), model: connection.model })
      exec.signal.throwIfAborted()
      await commits.writeJson(within(workspace.projectRoot, BID_IMAGE_STYLE_PATH), style)
      return runtime.finish(exec, style)
    },
  })
  return runtime
}

/** 当前项目共享的生图执行；首张图确认前其他章节等待。 */
export interface BidProjectImageSession {
  /** 全书所有章节共享的固定风格与模型。 */
  readonly style: BidImageStyle
  /**
   * 生成或复用当前章图片，并在首图确认前等待其他章节。
   * @param sectionId 当前章节身份。
   * @param images 只追加的当前章图片位置表。
   * @param args 模型语义、用途及图幅。
   * @param signal 当前调用取消信号。
   * @param writer 保存真实请求日志的当前 Writer。
   * @returns 尚待视觉确认或已确认的真实图片。
   */
  generate(sectionId: string, images: BidChapterImage[], args: unknown, signal: AbortSignal, writer: Agent): Promise<BidChapterImage>
  /**
   * 保存当前图的明确视觉判断，首图通过后建立全书参考图。
   * @param sectionId 当前章节身份。
   * @param images 当前章图片位置表。
   * @param args 图片位置、接受或拒绝及理由。
   * @param signal 当前调用取消信号。
   * @returns 已持久化的图片状态。
   */
  review(sectionId: string, images: BidChapterImage[], args: unknown, signal: AbortSignal): Promise<BidChapterImage>
  /** Writer 结束或失败时释放其未确认首图与预算保留量。
   * @param sectionId 已结束的章节身份。
   */
  release(sectionId: string): void
}

async function waitForReference(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new DOMException('图片参考等待已取消。', 'AbortError'))
      }
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { if (abort !== undefined) signal.removeEventListener('abort', abort) }
}

/**
 * 创建全书共享的首图结算与资产提交执行器。
 * @param workspace 当前 Run 的项目。
 * @param provider 已配置的图片提供方。
 * @param style 全书冻结的风格与模型。
 * @param commits 当前 Run 的发布权限。
 * @returns 章节工具共享的执行器。
 */
export function createBidProjectImageSession(workspace: BidWorkspace, provider: BidImageProvider,
  style: BidImageStyle, commits: BidCommitScope): BidProjectImageSession {
  let first: { sectionId: string; imageId?: BidImageId; done: PromiseWithResolvers<void> } | undefined
  let publications = Promise.resolve()
  const retained = new Map<string, Map<string, number>>()
  const writeLedger = (sectionId: string, images: readonly BidChapterImage[], lease: Pick<BidCommitScope, 'writeJson'>) =>
    lease.writeJson(within(workspace.projectRoot, chapterImageLedgerPath(sectionId)),
      ledgerSchema.parse({ schema_version: 1, section_id: sectionId, images }))
  const settleFirst = (sectionId: string): void => {
    if (first?.sectionId !== sectionId) return
    first.done.resolve()
    first = undefined
  }
  const release = (sectionId: string): void => { settleFirst(sectionId); retained.delete(sectionId) }
  return {
    style, release,
    async generate(sectionId, images, args, signal, writer) {
      const input = chapterToolArgs(z.object({ title: z.string().trim().min(1).max(200), purpose: text, prompt: text,
        size: z.enum(['1024x1024', '1536x1024', '1024x1536']) }).strict(), args)
      while (style.reference_image === undefined && first !== undefined && first.sectionId !== sectionId) {
        await waitForReference(first.done.promise, signal)
      }
      signal.throwIfAborted()
      const requestHash = digest(JSON.stringify({ sectionId, ...input, style: style.sha256, model: style.model }))
      const ownsFirst = style.reference_image === undefined && first === undefined
      if (ownsFirst) first = { sectionId, done: Promise.withResolvers<void>() }
      const saved = images.find(image => image.request_sha256 === requestHash)
      if (saved !== undefined) {
        if (saved.visual_status === 'rejected') {
          settleFirst(sectionId)
          throw new ToolArgsError(['此图片请求已被视觉检查拒绝，请调整 prompt 后重新生成。'])
        }
        const bytes = await readBidImageReference(workspace, saved)
        const sectionAssets = retained.get(sectionId) ?? new Map<string, number>()
        sectionAssets.set(saved.path, bytes.length)
        retained.set(sectionId, sectionAssets)
        if (first?.sectionId === sectionId) first.imageId = saved.id
        return saved
      }
      if (images.length >= 100) { settleFirst(sectionId); throw new ToolArgsError(['本章已达到 100 张图片上限。']) }
      if (first?.sectionId === sectionId && !ownsFirst) {
        throw new ToolArgsError(['请先 review_bid_image 接受或拒绝当前首图，再生成下一张图片。'])
      }
      const generateAndSave = async (): Promise<BidChapterImage> => {
        let reference: Buffer | undefined
        let referenceAttachment: ImageAttachmentRef | undefined
        if (style.reference_image !== undefined) {
          const attachments = writer.ctx.get('attachments')
          if (attachments === undefined) throw new Error('BID_IMAGE_ATTACHMENTS_UNAVAILABLE')
          referenceAttachment = await attachments.saveImage({
            data: new Uint8Array(await readBidImageReference(workspace, style.reference_image)),
            mediaType: 'image/png', name: '项目插图参考.png' })
          reference = Buffer.from((await attachments.readImage(referenceAttachment, signal)).data)
        }
        const prompt = `${style.prompt}\n\n本图用途：${input.purpose}\n本图内容：${input.prompt}`
        signal.throwIfAborted()
        const result = await generateTrackedBidImage(workspace, provider, writer, commits, {
          owner: { kind: 'chapter', section_id: sectionId }, request_sha256: requestHash,
          style_sha256: style.sha256, prompt, size: input.size, model: style.model,
          ...(reference === undefined ? {} : { referenceBytes: reference }),
          ...(style.reference_image === undefined || referenceAttachment === undefined ? {} : {
            reference: { kind: 'style', ...style.reference_image, attachment: referenceAttachment },
          }),
        }, signal)
        signal.throwIfAborted()
        const hash = digest(result.png)
        const image = bidChapterImageSchema.parse({
          id: `IMG-${digest(requestHash + hash)}`, section_id: sectionId, path: `assets/images/${hash}.png`,
          content_sha256: hash, request_sha256: requestHash, width: result.width, height: result.height,
          title: input.title, purpose: input.purpose, prompt: input.prompt, style_sha256: style.sha256,
          model: result.model, visual_status: 'pending',
        })
        const dimensions = docxImageDimensions(result.png)
        if (dimensions.type !== 'png' || dimensions.width !== result.width || dimensions.height !== result.height
          || result.png.length > DOCX_MAX_BODY_IMAGE_BYTES) throw new Error('BID_IMAGE_PROVIDER_RESULT_INVALID')
        const published = publications.then(async () => {
          const extra = new Map([...retained.values()].flatMap(values => [...values]))
          extra.set(image.path, result.png.length)
          await checkImageBudget(workspace, extra)
          signal.throwIfAborted()
          await commits.publish(async (lease) => {
            await lease.writeBytes(within(workspace.projectRoot, image.path), result.png)
            await writeLedger(sectionId, [...images, image], lease)
          })
          const sectionAssets = retained.get(sectionId) ?? new Map<string, number>()
          sectionAssets.set(image.path, result.png.length)
          retained.set(sectionId, sectionAssets)
          images.push(image)
        })
        publications = published.then(() => undefined, () => undefined)
        await published
        if (first?.sectionId === sectionId) first.imageId = image.id
        return image
      }
      try { return await generateAndSave() } catch (error) { settleFirst(sectionId); throw error }
    },
    async review(sectionId, images, args, signal) {
      const input = chapterToolArgs(z.object({ image_position: z.number().int().nonnegative(),
        decision: z.enum(['accept', 'reject']), reason: text }).strict(), args)
      const reviewed = publications.then(async () => {
        signal.throwIfAborted()
        const image = images[input.image_position]
        if (image === undefined || image.section_id !== sectionId) throw new ToolArgsError(['image_position: 未知当前章节图片位置。'])
        if (image.visual_status === 'accepted' && input.decision === 'reject') {
          throw new ToolArgsError(['已确认图片不能撤销；需要改变图片时请生成新图并替换正文选择。'])
        }
        if (image.visual_status === 'accepted') return image
        if (image.visual_status === 'rejected') throw new ToolArgsError(['此图已拒绝，请调整内容重新生成，不能再次接纳原图。'])
        await readBidImageReference(workspace, image)
        const updated: BidChapterImage = {
          ...image, visual_status: input.decision === 'accept' ? 'accepted' : 'rejected', visual_reason: input.reason,
        }
        const reference = input.decision === 'accept' && style.reference_image === undefined
          ? { id: image.id, path: image.path, content_sha256: image.content_sha256, request_sha256: image.request_sha256,
            width: image.width, height: image.height }
          : style.reference_image
        if (style.reference_image?.id === image.id && input.decision === 'reject') {
          throw new ToolArgsError(['项目已确认的参考图不能由章节工具撤销；可重新生成本章其他图片。'])
        }
        signal.throwIfAborted()
        await commits.publish(async (lease) => {
          await writeLedger(sectionId, images.map(item => item.id === image.id ? updated : item), lease)
          if (reference !== undefined) await lease.writeJson(
            within(workspace.projectRoot, BID_IMAGE_STYLE_PATH), { ...style, reference_image: reference },
          )
        })
        images[input.image_position] = updated
        if (reference !== undefined) style.reference_image = reference
        if (input.decision === 'reject') retained.get(sectionId)?.delete(image.path)
        settleFirst(sectionId)
        return updated
      })
      publications = reviewed.then(() => undefined, () => undefined)
      return reviewed
    },
  }
}

type ImageToolValue = { image_position: number; title: string; visual_status: BidChapterImage['visual_status']; image: ImageAttachmentRef }

/**
 * 为当前章节 Writer 注册生图和视觉确认工具，真实图片写入会话附件。
 * @param agent 当前唯一 Writer。
 * @param runtime 当前 Writer 的私有工具协议。
 * @param workspace 图片所属项目。
 * @param sectionId Host 当前章节身份。
 * @param images 同一 Writer 各轮共享的位置表。
 * @param project 全书共享的图片执行器。
 * @param assertImageInput 在调用图片 API 前验证当前 Writer 能看图。
 * @returns 随 Writer 私有协议一起释放的图片回执监听器。
 */
export function attachChapterImageTools(agent: Agent, runtime: ChapterProtocol<unknown>, workspace: BidWorkspace,
  sectionId: string, images: BidChapterImage[], project: BidProjectImageSession,
  assertImageInput: () => Promise<void>): () => void {
  const seen = new Map<BidImageId, number>()
  const requestSeq = (): number => agent.session.events.findLast(event => event.type === 'step/start')?.seq ?? 0
  const dispose = agent.ctx.on('tools/result', (exec, result) => {
    if (exec.agent !== agent || result.isError || !['generate_bid_image', 'view_bid_image'].includes(exec.name)) return
    const input = z.object({ image_position: z.number().int().nonnegative() }).safeParse(result.value)
    const image = input.success ? images[input.data.image_position] : undefined
    if (image !== undefined && result.content.some(block => block.type === 'image')) seen.set(image.id, requestSeq())
  })
  const output: ToolDefinition['output'] = { schema: { type: 'object' }, render: (_args, value): ContentBlock[] => {
    const result = value as unknown as ImageToolValue
    return [{ type: 'text', text: JSON.stringify({ image_position: result.image_position, title: result.title,
      visual_status: result.visual_status, instruction: '请查看真实图片后调用 review_bid_image；确认后正文使用 {{image:图片位置}}。' }) },
    { type: 'image', attachment: result.image }]
  } }
  const view = async (image: BidChapterImage): Promise<ImageToolValue> => {
    const attachments = agent.ctx.get('attachments')
    if (attachments === undefined) throw new Error('BID_IMAGE_ATTACHMENTS_UNAVAILABLE')
    const attachment = await attachments.saveImage({ data: new Uint8Array(await readBidImageReference(workspace, image)),
      mediaType: 'image/png', name: `${image.title}.png` })
    return { image_position: images.findIndex(item => item.id === image.id), title: image.title,
      visual_status: image.visual_status, image: attachment }
  }
  runtime.register({ name: 'generate_bid_image', description: '按本章实际表达需要生成插图，统一使用项目风格与已确认参考图；返回真实图片，须视觉确认。',
    parameters: { type: 'object', properties: { title: { type: 'string' }, purpose: { type: 'string' }, prompt: { type: 'string' },
      size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'] } },
    required: ['title', 'purpose', 'prompt', 'size'], additionalProperties: false }, output,
    async execute(args, exec) {
      await assertImageInput()
      return view(await project.generate(sectionId, images, args, exec.signal, agent))
    },
  })
  runtime.register({ name: 'review_bid_image', description: '查看当前真实图片后明确接受或拒绝；拒绝时说明具体问题并修改内容重新生图，未确认图片不能进入正文。',
    parameters: { type: 'object', properties: { image_position: { type: 'integer' }, decision: { type: 'string', enum: ['accept', 'reject'] },
      reason: { type: 'string' } }, required: ['image_position', 'decision', 'reason'], additionalProperties: false },
    async execute(args, exec) {
      await assertImageInput()
      const input = chapterToolArgs(z.object({ image_position: z.number().int().nonnegative(),
        decision: z.enum(['accept', 'reject']), reason: text }).strict(), args)
      const selected = images[input.image_position]
      const seenAt = selected === undefined ? undefined : seen.get(selected.id)
      if (selected === undefined || seenAt === undefined || seenAt >= requestSeq()) {
        throw new ToolArgsError(['请先通过 generate_bid_image 或 view_bid_image 查看此位置的真实图片，再在下一次模型请求中提交视觉判断。'])
      }
      const image = await project.review(sectionId, images, args, exec.signal)
      return { image_position: images.findIndex(item => item.id === image.id), visual_status: image.visual_status }
    },
  })
  runtime.register({ name: 'view_bid_image', description: '查看当前章节已生成的真实图片；恢复后先看图再提交视觉判断，不重新调用计费 API。',
    parameters: { type: 'object', properties: { image_position: { type: 'integer' } }, required: ['image_position'], additionalProperties: false }, output,
    async execute(args) {
      await assertImageInput()
      const input = chapterToolArgs(z.object({ image_position: z.number().int().nonnegative() }).strict(), args)
      const image = images[input.image_position]
      if (image === undefined) throw new ToolArgsError(['image_position: 未知当前章节图片位置。'])
      return view(image)
    },
  })
  return dispose
}

/**
 * 复验章节正式插图的确认状态、图片字节及正文引用。
 * @param workspace 当前项目。
 * @param images 候选所选的正式图片记录。
 * @param markdown 已绑定的正文。
 * @param contentPath 当前章被替换的正文路径；省略时只叠加候选引用。
 * @returns 不可接纳的具体问题；文件读取错误同样变成拒绝原因。
 */
export async function validateChapterImages(workspace: BidWorkspace, images: readonly BidChapterImage[], markdown: string,
  contentPath?: string): Promise<string[]> {
  const issues: string[] = []
  const paths = chapterImagePaths(markdown)
  if (images.length > 0) {
    const style = await readBidImageStyle(workspace)
    if (style === null || images.some(image => image.style_sha256 !== style.sha256 || image.model !== style.model)) {
      issues.push('章节图片与项目已确定的风格或模型不一致。')
    }
  }
  for (const image of images) {
    if (image.visual_status !== 'accepted') issues.push(`图片“${image.title}”尚未通过真实视觉确认。`)
    if (!paths.includes(image.path)) issues.push(`图片“${image.title}”缺少对应正文展示位置。`)
    try {
      const current = (await readChapterImages(workspace, image.section_id)).find(item => item.id === image.id)
      if (current === undefined || JSON.stringify(current) !== JSON.stringify(image)) throw new Error('BID_IMAGE_LEDGER_MISMATCH')
      await readBidImageReference(workspace, image)
    } catch { issues.push(`图片“${image.title}”记录或文件已变化，须重新生成并确认。`) }
  }
  for (const path of paths) {
    if (!images.some(image => image.path === path)) issues.push('正文包含未选择的生成图片；请使用当前图片位置。')
  }
  if (/\{\{image:/u.test(markdown)) issues.push('正文仍有未绑定的图片位置。')
  if (paths.length > 0 || images.length > 0) {
    try { await checkImageBudget(workspace, new Map(), { path: contentPath ?? '', markdown }) } catch (error) {
      issues.push(error instanceof ToolArgsError ? error.message : '全书正文图片无法通过文件与总大小校验。')
    }
  }
  return issues
}
