/** Display-only outline comparison and drop targets for the existing move operation. */
import { applyOutlineEdits, type OutlineArtifact, type OutlineEditOperation, type OutlineSection } from '@deepseek-ai/dsh-bid/control-plane'

/**
 * @param baseline S3 confirmed sections.
 * @param current Editable sections.
 * @returns Independent content and position changes keyed by stable section ID.
 */
export function compareOutlines(baseline: OutlineArtifact, current: OutlineArtifact) {
  const before = new Map(baseline.sections.map(section => [section.id, section]))
  const after = new Map(current.sections.map(section => [section.id, section]))
  const content = ({ id: _id, parent_id: _parent, order: _order, level: _level, ...fields }: OutlineSection) => fields
  const changes = new Map<string, { added: boolean; modified: boolean; deleted: boolean; moved: boolean }>()
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id)
    const b = after.get(id)
    changes.set(id, {
      added: a === undefined,
      deleted: b === undefined,
      modified: a !== undefined && b !== undefined && JSON.stringify(content(a)) !== JSON.stringify(content(b)),
      moved: a !== undefined && b !== undefined && (a.parent_id !== b.parent_id || a.level !== b.level || a.order !== b.order),
    })
  }
  return changes
}

/**
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
