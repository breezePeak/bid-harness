/** 以所选原始模板和同一份 resolved 格式合成 DOCX。 */
import { createHash } from 'node:crypto'
import type { BidWorkspace } from './index.ts'
import type { DocxFormatView } from './docx-format-contract.ts'
import { composeDocxFromTemplate, type TechnicalDeviationComposition } from './docx-compose.ts'
import { fillBidCover, type BidCoverData } from './docx-cover.ts'
import { readBuiltInDocxTemplateBytes, readDocxTemplateBytes } from './docx-format-store.ts'

interface BuildDocxOptions {
  readonly flowchartMode?: 'svg' | 'visio-placeholder'
  readonly coverData?: BidCoverData
  readonly technicalDeviation?: TechnicalDeviationComposition
}

/**
 * 读取所选原始模板并计算缓存身份。
 * @param workspace 上传模板所属项目。
 * @param view 已解析模板身份的格式视图。
 * @returns 所选原始模板字节的内容摘要。
 */
export async function docxTemplateHash(workspace: BidWorkspace, view: DocxFormatView): Promise<string> {
  const bytes = view.templateId === null
    ? await readBuiltInDocxTemplateBytes()
    : await readDocxTemplateBytes(workspace, view.templateId)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 使用格式视图选择原始模板并填入同一份 resolved 正文。
 * @param workspace 正文图片和上传模板所属项目。
 * @param markdown 待填入模板的完整正文快照。
 * @param view 模板身份、角色映射和生效格式。
 * @param options 内置封面数据、流程图渲染模式及固定技术偏离表内容。
 * @returns 以所选原始模板为骨架合成的 DOCX 与正文资源摘要。
 */
export async function buildDocxFromResolvedTemplate(
  workspace: BidWorkspace,
  markdown: string,
  view: DocxFormatView,
  options: BuildDocxOptions = {},
): Promise<{ bytes: Buffer; assetHash: string }> {
  const original = view.templateId === null
    ? await readBuiltInDocxTemplateBytes()
    : await readDocxTemplateBytes(workspace, view.templateId)
  const builtIn = view.templateId === null
  const template = builtIn && options.coverData !== undefined
    ? await fillBidCover(original, options.coverData)
    : original
  return composeDocxFromTemplate(
    workspace,
    template,
    markdown,
    view.state.resolved,
    view.state.modelInterpreted.mapping,
    options.flowchartMode,
    builtIn ? {
      omitSourceTitle: true,
      fixedSectionTitle: '技术偏离表',
      technicalDeviation: options.technicalDeviation ?? { mode: 'clear' },
    } : {},
  )
}
