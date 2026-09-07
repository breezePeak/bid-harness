/** S3 未通过 Schema 的候选修复；只允许修改被定位的顶层或章节字段。 */
import { z } from 'zod'
import type { StageValidationIssue } from './control-plane-contract.ts'
import { outlineCandidateSchema, type OutlineArtifact } from './outline-generation-artifacts.ts'
import { normalizeOutlineCandidate } from './outline-generation-normalization.ts'
import type { ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type { TenderScoringArtifact } from './tender-analysis-artifacts.ts'
import type { TenderRequirementsArtifact, TenderComplianceArtifact } from './tender-analysis-artifacts.ts'
import type { OutlineFrameworkStructure } from './outline-framework.ts'

const record = z.record(z.string(), z.unknown())
const sectionFields = outlineCandidateSchema.shape.sections.element.shape
const rootFields = outlineCandidateSchema.shape

/** 候选问题的字段位置；数组下标仅定位尚未建立合法 ID 的原始 JSON。 */
export interface OutlineCandidateIssue extends StageValidationIssue {
  section_index: number | null
  section_id: string | null
  field: string | null
}

/** S3 字段修复不接受任意 JSON 路径或整章替换。 */
export const outlineCandidateRepairSchema = z.array(z.object({
  section_index: z.number().int().nonnegative().nullable(),
  field: z.string().min(1),
  value: z.unknown().optional(),
  remove: z.literal(true).optional(),
}).strict().refine(operation => operation.remove === true || Object.hasOwn(operation, 'value')))

/**
 * 解析并定位模型候选错误，不接管正式输入的校验。
 * @param raw 原始候选文本。
 * @param catalog 已校验的正式 RP 清单。
 * @param scoring 已校验的 S2 评分。
 * @returns 合法目录，或原始候选与可定位问题。
 */
export function inspectOutlineCandidate(raw: string, catalog: ScoringResponsePointCatalog, scoring: TenderScoringArtifact):
  | { kind: 'valid'; outline: OutlineArtifact }
  | { kind: 'format'; raw: string; issues: OutlineCandidateIssue[] }
  | { kind: 'fields'; value: unknown; issues: OutlineCandidateIssue[] } {
  let value: unknown
  try { value = JSON.parse(raw) } catch (error) {
    return { kind: 'format', raw, issues: [{ code: 'OUTLINE_CANDIDATE_JSON_INVALID', artifact: 'outline/outline.json', path: '$',
      section_index: null, section_id: null, field: null, message: error instanceof Error ? error.message : String(error) }] }
  }
  let outline: OutlineArtifact
  try { outline = normalizeOutlineCandidate(value, catalog, scoring) } catch (error) {
    if (!(error instanceof z.ZodError)) throw error
    const root = record.safeParse(value)
    const sections = root.success && Array.isArray(root.data.sections) ? root.data.sections : []
    const issues = error.issues.flatMap((issue): OutlineCandidateIssue[] => {
      const index = issue.path[0] === 'sections' && typeof issue.path[1] === 'number' ? issue.path[1] : null
      const section = record.safeParse(index === null ? undefined : sections[index])
      const fields = issue.code === 'unrecognized_keys' ? issue.keys : [issue.path[index === null ? 0 : 2]]
      return fields.map((key) => {
        const field = key === 'scoring_response_points' ? 'scoring_response_point_ids' : typeof key === 'string' ? key : null
        return { code: 'OUTLINE_CANDIDATE_FIELD_INVALID', artifact: 'outline/outline.json',
          path: index === null ? `$.${field ?? ''}` : `$.sections[${index}].${field ?? ''}`,
          section_index: index, section_id: section.success && typeof section.data.id === 'string' ? section.data.id : null,
          field, message: issue.message + (key === 'scoring_response_points' ? '；请重新明确选择合法 RP，文字快照由 Host 派生。' : '') }
      })
    })
    return { kind: 'fields', value, issues }
  }
  return { kind: 'valid', outline }
}

/**
 * 在副本上应用被问题清单授权的字段修复，允许分轮修复多个坏字段。
 * @param value 未通过规范化的原始 JSON。
 * @param operations 模型字段操作。
 * @param issues 当前允许修复的位置。
 * @param inputs 只读正式引用集合。
 * @returns 保留其他字段的候选；非法操作抛错且不修改输入。
 */
export function applyOutlineCandidateRepair(value: unknown, operations: unknown, issues: readonly OutlineCandidateIssue[], inputs: {
  catalog: ScoringResponsePointCatalog
  scoring: TenderScoringArtifact
  requirements: TenderRequirementsArtifact
  compliance: TenderComplianceArtifact
  frameworks: readonly OutlineFrameworkStructure[]
}): unknown {
  const candidate = record.parse(structuredClone(value))
  for (const operation of outlineCandidateRepairSchema.parse(operations)) {
    if (!issues.some(issue => issue.section_index === operation.section_index && issue.field === operation.field)) throw new Error('候选修复超出已定位字段范围。')
    if (operation.field === 'sections' || operation.field === 'scoring_response_points') throw new Error('不能通过字段修复重建目录或填写派生快照。')
    const target = operation.section_index === null ? candidate
      : record.parse(z.array(z.unknown()).parse(candidate.sections)[operation.section_index])
    const fields: Record<string, z.ZodType> = operation.section_index === null ? rootFields : sectionFields
    const schema = Object.hasOwn(fields, operation.field) ? fields[operation.field] : undefined
    if (operation.remove === true) {
      if (schema !== undefined) throw new Error('不能删除正式目录字段；请提交符合 Schema 的值。')
      Reflect.deleteProperty(target, operation.field)
    } else {
      if (schema === undefined) throw new Error('不能添加目录 Schema 以外的字段。')
      const parsed: unknown = schema.parse(operation.value)
      const known: Record<string, readonly string[]> = {
        requirement_ids: inputs.requirements.requirements.map(item => item.id),
        scoring_ids: inputs.scoring.scoring_items.map(item => item.id),
        scoring_response_point_ids: inputs.catalog.points.map(item => item.id),
        compliance_ids: inputs.compliance.compliance_items.map(item => item.id),
        global_compliance_ids: inputs.compliance.compliance_items.map(item => item.id),
      }
      if (Object.hasOwn(known, operation.field)) {
        const selected = z.array(z.string()).parse(parsed)
        if (selected.some(id => !known[operation.field]?.includes(id))) throw new Error('字段修复仍包含未知引用，必须明确选择正式输入中的合法 ID。')
        const previous = target[operation.field]
        const snapshots = target.scoring_response_points
        if (Array.isArray(previous) && previous.some(id => typeof id === 'string' && known[operation.field]?.includes(id) && !selected.includes(id))) throw new Error('候选字段修复必须保留已有合法关联。')
        if ((operation.field === 'scoring_ids' || operation.field === 'scoring_response_point_ids') && selected.length === 0
          && (Array.isArray(previous) && previous.length > 0 || operation.field === 'scoring_response_point_ids' && Array.isArray(snapshots) && snapshots.length > 0)) {
          throw new Error('不能通过清空未知评分或 RP 关联修复候选；请明确选择合法关联。')
        }
      }
      if (operation.field === 'framework_refs') {
        for (const ref of sectionFields.framework_refs.unwrap().parse(parsed)) {
          if (!inputs.frameworks.some(file => file.file_id === ref.file_id && file.headings.some(heading => JSON.stringify(heading.heading_path) === JSON.stringify(ref.heading_path)))) throw new Error('字段修复引用了未知框架文件或标题路径。')
        }
      }
      target[operation.field] = parsed
    }
    if (operation.field === 'scoring_response_point_ids') delete target.scoring_response_points
    if (operation.section_index !== null) (candidate.sections as unknown[])[operation.section_index] = target
  }
  return candidate
}

/**
 * 检查格式修复保留所有字符串、数值与字面值的原文和顺序。
 * @param raw 无法解析的原始候选。
 * @param repaired 模型提交的序列化修复文本。
 * @returns 可解析 JSON；涉及内容改写或无法恢复时拒绝。
 */
export function parseOutlineFormatRepair(raw: string, repaired: string): unknown {
  const tokens = (text: string) => text.match(/"(?:\\.|[^"\\])*"|[^\s{}\[\],:]+/gu) ?? []
  if (JSON.stringify(tokens(raw)) !== JSON.stringify(tokens(repaired))) throw new Error('JSON 格式修复改变了内容，不能恢复；只允许补正标点和空白，不得重生成目录或重新选择关联。')
  return JSON.parse(repaired)
}
