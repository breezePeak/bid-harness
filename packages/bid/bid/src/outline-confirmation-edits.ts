import { z } from 'zod'
import { applyOutlineEdits, buildOutlineView, type OutlineEditOperation, type OutlineViewSection } from './outline-confirmation-browser.ts'

export { applyOutlineEdits, buildOutlineView }
export type { OutlineEditOperation, OutlineViewSection }

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
