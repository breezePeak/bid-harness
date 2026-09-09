/** 目录业务字段差异与现有移动操作的展示落点。 */
import { applyOutlineEdits, type OutlineArtifact, type OutlineEditOperation, type OutlineSection, type OutlineReviewContext } from '@deepseek-ai/dsh-bid/control-plane'

interface OutlineChange {
  added: boolean
  modified: boolean
  deleted: boolean
  moved: boolean
  title: boolean
  writing: boolean
  links: boolean
  children: boolean
  details: Array<{ label: string; before: string[]; after: string[] }>
}

/**
 * Compare S3 and S4 outlines by stable section identity and business fields.
 * @param baseline S3 已确认章节。
 * @param current S4 当前草稿。
 * @param evidence S4 已有关联资料；S3 确认基线尚未进行资料映射。
 * @returns 按稳定 ID 归属的字段增减和结构变化，忽略编号顺延及关联集合排列。
 */
export function compareOutlines(
  baseline: OutlineArtifact, current: OutlineArtifact, evidence?: OutlineReviewContext['evidence'],
): Map<string, OutlineChange> {
  const before = new Map(baseline.sections.map(section => [section.id, section]))
  const after = new Map(current.sections.map(section => [section.id, section]))
  const changes = new Map<string, OutlineChange>()
  const writingFields = { purpose: '编写目的', summary: '章节概述', must_answer: '必答内容', writing_notes: '写作说明', suggested_tables: '建议表格', suggested_figures: '建议插图', writable: '正文编写' } as const
  const linkFields = { requirement_ids: 'Requirement', scoring_ids: 'Scoring', compliance_ids: 'Compliance', scoring_response_point_ids: '评分响应点 ID', scoring_response_points: '评分响应点', framework_refs: '人工框架' } as const
  const items = (value: unknown): string[] => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(formatValue)
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index])
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id)
    const b = after.get(id)
    const details: { label: string; before: string[]; after: string[] }[] = []
    const changedFields = (fields: Record<string, string>, set: boolean) => {
      let changed = false
      if (a === undefined || b === undefined) return changed
      for (const [field, label] of Object.entries(fields)) {
        let left = items(a[field as keyof OutlineSection])
        let right = items(b[field as keyof OutlineSection])
        if (set) { left = [...new Set(left)].sort(); right = [...new Set(right)].sort() }
        if (same(left, right)) continue
        changed = true
        const removed = left.filter(value => !right.includes(value))
        const added = right.filter(value => !left.includes(value))
        details.push(removed.length + added.length === 0
          ? { label: `${label}（顺序）`, before: left, after: right }
          : { label, before: removed, after: added })
      }
      return changed
    }
    const title = a !== undefined && b !== undefined && a.title !== b.title
    const writing = changedFields(writingFields, false)
    const linkedFields = changedFields(linkFields, true)
    const mapping = evidence?.section_mappings.find(item => item.section_id === id)
    const materials = mapping === undefined ? [] : [
      ...mapping.local_materials.map(item => `${item.source_kind === 'reference_bid' ? '旧标书' : '资料'} · ${item.file_id} / ${item.chunk} · ${item.summary}`),
      ...mapping.web_materials.map(item => `${item.source_id} · ${item.summary} · ${item.supports}`),
    ]
    const evidenceAdded = a !== undefined && b !== undefined && materials.length > 0
    if (evidenceAdded) details.push({ label: 'S4 关联资料（S3 尚未映射）', before: [], after: materials })
    const links = linkedFields || evidenceAdded
    // 只比较两版都留在同一父节点下的章节，新增、删除与父级搬迁不会造成编号顺延误报。
    const siblings = (source: OutlineArtifact, peer: Map<string, OutlineSection>, parent: string | null) => source.sections
      .filter(section => section.parent_id === parent && peer.get(section.id)?.parent_id === parent)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)).map(section => section.id)
    const left = a === undefined ? [] : siblings(baseline, after, a.parent_id)
    const right = b === undefined ? [] : siblings(current, before, b.parent_id)
    changes.set(id, {
      added: a === undefined,
      deleted: b === undefined,
      modified: title || writing || links,
      moved: a !== undefined && b !== undefined && (a.parent_id !== b.parent_id || left.indexOf(id) !== right.indexOf(id)),
      title, writing, links, children: false, details,
    })
  }
  const changedParents = new Set<string>()
  for (const source of [before, after]) for (const [id, change] of changes) {
    if (!change.added && !change.deleted && !change.modified && !change.moved) continue
    let parent = source.get(id)?.parent_id
    while (parent != null) { changedParents.add(parent); parent = source.get(parent)?.parent_id }
  }
  for (const [id, change] of changes) change.children = changedParents.has(id)
  return changes
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatValue).join(' / ')
  if (typeof value === 'object' && value !== null) return Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${key}: ${formatValue(item)}`).join(' · ')
  return String(value)
}

/**
 * Convert one drag target into a structurally valid outline move.
 * @param outline Formal sections only.
 * @param sourceId Dragged subtree root.
 * @param targetId Target section.
 * @param position Placement relative to target; inside inserts as the first child.
 * @returns Legal move, or null before the browser accepts a drop.
 */
export function outlineDropOperation(outline: OutlineArtifact, sourceId: string, targetId: string, position: 'before' | 'inside' | 'after'): OutlineEditOperation | null {
  const source = outline.sections.find(section => section.id === sourceId)
  const target = outline.sections.find(section => section.id === targetId)
  if (source === undefined || target === undefined || source === target) return null
  const parentId = position === 'inside' ? target.id : target.parent_id
  const siblings = outline.sections.filter(section => section.parent_id === parentId && section.id !== sourceId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const order = position === 'inside' ? 1 : siblings.findIndex(section => section.id === targetId) + (position === 'before' ? 1 : 2)
  const operation: OutlineEditOperation = { type: 'move_section', section_id: sourceId, parent_id: parentId, order }
  if (source.parent_id === parentId && source.order === order) return null
  let moved: OutlineArtifact
  try { moved = applyOutlineEdits(outline, [operation]) } catch { return null }
  const parents = new Set(moved.sections.map(section => section.parent_id))
  const titles = new Set<string>()
  for (const section of moved.sections) {
    if (section.writable === parents.has(section.id)) return null
    const key = `${section.parent_id}\u0000${section.title.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}`
    if (titles.has(key)) return null
    titles.add(key)
  }
  return operation
}
