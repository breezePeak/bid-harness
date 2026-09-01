import type { OutlineArtifact, OutlineSection } from './outline-generation-artifacts.ts'

/** User-requested outline change shared by the browser editor and Host validator. */
export type OutlineEditOperation =
  | {
    readonly type: 'update_section'
    readonly section_id: string
    readonly title?: string
    readonly purpose?: string
    readonly must_answer?: readonly string[]
  }
  | {
    readonly type: 'add_section'
    readonly parent_id: string | null
    readonly order: number
    readonly writable: boolean
    readonly title: string
    readonly purpose: string
    readonly must_answer?: readonly string[]
  }
  | { readonly type: 'delete_section'; readonly section_id: string }
  | { readonly type: 'move_section'; readonly section_id: string; readonly parent_id: string | null; readonly order: number }

/** A section paired with its derived position in the displayed outline tree. */
export interface OutlineViewSection {
  readonly section: OutlineSection
  readonly number: string
  readonly depth: number
}

/**
 * Flatten an outline in display order with numbers derived from its tree.
 * @param sections - Outline sections whose parent and sibling order define the tree.
 * @returns Sections in tree order with non-persistent display numbers.
 */
export function buildOutlineView(sections: readonly OutlineSection[]): OutlineViewSection[] {
  const children = new Map<string | null, OutlineSection[]>()
  for (const section of sections) children.set(section.parent_id, [...(children.get(section.parent_id) ?? []), section])
  for (const siblings of children.values()) siblings.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const view: OutlineViewSection[] = []
  const visit = (parentId: string | null, prefix: readonly number[]): void => {
    for (const [index, section] of (children.get(parentId) ?? []).entries()) {
      const position = [...prefix, index + 1]
      view.push({ section, number: position.join('.'), depth: position.length })
      visit(section.id, position)
    }
  }
  visit(null, [])
  return view
}

function normalizeSiblingOrders(sections: readonly OutlineSection[]): void {
  const siblings = new Map<string | null, OutlineSection[]>()
  for (const section of sections) siblings.set(section.parent_id, [...(siblings.get(section.parent_id) ?? []), section])
  for (const group of siblings.values()) group
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .forEach((section, index) => { section.order = index + 1 })
}

function updateLevels(sections: readonly OutlineSection[]): void {
  const byParent = new Map<string | null, OutlineSection[]>()
  for (const section of sections) byParent.set(section.parent_id, [...(byParent.get(section.parent_id) ?? []), section])
  const visit = (parentId: string | null, level: number): void => {
    for (const section of byParent.get(parentId) ?? []) {
      section.level = level
      visit(section.id, level + 1)
    }
  }
  visit(null, 1)
}

/** Apply browser operations without permitting browser edits to business references. */
export function applyOutlineEdits(
  source: OutlineArtifact,
  operations: readonly OutlineEditOperation[],
  allocateSectionId?: () => string,
): OutlineArtifact {
  const sections = source.sections.map(section => ({
    ...section,
    must_answer: [...section.must_answer],
    source_mapping_ids: [...section.source_mapping_ids],
    scoring_response_points: [...section.scoring_response_points],
  }))
  const byId = new Map(sections.map(section => [section.id, section]))
  let nextId = sections.reduce((maximum, section) => Math.max(maximum, Number(section.id.match(/\d+$/u)?.[0] ?? 0)), 0)
  for (const operation of operations) {
    if (operation.type === 'update_section') {
      const section = byId.get(operation.section_id)
      if (section === undefined) throw new Error(`unknown outline section ${operation.section_id}`)
      if (operation.title !== undefined) section.title = operation.title
      if (operation.purpose !== undefined) section.purpose = operation.purpose
      if (operation.must_answer !== undefined) section.must_answer = [...operation.must_answer]
    } else if (operation.type === 'add_section') {
      const id = allocateSectionId?.() ?? `SEC-${String(++nextId).padStart(3, '0')}`
      if (byId.has(id)) throw new Error(`duplicate outline section ${id}`)
      const parent = operation.parent_id === null ? undefined : byId.get(operation.parent_id)
      if (operation.parent_id !== null && parent === undefined) throw new Error(`unknown outline parent ${operation.parent_id}`)
      const section: OutlineSection = {
        id, parent_id: operation.parent_id, order: operation.order, level: parent === undefined ? 1 : parent.level + 1,
        title: operation.title, purpose: operation.purpose, writable: operation.writable,
        must_answer: operation.writable ? [...(operation.must_answer ?? [])] : [],
        requirement_ids: [], scoring_ids: [], compliance_ids: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
        origin: 'generated', content_mode: operation.writable ? 'write_new' : null, source_mapping_ids: [], scoring_response_points: [],
      }
      sections.push(section)
      byId.set(id, section)
      const siblings = sections.filter(candidate => candidate.parent_id === operation.parent_id && candidate.id !== id)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      siblings.splice(Math.min(operation.order - 1, siblings.length), 0, section)
      siblings.forEach((candidate, index) => { candidate.order = index + 1 })
    } else if (operation.type === 'delete_section') {
      if (!byId.has(operation.section_id)) throw new Error(`unknown outline section ${operation.section_id}`)
      const remove = new Set<string>([operation.section_id])
      for (let changed = true; changed;) {
        changed = false
        for (const section of sections) {
          if (section.parent_id !== null && remove.has(section.parent_id) && !remove.has(section.id)) {
            remove.add(section.id)
            changed = true
          }
        }
      }
      for (const id of remove) byId.delete(id)
      for (let index = sections.length - 1; index >= 0; index--) {
        const section = sections[index]
        if (section !== undefined && remove.has(section.id)) sections.splice(index, 1)
      }
    } else {
      const section = byId.get(operation.section_id)
      if (section === undefined) throw new Error(`unknown outline section ${operation.section_id}`)
      const parent = operation.parent_id === null ? undefined : byId.get(operation.parent_id)
      if (operation.parent_id !== null && parent === undefined) throw new Error(`unknown outline parent ${operation.parent_id}`)
      if (operation.parent_id === section.id) throw new Error('a section cannot parent itself')
      const descendants = new Set<string>([section.id])
      for (let changed = true; changed;) {
        changed = false
        for (const candidate of sections) {
          if (candidate.parent_id !== null
            && descendants.has(candidate.parent_id)
            && !descendants.has(candidate.id)) {
            descendants.add(candidate.id)
            changed = true
          }
        }
      }
      if (operation.parent_id !== null && descendants.has(operation.parent_id)) throw new Error('a section cannot move into its descendant')
      const sourceSiblings = sections.filter(candidate => candidate.parent_id === section.parent_id && candidate.id !== section.id)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      sourceSiblings.forEach((candidate, index) => { candidate.order = index + 1 })
      section.parent_id = operation.parent_id
      const destinationSiblings = sections.filter(candidate => candidate.parent_id === operation.parent_id && candidate.id !== section.id)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      destinationSiblings.splice(Math.min(operation.order - 1, destinationSiblings.length), 0, section)
      destinationSiblings.forEach((candidate, index) => { candidate.order = index + 1 })
    }
    normalizeSiblingOrders(sections)
    updateLevels(sections)
  }
  return { ...source, sections }
}
