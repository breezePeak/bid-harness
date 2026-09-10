/** 项目级 Word 格式提取、冲突确认及预览数据；不包含文件系统或模型调用。 */
/** DOCX 模板上传及解析的默认原始字节上限。 */
export const DOCX_TEMPLATE_MAX_BYTES = 300 * 1024 * 1024
/** 模板提取规则版本；更换规则后重新上传会丢弃旧解析缓存。 */
export const DOCX_TEMPLATE_PARSER_VERSION = 4

/** 同源 DOCX 模板二进制上传端点。 */
export const DOCX_TEMPLATE_UPLOAD_PATH = '/api/bid-docx-template' as const
/** DOCX 模板上传请求中的显示文件名。 */
export const DOCX_TEMPLATE_NAME_HEADER = 'x-dsh-bid-docx-name' as const
/** DOCX 模板上传请求中的原始字节数。 */
export const DOCX_TEMPLATE_SIZE_HEADER = 'x-dsh-bid-docx-size' as const
/** DOCX 模板上传请求读取到的配置版本。 */
export const DOCX_TEMPLATE_REVISION_HEADER = 'x-dsh-bid-docx-revision' as const

/** 当前 Word 生成器支持的格式角色。 */
export type FormatRole = 'title' | `heading${1 | 2 | 3 | 4 | 5 | 6}` | 'body' | 'tableHeader' | 'tableCell'
  | 'figureCaption' | 'tableCaption' | 'header' | 'footer'
/** DOCX 格式字段可保存的标量值。 */
export type FormatValue = string | number | boolean
/** 字段键到实际值的配置。 */
export type FormatValues = Record<string, FormatValue>
/** 一项格式事实的来源；数组顺序不表达优先级。 */
export type FormatEvidenceSource = 'system_default' | 'doc_defaults' | 'theme' | 'named_style' | 'direct_format'
  | 'template_instruction' | 'user_requirement' | 'user_confirmed'
/** 程序或模型识别的一项可核对格式事实。 */
export interface FormatEvidence {
  key: string
  source: FormatEvidenceSource
  value: FormatValue
  text?: string | undefined
  candidateId?: string | undefined
}
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
/** 一个样式或直接格式候选可服务多个角色并保留多个正文样本。 */
export interface FormatCandidate {
  id: string
  name: string
  values: FormatValues
  roles: FormatRole[]
  samples: string[]
  evidence: FormatEvidence[]
}
/** OOXML 确定性提取结果；模板正文仅供模型识别格式说明。 */
export interface DocxFormatExtraction {
  values: FormatValues
  candidates: FormatCandidate[]
  paragraphs: string[]
  evidence: FormatEvidence[]
  warnings: string[]
}
/** 单次 DOCX 解析结果；模板身份与提取事实分别保存。 */
export interface ParsedDocxTemplate {
  parserVersion: number
  hash: string
  name: string
  extracted: DocxFormatExtraction
}
/** 模型只能引用提取文本及候选，程序在保存前校验全部引用。 */
export interface DocxFormatInterpretation {
  values: FormatValues
  mapping: Partial<Record<FormatRole, string>>
  evidence: FormatEvidence[]
}
/** 不同证据给出多个值时保留全部选项，直到用户确认。 */
export interface FormatConflict {
  key: string
  resolvedValue: FormatValue
  status: 'conflict' | 'confirmed'
  evidence: FormatEvidence[]
}
/** 项目保存的提取、解释、冲突和最终值；revision 用于拒绝过期确认。 */
export interface DocxFormatState {
  version: 2
  revision: number
  opened: boolean
  template?: {
    parserVersion: number
    hash: string
    name: string
  } | undefined
  extracted: DocxFormatExtraction
  modelInterpreted: DocxFormatInterpretation
  conflicts: FormatConflict[]
  resolved: FormatValues
  userConfirmed: FormatValues
  lastExport?: {
    path: string
    fingerprint: string
  } | undefined
}
/** 解析及确认结果；浏览器和 DOCX 生成器只读取 values 指向的 resolved。 */
export interface DocxFormatView {
  state: DocxFormatState
  /** 当前部署允许的 DOCX 模板原始字节数。 */
  templateMaxBytes: number
  fields: FormatField[]
  values: FormatValues
  warnings: string[]
  fingerprint?: string
  previewHtml?: string
}
/** 用户确认冲突必须携带读取时的版本及完整确认集合。 */
export interface DocxFormatRequest {
  revision: number
  userConfirmed: FormatValues
}
/** DOCX 模板二进制上传的业务结果。 */
export type DocxTemplateUploadResult =
  | { ok: true; value: DocxFormatView }
  | { ok: false; error: { code: 'BID_DOCX_TEMPLATE_UPLOAD_FAILED'; message: string } }
/** 模型对模板正文说明和样式角色的解释；保存前由程序合并。 */
export interface DocxFormatSuggestion {
  values: FormatValues
  mapping: Partial<Record<FormatRole, string>>
  evidence: FormatEvidence[]
}
