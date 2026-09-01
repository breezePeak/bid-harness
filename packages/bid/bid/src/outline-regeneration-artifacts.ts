import { z } from 'zod'
import type { OutlineArtifact, OutlineSection } from './outline-generation-artifacts.ts'

/** Version of the S5 regeneration change declaration. */
export const OUTLINE_REGENERATION_CHANGE_SET_SCHEMA_VERSION = 1 as const

const changeSchema = z.object({
  section_id: z.string().min(1),
  type: z.enum(['update', 'add', 'delete', 'move']),
  reason: z.string().trim().min(1),
}).strict()

const changeSetSchema = z.object({
  schema_version: z.literal(OUTLINE_REGENERATION_CHANGE_SET_SCHEMA_VERSION),
  base_revision: z.number().int().positive(),
  base_draft_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  changes: z.array(changeSchema),
}).strict()

/** Agent-declared changes from one persisted S5 draft to a regeneration candidate. */
export type OutlineRegenerationChangeSet = z.infer<typeof changeSetSchema>

/** @param value Decoded change-set JSON. @returns A strict regeneration change declaration. */
export function parseOutlineRegenerationChangeSet(value: unknown): OutlineRegenerationChangeSet {
  return changeSetSchema.parse(value)
}

function withoutPosition(section: OutlineSection): Omit<OutlineSection, 'parent_id' | 'order' | 'level'> {
  const { parent_id: _parentId, order: _order, level: _level, ...rest } = section
  return rest
}

/** @param base Persisted draft Outline. @param candidate Agent candidate Outline. @returns Exact section-level changes. */
export function outlineRegenerationChanges(base: OutlineArtifact, candidate: OutlineArtifact): Array<{ section_id: string; type: 'update' | 'add' | 'delete' | 'move' }> {
  const before = new Map(base.sections.map(section => [section.id, section]))
  const after = new Map(candidate.sections.map(section => [section.id, section]))
  const changes: Array<{ section_id: string; type: 'update' | 'add' | 'delete' | 'move' }> = []
  for (const section of base.sections) if (!after.has(section.id)) changes.push({ section_id: section.id, type: 'delete' })
  for (const section of candidate.sections) {
    const previous = before.get(section.id)
    if (previous === undefined) { changes.push({ section_id: section.id, type: 'add' }); continue }
    if (previous.parent_id !== section.parent_id || previous.order !== section.order || previous.level !== section.level) changes.push({ section_id: section.id, type: 'move' })
    if (JSON.stringify(withoutPosition(previous)) !== JSON.stringify(withoutPosition(section))) changes.push({ section_id: section.id, type: 'update' })
  }
  return changes.sort((left, right) => left.section_id.localeCompare(right.section_id) || left.type.localeCompare(right.type))
}

/**
 * @param changeSet Agent declaration.
 * @param base Persisted draft.
 * @param candidate Agent candidate.
 * @param revision Base revision.
 * @param draftSha256 Base hash.
 * @returns Whether the declaration exactly describes the deterministic diff.
 */
export function regenerationChangeSetMatches(
  changeSet: OutlineRegenerationChangeSet,
  base: OutlineArtifact,
  candidate: OutlineArtifact,
  revision: number,
  draftSha256: string,
): boolean {
  if (changeSet.base_revision !== revision || changeSet.base_draft_sha256 !== draftSha256) return false
  const declared = changeSet.changes.map(({ section_id, type }) => ({ section_id, type }))
    .sort((left, right) => left.section_id.localeCompare(right.section_id) || left.type.localeCompare(right.type))
  return JSON.stringify(declared) === JSON.stringify(outlineRegenerationChanges(base, candidate))
}
