import type { OutlineArtifact, OutlineSection } from './outline-generation-artifacts.ts'
import { z } from 'zod'

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

const text = z.string().min(1)
const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update_section'), section_id: text, title: text.optional(), purpose: text.optional(), must_answer: z.array(text).optional() }).strict().refine(value => value.title !== undefined || value.purpose !== undefined || value.must_answer !== undefined),
  z.object({ type: z.literal('add_section'), parent_id: z.string().min(1).nullable(), order: z.number().int().positive(), writable: z.boolean(), title: text, purpose: text, must_answer: z.array(text).optional() }).strict().superRefine((value, context) => {
    if (value.writable && (value.must_answer?.length ?? 0) === 0) context.addIssue({ code: 'custom', message: 'a writable section requires must_answer' })
    if (!value.writable && (value.must_answer?.length ?? 0) !== 0) context.addIssue({ code: 'custom', message: 'a structural section cannot have must_answer' })
  }),
  z.object({ type: z.literal('delete_section'), section_id: text }).strict(),
  z.object({ type: z.literal('move_section'), section_id: text, parent_id: z.string().min(1).nullable(), order: z.number().int().positive() }).strict(),
])

/** Parse browser-provided edit operations before they can affect an outline Artifact. */
export function parseOutlineEditOperations(value: unknown): OutlineEditOperation[] {
  return z.array(operationSchema).parse(value) as OutlineEditOperation[]
}

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
        for (const candidate of sections) if (
          candidate.parent_id !== null && descendants.has(candidate.parent_id) && !descendants.has(candidate.id)
        ) {
          descendants.add(candidate.id)
          changed = true
        }
      }
      if (operation.parent_id !== null && descendants.has(operation.parent_id)) throw new Error('a section cannot move into its descendant')
      section.parent_id = operation.parent_id
      section.order = operation.order
      const levels = new Map<string, number>([[section.id, parent === undefined ? 1 : parent.level + 1]])
      for (let changed = true; changed;) {
        changed = false
        for (const candidate of sections) {
          const level = levels.get(candidate.parent_id ?? '')
          if (candidate.parent_id !== null && level !== undefined && levels.get(candidate.id) !== level + 1) {
            levels.set(candidate.id, level + 1)
            changed = true
          }
        }
      }
      for (const [id, level] of levels) {
        const candidate = byId.get(id)
        if (candidate !== undefined) candidate.level = level
      }
    }
  }
  const siblings = new Map<string, OutlineSection[]>()
  for (const section of sections) {
    const key = section.parent_id ?? ''
    siblings.set(key, [...(siblings.get(key) ?? []), section])
  }
  for (const group of siblings.values()) group
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .forEach((section, index) => { section.order = index + 1 })
  return { ...source, sections }
}
