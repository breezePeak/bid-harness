/** 项目级 Word 格式、模板候选及预览的数据；不包含文件系统或模型调用。 */
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
  fields: FormatField[]
  values: FormatValues
  sources: Record<string, FormatSource>
  warnings: string[]
  fingerprint?: string
  previewHtml?: string
}
/** 修改配置必须携带读取时的版本；上传文件只允许 DOCX 的 base64 字节。 */
export interface DocxFormatRequest {
  revision: number
  source: 'default' | 'template'
  overrides: FormatValues
  mapping: Record<string, string>
  description: string
  template?: {
    name: string
    data: string
  }
}
/** 模型建议尚未生效，前端展示差异后由用户应用。 */
export interface DocxFormatSuggestion {
  overrides: FormatValues
  mapping: Record<string, string>
  evidence: Record<string, string>
}
