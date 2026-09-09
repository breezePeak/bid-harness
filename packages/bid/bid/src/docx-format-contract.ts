/** 项目级 Word 格式、模板候选及预览的数据；不包含文件系统或模型调用。 */
/** DOCX 模板上传及解析的默认原始字节上限。 */
export const DOCX_TEMPLATE_MAX_BYTES = 300 * 1024 * 1024
/** 模板提取规则版本；更换规则后重新上传会丢弃旧解析缓存。 */
export const DOCX_TEMPLATE_PARSER_VERSION = 3

/** 同源 DOCX 模板二进制上传端点。 */
export const DOCX_TEMPLATE_UPLOAD_PATH = '/api/bid-docx-template' as const
/** DOCX 模板上传请求中的显示文件名。 */
export const DOCX_TEMPLATE_NAME_HEADER = 'x-dsh-bid-docx-name' as const
/** DOCX 模板上传请求中的原始字节数。 */
export const DOCX_TEMPLATE_SIZE_HEADER = 'x-dsh-bid-docx-size' as const
/** DOCX 模板上传请求读取到的配置版本。 */
export const DOCX_TEMPLATE_REVISION_HEADER = 'x-dsh-bid-docx-revision' as const

/** DOCX 格式字段可保存的标量值。 */
export type FormatValue = string | number | boolean
/** 字段键到实际值的配置覆盖。 */
export type FormatValues = Record<string, FormatValue>
/** 最终值的来源，未消除的歧义明确标为待确认。 */
export type FormatSource = '模板提取' | '用户修改' | '默认补充' | '待确认'
/** 配置输入的字段定义，数值单位直接显示在标签中。 */
export interface FormatField {
  key: string
  group: string
  label: string
  value: FormatValue
  options?: string[]
  min?: number
  max?: number
}
/** 原始格式候选只携带少量段落样本，不携带旧文档正文。 */
export interface FormatCandidate {
  id: string
  name: string
  sample: string
  values: FormatValues
  role?: string | undefined
}
/** 项目保存的解析、映射和用户覆盖；revision 用于拒绝过期编辑。 */
export interface DocxFormatState {
  version: 1
  revision: number
  opened: boolean
  template?: {
    parserVersion?: number | undefined
    hash: string
    name: string
    candidates: FormatCandidate[]
    values: FormatValues
    warnings: string[]
  } | undefined
  mapping: Record<string, string>
  overrides: FormatValues
  description: string
  source: 'default' | 'template'
  previous?: {
    name: string
    values: FormatValues
  } | undefined
  lastExport?: {
    path: string
    fingerprint: string
  } | undefined
}
/** 所有生效字段及其来源；浏览器不另算模板格式。 */
export interface DocxFormatView {
  state: DocxFormatState
  /** 当前部署允许的 DOCX 模板原始字节数。 */
  templateMaxBytes: number
  fields: FormatField[]
  values: FormatValues
  sources: Record<string, FormatSource>
  warnings: string[]
  fingerprint?: string
  previewHtml?: string
}
/** 修改配置必须携带读取时的版本；模板文件通过独立二进制端点上传。 */
export interface DocxFormatRequest {
  revision: number
  source: 'default' | 'template'
  overrides: FormatValues
  mapping: Record<string, string>
  description: string
}
/** DOCX 模板二进制上传的业务结果。 */
export type DocxTemplateUploadResult =
  | { ok: true; value: DocxFormatView }
  | { ok: false; error: { code: 'BID_DOCX_TEMPLATE_UPLOAD_FAILED'; message: string } }
/** 模型建议尚未生效，前端展示差异后由用户应用。 */
export interface DocxFormatSuggestion {
  overrides: FormatValues
  mapping: Record<string, string>
  evidence: Record<string, string>
}
