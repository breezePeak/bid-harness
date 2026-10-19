/** 独立图资产的程序身份、精确路径、真实字节与内容检查记录。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import { docxImageDimensions } from './docx-image.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
/** 经 Host 核对的图资产版本；模型从已检查对象或步骤结果选择位置。 */
export const bidFigureRefSchema = z.object({ kind: z.literal('figure'), asset_id: hash, version: hash }).strict()
/** 图源和真实 PNG 的内容检查不能代替入文后的页面检查。 */
export const bidFigureRecordSchema = z.object({
  schema_version: z.literal(1), ref: bidFigureRefSchema,
  kind: z.enum(['flowchart', 'project_image']), work_id: z.string().min(1), step_id: z.string().min(1),
  input_sha256: hash, title: z.string().trim().min(1), purpose: z.string().trim().min(1),
  path: z.string().min(1),
  width: z.number().int().positive(), height: z.number().int().positive(),
  sources: z.array(z.object({ path: z.string().min(1), sha256: hash }).strict()),
  content_review: z.object({ status: z.enum(['passed', 'rejected']), image_sha256: hash,
    reason: z.string().trim().min(1) }).strict(),
}).strict()
/** 独立图资产的持久记录。 */
export type BidFigureRecord = z.infer<typeof bidFigureRecordSchema>
/** 不可变图资产引用。 */
export type BidFigureRef = z.infer<typeof bidFigureRefSchema>

/**
 * 从 Host 步骤身份派生图资产及固定产物路径。
 * @param stepId 本 Work 的稳定步骤身份。
 * @returns 资产身份及项目相对路径。
 */
export function bidFigurePaths(stepId: string): Record<'id' | 'record' | 'png' | 'source' | 'svg', string> {
  const id = createHash('sha256').update(stepId).digest('hex')
  const root = `assets/figures/${id}`
  return { id, record: `${root}/record.json`, png: `${root}/image.png`,
    source: `${root}/source.json`, svg: `${root}/source.svg` }
}

/**
 * 读取并复验图的内容、尺寸、来源文件及绑定实际 PNG 的检查结论。
 * @param workspace 资产所属正式或候选项目。
 * @param ref Host 从已验证回执绑定的图版本。
 * @returns 可供插图和下载使用的记录与 PNG。
 */
export async function readBidFigure(workspace: BidWorkspace, ref: BidFigureRef): Promise<{ record: BidFigureRecord; png: Buffer }> {
  bidFigureRefSchema.parse(ref)
  const path = within(workspace.projectRoot, `assets/figures/${ref.asset_id}/record.json`)
  await assertNoLinkedPath(workspace.root, path)
  const record = bidFigureRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  const paths = bidFigurePaths(record.step_id)
  if (paths.id !== ref.asset_id || record.ref.asset_id !== ref.asset_id || record.ref.version !== ref.version
    || record.content_review.image_sha256 !== ref.version) throw new Error('BID_FIGURE_IDENTITY_INVALID')
  if (record.path !== (record.kind === 'flowchart' ? paths.png : `assets/images/${ref.version}.png`)) throw new Error('BID_FIGURE_PATH_INVALID')
  const pngPath = within(workspace.projectRoot, record.path)
  await assertNoLinkedPath(workspace.root, pngPath)
  const png = await readFile(pngPath)
  const dimensions = docxImageDimensions(png)
  if (createHash('sha256').update(png).digest('hex') !== ref.version || dimensions.type !== 'png'
    || dimensions.width !== record.width || dimensions.height !== record.height) throw new Error('BID_FIGURE_BYTES_INVALID')
  const expectedSources = record.kind === 'flowchart' ? [paths.source, paths.svg] : [paths.source]
  if (record.sources.length !== expectedSources.length
    || expectedSources.some(path => !record.sources.some(source => source.path === path))) throw new Error('BID_FIGURE_SOURCES_INVALID')
  for (const source of record.sources) {
    const absolute = within(workspace.projectRoot, source.path)
    await assertNoLinkedPath(workspace.root, absolute)
    if (createHash('sha256').update(await readFile(absolute)).digest('hex') !== source.sha256) throw new Error('BID_FIGURE_SOURCE_CHANGED')
  }
  if (record.content_review.status !== 'passed') throw new Error(`BID_FIGURE_CONTENT_REVIEW_REQUIRED: ${record.content_review.reason}`)
  return { record, png }
}
