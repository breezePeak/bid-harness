import type { OutlineArtifact, OutlineSection } from './outline-generation-artifacts.ts'

/** User-requested change applied by the Host to the S4 outline draft. */
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

/** Apply browser operations without permitting browser edits to business references. */
export function applyOutlineEdits(source: OutlineArtifact, operations: readonly OutlineEditOperation[]): OutlineArtifact {
  const sections = source.sections.map(section => ({ ...section, must_answer: [...section.must_answer] }))
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
      const id = `SEC-${String(++nextId).padStart(3, '0')}`
      const parent = operation.parent_id === null ? undefined : byId.get(operation.parent_id)
      if (operation.parent_id !== null && parent === undefined) {
        throw new Error(`unknown outline parent ${operation.parent_id}`)
      }
      const section: OutlineSection = {
        id, parent_id: operation.parent_id, order: operation.order, level: parent === undefined ? 1 : parent.level + 1,
        title: operation.title, purpose: operation.purpose, writable: operation.writable,
        must_answer: operation.writable ? [...(operation.must_answer ?? [])] : [],
        requirement_ids: [], scoring_ids: [], compliance_ids: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
      }
      sections.push(section)
      byId.set(id, section)
    } else if (operation.type === 'delete_section') {
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
      section.parent_id = operation.parent_id
      section.order = operation.order
    }
  }
  return { ...source, sections }
}
