/** S4 与 S5 共用的章节遍历、检索上下文及证据集合校验。 */
import { BidStageExecutionError, type StageValidationIssue } from './control-plane-contract.ts'
import { EVIDENCE_MAPPING_SCHEMA_VERSION, type EvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
import type { OutlineArtifact, OutlineSection } from './outline-generation-artifacts.ts'
import { validateOutlineSharedStructure } from './outline-shared-validator.ts'

/**
 * 按父子关系和 sibling order 遍历有效目录，只返回可写叶子。
 * @param outline - 当前目录。
 * @returns S4 和 S5 的共同章节执行顺序。
 */
export function buildWritableSectionWorklist(outline: OutlineArtifact): OutlineSection[] {
  const issues: StageValidationIssue[] = []
  validateOutlineSharedStructure(outline.sections, issues)
  if (issues.length > 0) throw new BidStageExecutionError(issues)
  const children = new Map<string | null, OutlineSection[]>()
  for (const section of outline.sections) {
    const siblings = children.get(section.parent_id) ?? []
    siblings.push(section)
    children.set(section.parent_id, siblings)
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.order - right.order)
  const ordered: OutlineSection[] = []
  const visit = (parentId: string | null): void => {
    for (const section of children.get(parentId) ?? []) {
      if (section.writable) ordered.push(section)
      visit(section.id)
    }
  }
  visit(null)
  return ordered
}

/**
 * 取当前章节及祖先的检索上下文。
 * @param outline - 已验证结构的目录。
 * @param section - 该目录中的可写章节。
 * @returns 固定字段顺序的检索上下文，包括祖先标题与全局合规要求。
 */
export function sectionEvidenceContext(outline: OutlineArtifact, section: OutlineSection) {
  const byId = new Map(outline.sections.map(item => [item.id, item]))
  const headingPath: string[] = []
  const seen = new Set<string>()
  let current: OutlineSection | undefined = section
  while (true) {
    if (seen.has(current.id)) throw new Error('evidence-mapping-outline-cycle')
    seen.add(current.id)
    headingPath.unshift(current.title)
    if (current.parent_id === null) break
    current = byId.get(current.parent_id)
    if (current === undefined) throw new Error('evidence-mapping-outline-parent-missing')
  }
  return {
    heading_path: headingPath,
    purpose: section.purpose,
    must_answer: section.must_answer,
    requirement_ids: [...section.requirement_ids].sort(),
    scoring_ids: [...section.scoring_ids].sort(),
    scoring_response_point_ids: [...section.scoring_response_point_ids ?? []].sort(),
    compliance_ids: [...new Set([...outline.global_compliance_ids, ...section.compliance_ids])].sort(),
    writing_notes: section.writing_notes,
    suggested_tables: section.suggested_tables,
    suggested_figures: section.suggested_figures,
  }
}

/**
 * 找出写作任务或祖先语义发生变化的叶子；分支成员变化也复核该分支的剩余叶子。
 * @param before - 最近完成章节研究的目录。
 * @param after - 结构校验通过的当前草稿。
 * @returns 按当前目录顺序排列的待复核章节 ID；排序及资料展示顺序不影响结果。
 */
export function changedWritableSectionIds(before: OutlineArtifact, after: OutlineArtifact): string[] {
  const contexts = (outline: OutlineArtifact): Map<string, string> => {
    const writable = buildWritableSectionWorklist(outline)
    const byId = new Map(outline.sections.map(section => [section.id, section]))
    const children = new Map<string, string[]>()
    for (const section of outline.sections) {
      if (section.parent_id === null) continue
      const siblings = children.get(section.parent_id) ?? []
      siblings.push(`${section.id}:${section.writable}`)
      children.set(section.parent_id, siblings)
    }
    const semantics = (section: OutlineSection) => ({
      id: section.id,
      title: section.title,
      purpose: section.purpose,
      must_answer: [...section.must_answer].sort(),
      requirement_ids: [...section.requirement_ids].sort(),
      scoring_ids: [...section.scoring_ids].sort(),
      scoring_response_point_ids: [...section.scoring_response_point_ids ?? []].sort(),
      compliance_ids: [...section.compliance_ids].sort(),
      writing_notes: [...section.writing_notes].sort(),
      suggested_tables: [...section.suggested_tables].sort(),
      suggested_figures: [...section.suggested_figures].sort(),
    })
    return new Map(writable.map((section) => {
      const ancestors = []
      let parentId = section.parent_id
      while (parentId !== null) {
        const parent = byId.get(parentId)
        if (parent === undefined) throw new Error(`section-evidence-parent-missing:${parentId}`)
        ancestors.unshift({ ...semantics(parent), children: [...children.get(parent.id) ?? []].sort() })
        parentId = parent.parent_id
      }
      return [section.id, JSON.stringify({
        ...semantics(section), ancestors, global_compliance_ids: [...outline.global_compliance_ids].sort(),
      })]
    }))
  }
  const previous = contexts(before)
  return [...contexts(after)].filter(([id, context]) => previous.get(id) !== context).map(([id]) => id)
}

/**
 * 校验证据集合恰好覆盖每个可写章节。
 * @param outline - 待确认或已确认目录。
 * @param evidence - Host 持久化的 Evidence Map。
 * @returns 缺失、重复、未知章节问题。
 */
export function validateSectionEvidenceCoverage(outline: OutlineArtifact, evidence: EvidenceMapArtifact): StageValidationIssue[] {
  const expected = new Set(buildWritableSectionWorklist(outline).map(section => section.id))
  const seen = new Set<string>()
  const issues: StageValidationIssue[] = []
  for (const mapping of evidence.section_mappings) {
    const codes = [
      ...(!expected.has(mapping.section_id) ? ['EVIDENCE_MAPPING_SECTION_UNKNOWN'] : []),
      ...(seen.has(mapping.section_id) ? ['EVIDENCE_MAPPING_SECTION_DUPLICATE'] : []),
    ]
    for (const code of codes) issues.push({ code, message: `章节 ${mapping.section_id} 的 Evidence 与当前目录不匹配。`, artifact: 'analysis/evidence-map.json' })
    seen.add(mapping.section_id)
  }
  for (const id of expected.keys()) if (!seen.has(id)) issues.push({ code: 'EVIDENCE_MAPPING_SECTION_MISSING', message: `章节 ${id} 缺少 Evidence Mapping。`, artifact: 'analysis/evidence-map.json' })
  return issues
}

/**
 * 按 section_id 对齐目录与证据，资料适用性由章节研究及最终复核判断。
 * @param outline - 最终目录。
 * @param evidence - 已完成的资料映射。
 * @returns 每个可写章节恰好一条映射；新增章节为空映射，不推断资料缺口。
 */
export function reconcileSectionEvidence(outline: OutlineArtifact, evidence: EvidenceMapArtifact): EvidenceMapArtifact {
  const mappings = new Map(evidence.section_mappings.map(mapping => [mapping.section_id, mapping]))
  return {
    schema_version: EVIDENCE_MAPPING_SCHEMA_VERSION,
    section_mappings: buildWritableSectionWorklist(outline).map((section) => {
      const existing = mappings.get(section.id)
      if (existing !== undefined) return existing
      return {
        section_id: section.id, local_materials: [], web_materials: [], writing_dimensions: [],
        missing_topics: [],
      }
    }),
  }
}

/**
 * 展开明确选中的章节与其后代；展示编号必须先由当前目录解析成实际 ID。
 * @param outline 当前目录。
 * @param ids 实际章节 ID，不接受空范围或不存在的 ID。
 * @returns 包含结构节点的完整选中范围。
 */
export function outlineSectionScope(outline: OutlineArtifact, ids: readonly string[]): Set<string> {
  const known = new Set(outline.sections.map(section => section.id))
  if (ids.length === 0 || ids.some(id => !known.has(id))) throw new Error('BID_SECTION_SCOPE_INVALID')
  const selected = new Set(ids)
  for (let changed = true; changed;) {
    changed = false
    for (const section of outline.sections) {
      if (section.parent_id !== null && selected.has(section.parent_id) && !selected.has(section.id)) {
        selected.add(section.id)
        changed = true
      }
    }
  }
  return selected
}
