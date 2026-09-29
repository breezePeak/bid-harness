import { z } from 'zod'

/**
 * Parse a schema version as a record-only field.
 * Missing or invalid values are normalized to the current writer version and
 * never reject an otherwise valid artifact.
 * @param current Version written by the current implementation.
 * @returns A schema that always produces a positive integer version.
 */
export function recordOnlySchemaVersion(current: number): z.ZodType<number> {
  return z.unknown().optional().transform((value): number => (
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : current
  ))
}
