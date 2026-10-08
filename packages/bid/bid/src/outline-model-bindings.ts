/** S3 模型只选择本次输入表的位置；持久身份、派生快照及新增节点编号由程序绑定。 */
import { normalizeOutlineSectionTitle } from './outline-title.ts'
import { z } from 'zod'
import { outlineAssociationRepairOperationSchema, outlineRepairOperationSchema } from './outline-generation-repair.ts'
import { outlineCandidateRepairSchema } from './outline-candidate-repair.ts'
import { outlineEditOperationSchema, parseOutlineEditOperations, type OutlineEditOperation } from './outline-confirmation-edits.ts'
import { outlineModelCandidateSchema, outlineCandidateSchema, OUTLINE_GENERATION_SCHEMA_VERSION, type OutlineArtifact } from './outline-generation-artifacts.ts'
import type { OutlineFrameworkStructure } from './outline-framework.ts'
import type { ScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import type { TenderRequirementsArtifact, TenderScoringArtifact, TenderComplianceArtifact } from './tender-analysis-artifacts.ts'

const position = z.number().int().nonnegative()
const positions = z.array(position)
const frameworkRefs = outlineModelCandidateSchema.shape.sections.element.shape.framework_refs
const references = { requirement_positions: positions.optional(), scoring_positions: positions.optional(),
  compliance_positions: positions.optional(), response_point_positions: positions.optional(),
  framework_refs: frameworkRefs.optional() }
const [update, add, split, remove, merge, move, global, structure] = outlineAssociationRepairOperationSchema.options

const programFields = ['id', 'parent_id', 'section_id', 'section_ids', 'order', 'writable', 'requirement_ids',
  'scoring_ids', 'compliance_ids', 'scoring_response_point_ids', 'global_compliance_ids', 'framework_refs', 'children'] as const

function semanticFields<Shape extends z.ZodRawShape>(shape: Shape): Omit<Shape, typeof programFields[number]> {
  return Object.fromEntries(
    Object.entries(shape).filter(([key]) => !programFields.some(field => field === key)),
  ) as Omit<Shape, typeof programFields[number]>
}

const writableAnswers = add.shape.must_answer.unwrap().min(1)
  .describe('新增可写章节的具体写作要求，必填且至少一项。')
function modelUpdateSchema<Shape extends z.ZodRawShape, Fields extends z.ZodRawShape>(shape: Shape, fields: Fields) {
  const { response_point_positions: _responsePoints, ...otherReferences } = fields
  const semantic = { ...semanticFields(shape), section_position: position, ...otherReferences }
  return z.union([
    z.object(semantic).strict(),
    z.object({ ...semantic, response_point_positions: positions,
      must_answer: update.shape.must_answer.unwrap()
        .describe('修改响应点关联时必须同时提交本章节完整的 must_answer。') }).strict(),
  ])
}

const modelUpdate = modelUpdateSchema(update.shape, references)
const modelAdd = z.object({ ...semanticFields(add.shape), parent_position: position.nullable(),
  sibling_position: position, ...references, must_answer: writableAnswers }).strict()
const modelSplit = z.object({ ...semanticFields(split.shape), section_position: position,
  children: z.array(z.object({ ...semanticFields(split.shape.children.element.shape), ...references }).strict()).min(2) }).strict()

/** 语义复核及关联修复的局部操作位置协议；不接受任何原始身份字段。 */
export const outlineModelRepairOperationSchema = z.union([
  modelUpdate, modelAdd, modelSplit,
  z.object({ ...semanticFields(remove.shape), section_position: position }).strict(),
  z.object({ ...semanticFields(merge.shape), section_positions: positions.min(2) }).strict(),
  z.object({ ...semanticFields(move.shape), section_position: position, parent_position: position.nullable(),
    sibling_position: position }).strict(),
  z.object({ ...semanticFields(global.shape), global_compliance_positions: positions }).strict(),
  z.object({ ...semanticFields(structure.shape), regenerate_id: z.literal(true).optional(),
    parent_position: position.nullable().optional(), sibling_position: position.optional() }).strict(),
])

const [responseUpdate, responseAdd, responseSplit] = outlineRepairOperationSchema.options
const responseReferences = { response_point_positions: positions.optional() }
/** 响应点修复只开放正式操作支持的语义字段和响应点位置。 */
export const outlineModelResponsePointRepairOperationSchema = z.union([
  modelUpdateSchema(responseUpdate.shape, responseReferences),
  z.object({ ...semanticFields(responseAdd.shape), parent_position: position.nullable(),
    sibling_position: position, ...responseReferences, must_answer: writableAnswers }).strict(),
  z.object({ ...semanticFields(responseSplit.shape), section_position: position,
    children: z.array(z.object({ ...semanticFields(responseSplit.shape.children.element.shape),
      response_point_positions: positions }).strict()).min(2) }).strict(),
])

const [editUpdate, editAdd, editDelete, editSplit, editMerge, editMove] = outlineEditOperationSchema.options
/** 局部重生成只允许结构与正文指导位置操作，不授予业务关联修改权限。 */
export const outlineModelStructuralOperationSchema = z.union([
  z.object({ ...semanticFields(editUpdate.shape), section_position: position }).strict(),
  z.object({ ...semanticFields(editAdd.shape), parent_position: position.nullable(), sibling_position: position,
    must_answer: writableAnswers }).strict(),
  z.object({ ...semanticFields(editDelete.shape), section_position: position }).strict(),
  z.object({ ...semanticFields(editSplit.shape), section_position: position, children: editSplit.shape.children }).strict(),
  z.object({ ...semanticFields(editMerge.shape), section_positions: positions.min(2) }).strict(),
  z.object({ ...semanticFields(editMove.shape), section_position: position, parent_position: position.nullable(),
    sibling_position: position }).strict(),
])

/** 字段修复只定位字段；身份字段的值由程序按相应输入表的位置恢复。 */
export const outlineModelCandidateRepairSchema = outlineCandidateRepairSchema

/** 一次模型请求冻结的权威业务输入表。 */
export interface OutlineModelBindingInputs {
  readonly requirements: TenderRequirementsArtifact
  readonly scoring: TenderScoringArtifact
  readonly compliance: TenderComplianceArtifact
  readonly catalog: ScoringResponsePointCatalog
  readonly frameworks: readonly OutlineFrameworkStructure[]
}

const fieldNames: Record<string, string> = {
  parent_id: 'parent_position', section_id: 'section_position', section_ids: 'section_positions',
  requirement_ids: 'requirement_positions', scoring_ids: 'scoring_positions', compliance_ids: 'compliance_positions',
  scoring_response_point_ids: 'response_point_positions', global_compliance_ids: 'global_compliance_positions',
  order: 'sibling_position',
}

function pick(items: readonly { id: string }[], value: unknown): string[] {
  return positions.parse(value).map((index) => {
    const item = items[index]
    if (item === undefined) throw new Error('BID_OUTLINE_MODEL_POSITION_INVALID')
    return item.id
  })
}

function locate(items: readonly { id: string }[], ids: readonly string[]): number[] {
  return ids.map((id) => {
    const index = items.findIndex(item => item.id === id)
    if (index < 0) throw new Error('BID_OUTLINE_MODEL_REFERENCE_UNKNOWN')
    return index
  })
}

function bindFrameworkRefs(inputs: OutlineModelBindingInputs, value: unknown) {
  return frameworkRefs.parse(value).map((ref) => {
    const framework = inputs.frameworks[ref.framework_position]
    const heading = framework?.headings[ref.heading_position]
    if (framework === undefined || heading === undefined) throw new Error('BID_OUTLINE_MODEL_FRAMEWORK_POSITION_INVALID')
    return { file_id: framework.file_id, heading_path: [...heading.heading_path] }
  })
}

function bindValue(field: string, value: unknown, inputs: OutlineModelBindingInputs, sections: readonly { id: string }[]): unknown {
  if (field === 'sibling_position') return position.parse(value) + 1
  if (field === 'requirement_positions') return pick(inputs.requirements.requirements, value)
  if (field === 'scoring_positions') return pick(inputs.scoring.scoring_items, value)
  if (field === 'compliance_positions' || field === 'global_compliance_positions') return pick(inputs.compliance.compliance_items, value)
  if (field === 'response_point_positions') return pick(inputs.catalog.points, value)
  if (field === 'section_positions') return pick(sections, value)
  if (field === 'section_position' || field === 'parent_position') {
    if (field === 'parent_position' && value === null) return null
    return pick(sections, [value])[0]
  }
  if (field === 'framework_refs') return bindFrameworkRefs(inputs, value)
  return value
}

/**
 * 投影权威事实表，模型通过位置作语义选择，不接触持久身份。
 * @param inputs 本次固定的业务输入。
 * @returns 可直接注入模型请求的位置表。
 */
export function outlineModelInputView(inputs: OutlineModelBindingInputs): unknown {
  return {
    requirements: inputs.requirements.requirements.map(({ id: _id, ...item }, position) => ({ position, ...item })),
    scoring: inputs.scoring.scoring_items.map(({ id: _id, parent, ...item }, position) => ({ position, ...item,
      parent_position: parent === null ? null : locate(inputs.scoring.scoring_items, [parent])[0] })),
    compliance: inputs.compliance.compliance_items.map(({ id: _id, ...item }, position) => ({ position, ...item })),
    response_points: inputs.catalog.points.map(({ scoring_id, text }, position) => ({ position, text,
      scoring_position: locate(inputs.scoring.scoring_items, [scoring_id])[0] })),
    frameworks: inputs.frameworks.map(({ name, headings }, framework_position) => ({ framework_position, name,
      headings: headings.map((heading, heading_position) => ({ heading_position, ...heading })) })),
  }
}

/**
 * 以当前目录数组位置投影节点与关联；位置仅在本次请求内有效。
 * @param outline 本次请求的精确目录版本。
 * @param inputs 本次固定业务输入。
 * @returns 无持久身份的目录视图；不可解析的关联保留 null 占位与字段诊断，供模型按当前输入表重新选择。
 */
export function outlineModelView(outline: OutlineArtifact, inputs: OutlineModelBindingInputs): unknown {
  const unresolved: Array<{ section_position: number | null; field: string; reference_position: number; message: string }> = []
  const currentPositions = (items: readonly { id: string }[], ids: readonly string[],
    field: string, section_position: number | null = null): Array<number | null> => ids.map((id, reference_position) => {
    const position = items.findIndex(item => item.id === id)
    if (position >= 0) return position
    unresolved.push({ section_position, field, reference_position,
      message: '原候选关联的对象不在本次输入表中；保留候选内容，根据当前合法选项重新选择该关联。' })
    return null
  })
  return {
    document_title: outline.document_title,
    global_compliance_positions: currentPositions(inputs.compliance.compliance_items, outline.global_compliance_ids, 'global_compliance_positions'),
    sections: outline.sections.map((section, position) => {
      const { id: _id, parent_id, level: _level, order, requirement_ids, scoring_ids, compliance_ids,
        scoring_response_point_ids, scoring_response_points: _snapshots, framework_refs, ...semantic } = section
      return { position, ...semantic, title: normalizeOutlineSectionTitle(section.title) || section.title,
        sibling_position: order - 1,
        parent_position: parent_id === null ? null : currentPositions(outline.sections, [parent_id], 'parent_position', position)[0],
        requirement_positions: currentPositions(inputs.requirements.requirements, requirement_ids, 'requirement_positions', position),
        scoring_positions: currentPositions(inputs.scoring.scoring_items, scoring_ids, 'scoring_positions', position),
        compliance_positions: currentPositions(inputs.compliance.compliance_items, compliance_ids, 'compliance_positions', position),
        response_point_positions: currentPositions(inputs.catalog.points, scoring_response_point_ids ?? [], 'response_point_positions', position),
        framework_refs: (framework_refs ?? []).map((ref, reference_position) => {
          const framework_position = inputs.frameworks.findIndex(item => item.file_id === ref.file_id)
          const heading_position = inputs.frameworks[framework_position]?.headings.findIndex(
            item => JSON.stringify(item.heading_path) === JSON.stringify(ref.heading_path)) ?? -1
          if (framework_position < 0 || heading_position < 0) unresolved.push({ section_position: position,
            field: 'framework_refs', reference_position,
            message: `原框架标题 ${ref.heading_path.join(' / ')} 不在本次输入表中；保留候选内容，根据当前框架标题重新选择关联。` })
          return { framework_position: framework_position < 0 ? null : framework_position,
            heading_position: heading_position < 0 ? null : heading_position }
        }),
      }
    }),
    ...(unresolved.length === 0 ? {} : { unresolved_references: unresolved }),
  }
}

/**
 * 展开初稿语义树，程序分配章节编号并派生父关系与树层级；旧扁平父引用被严格拒绝。
 * @param value 模型嵌套候选。
 * @param inputs 本次固定业务输入。
 * @param baseline 重新生成时保留已有节点身份的目录基线。
 * @returns 可交给正式规范化器的程序候选。
 */
export function bindOutlineModelCandidate(value: unknown, inputs: OutlineModelBindingInputs,
  baseline?: OutlineArtifact): z.infer<typeof outlineCandidateSchema> {
  const candidate = outlineModelCandidateSchema.parse(value)
  type ModelSection = z.infer<typeof outlineModelCandidateSchema>['sections'][number]
  const nodes: Array<{ section: ModelSection; parent: number | null; order: number; level: number }> = []
  const flatten = (siblings: readonly ModelSection[], parent: number | null, level: number): void => {
    siblings.forEach((section, sibling) => {
      const index = nodes.length
      nodes.push({ section, parent, order: sibling + 1, level })
      flatten(section.children, index, level + 1)
    })
  }
  flatten(candidate.sections, null, 1)
  let next = Math.max(0, ...(baseline?.sections ?? []).map(section => /^SEC-\d+$/u.test(section.id) ? Number(section.id.slice(4)) : 0))
  const identities = nodes.map(({ section }) => {
    if (section.source_position === undefined) return { id: `SEC-${String(++next).padStart(3, '0')}` }
    const previous = baseline?.sections[section.source_position]
    if (previous === undefined) throw new Error('BID_OUTLINE_MODEL_SOURCE_POSITION_INVALID')
    return { id: previous.id }
  })
  if (new Set(identities.map(item => item.id)).size !== identities.length) throw new Error('BID_OUTLINE_MODEL_SOURCE_POSITION_DUPLICATE')
  const reverse = Object.fromEntries(Object.entries(fieldNames).map(([persisted, model]) => [model, persisted]))
  return outlineCandidateSchema.parse({
    schema_version: OUTLINE_GENERATION_SCHEMA_VERSION, scope: 'technical_bid', document_title: candidate.document_title,
    global_compliance_ids: pick(inputs.compliance.compliance_items, candidate.global_compliance_positions),
    sections: nodes.map(({ section: { source_position: _source, children, ...section }, parent, order, level }, index) => {
      const writable = children.length === 0
      return { id: identities[index]?.id, parent_id: parent === null ? null : identities[parent]?.id, level, order,
        ...Object.fromEntries(Object.entries(section).map(([field, value]) => [reverse[field] ?? field,
          field === 'title' ? normalizeOutlineSectionTitle(z.string().parse(value)) : bindValue(field, value, inputs, identities)])), writable,
        ...(!writable ? { must_answer: [], scoring_response_point_ids: [] } : {}) }
    }),
  })
}

/**
 * 将模型局部操作绑定到本次请求的目录及业务表，后续正式操作器仍执行完整校验。
 * @param value 模型局部操作。
 * @param outline 请求时冻结的目录。
 * @param inputs 请求时冻结的业务表。
 * @param responsePointsOnly 是否仅允许原响应点修复入口的操作类别。
 * @returns 保持持久协议的正式编辑操作。
 */
export function bindOutlineModelRepairOperations(value: unknown, outline: OutlineArtifact, inputs: OutlineModelBindingInputs,
  responsePointsOnly = false): z.infer<typeof outlineAssociationRepairOperationSchema>[] {
  const schema = responsePointsOnly ? outlineModelResponsePointRepairOperationSchema : outlineModelRepairOperationSchema
  const operations = z.array(schema).parse(value)
  const reverse = Object.fromEntries(Object.entries(fieldNames).map(([persisted, model]) => [model, persisted]))
  const added = operations.reduce((count, operation) => count + (operation.type === 'add_section' ? 1
    : operation.type === 'split_section' ? operation.children.length : 0), 0)
  let next = Math.max(0, ...outline.sections.map(section => /^SEC-\d+$/u.test(section.id) ? Number(section.id.slice(4)) : 0)) + added
  const bind = (record: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(record)
    .map(([field, item]) => {
      if (field === 'children') return [field, z.array(z.record(z.string(), z.unknown())).parse(item).map(bind)]
      if (field === 'regenerate_id') return ['id', `SEC-${String(++next).padStart(3, '0')}`]
      return [reverse[field] ?? field, bindValue(field, item, inputs, outline.sections)]
    }))
  return z.array(responsePointsOnly ? outlineRepairOperationSchema : outlineAssociationRepairOperationSchema)
    .parse(operations.map(operation => ({ ...bind(operation), ...(operation.type === 'add_section' ? { writable: true } : {}) })))
}

/**
 * 绑定局部重生成的结构位置，不允许模型修改业务关联。
 * @param value 模型结构操作。
 * @param outline 本次请求冻结的目录。
 * @returns 浏览器与 Host 共用的结构编辑操作。
 */
export function bindOutlineModelStructuralOperations(value: unknown, outline: OutlineArtifact): OutlineEditOperation[] {
  const operations = z.array(outlineModelStructuralOperationSchema).parse(value)
  return parseOutlineEditOperations(bindOutlineModelRepairOperations(operations, outline, {
    requirements: { schema_version: 1, requirements: [] }, scoring: { schema_version: 1, scoring_items: [] },
    compliance: { schema_version: 1, compliance_items: [] },
    catalog: { schema_version: 1, scope: 'technical_bid', scoring_sha256: '0'.repeat(64), next_sequence: 1, points: [] },
    frameworks: [],
  }))
}

/**
 * 将已定位字段的位置选择绑定为正式字段值；原始 ID 字段不能由模型补写。
 * @param value 模型字段操作。
 * @param sections 原始候选节点，仅用于绑定父节点位置。
 * @param inputs 本次业务输入。
 * @returns 正式字段修复操作。
 */
export function bindOutlineModelCandidateRepairs(value: unknown, sections: readonly { id: string }[],
  inputs: OutlineModelBindingInputs): unknown {
  const reverse = Object.fromEntries(Object.entries(fieldNames).map(([persisted, model]) => [model, persisted]))
  return outlineModelCandidateRepairSchema.parse(value).map((operation) => {
    if (['id', 'level', 'writable', 'schema_version', 'scope'].includes(operation.field) || Object.hasOwn(fieldNames, operation.field)) throw new Error('BID_OUTLINE_MODEL_ID_FIELD_FORBIDDEN')
    return { ...operation, field: reverse[operation.field] ?? operation.field,
      ...(operation.remove === true ? {} : { value: bindValue(operation.field, operation.value, inputs, sections) }) }
  })
}

/**
 * 将字段诊断名称投影为模型可以选择的位置字段。
 * @param field 正式字段名称。
 * @returns 本次模型字段名称。
 */
export function outlineModelFieldName(field: string): string {
  return fieldNames[field] ?? field
}
