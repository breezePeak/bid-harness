/** S4 与 S5 共用的章节遍历、检索语义及证据新鲜度校验。 */
import { createHash } from 'node:crypto'
import { BidStageExecutionError, type StageValidationIssue } from './control-plane-contract.ts'
import type { EvidenceMapArtifact } from './evidence-mapping-artifacts.ts'
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
 * 取影响检索的语义字段；排序编号和展示属性不参与指纹。
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
 * 计算 Host 所有的 Section 检索上下文 SHA-256。
 * @param outline - 当前目录。
 * @param section - 当前章节。
 * @returns 固定序列化的 SHA-256 十六进制摘要。
 */
export function sectionEvidenceFingerprint(outline: OutlineArtifact, section: OutlineSection): string {
  return createHash('sha256').update(JSON.stringify(sectionEvidenceContext(outline, section))).digest('hex')
}

/**
 * 校验证据集合与每个章节的检索上下文完全匹配。
 * @param outline - 待确认或已确认目录。
 * @param evidence - Host 持久化的 Evidence Map。
 * @returns 缺失、重复、未知章节与过期证据问题。
 */
export function validateSectionEvidenceFreshness(outline: OutlineArtifact, evidence: EvidenceMapArtifact): StageValidationIssue[] {
  const expected = new Map(buildWritableSectionWorklist(outline).map(section => [section.id, sectionEvidenceFingerprint(outline, section)]))
  const seen = new Set<string>()
  const issues: StageValidationIssue[] = []
  for (const mapping of evidence.section_mappings) {
    const fingerprint = expected.get(mapping.section_id)
    const codes = [
      ...(fingerprint === undefined ? ['EVIDENCE_MAPPING_SECTION_UNKNOWN'] : []),
      ...(seen.has(mapping.section_id) ? ['EVIDENCE_MAPPING_SECTION_DUPLICATE'] : []),
      ...(fingerprint !== undefined && mapping.section_fingerprint !== fingerprint ? ['EVIDENCE_MAPPING_SECTION_STALE'] : []),
    ]
    for (const code of codes) issues.push({ code, message: `章节 ${mapping.section_id} 的 Evidence 与当前目录不匹配。`, artifact: 'analysis/evidence-map.json' })
    seen.add(mapping.section_id)
  }
  for (const id of expected.keys()) if (!seen.has(id)) issues.push({ code: 'EVIDENCE_MAPPING_SECTION_MISSING', message: `章节 ${id} 缺少 Evidence Mapping。`, artifact: 'analysis/evidence-map.json' })
  return issues
}
