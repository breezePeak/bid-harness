/** Deterministic evaluators for Main-Agent-authored acceptance criteria. */
import type { AcceptanceCriterion } from './writing-requirements.ts'

/** Host inputs available at either a chapter or whole-document boundary. */
export interface HostAcceptanceContext {
  readonly markdown?: string
  readonly estimatedPages?: number
}

/** One reproducible Host measurement; semantic criteria are left to a Reviewer. */
export interface HostAcceptanceResult {
  readonly criterion_id: string
  readonly status: 'met' | 'unmet' | 'unavailable'
  readonly measured: number | string | null
  readonly message: string
}

function withinBounds(value: number, min: number | null, max: number | null): boolean {
  return (min === null || value >= min) && (max === null || value <= max)
}

/**
 * Compare one measured number with a deterministic bounded criterion.
 * @param min Inclusive lower bound, or no lower bound.
 * @param max Inclusive upper bound, or no upper bound.
 * @param measured Host-observed value.
 * @returns Bound position and absolute distance from the violated bound.
 */
export function assessBoundedMetric(
  min: number | null,
  max: number | null,
  measured: number,
): { readonly status: 'met' | 'below' | 'above'; readonly difference: number } {
  if (min !== null && measured < min) return { status: 'below', difference: min - measured }
  if (max !== null && measured > max) return { status: 'above', difference: measured - max }
  return { status: 'met', difference: 0 }
}

/**
 * Count non-whitespace Unicode code points without language-specific token guessing.
 * @param markdown Chapter or document Markdown.
 * @returns Number of non-whitespace Unicode code points.
 */
export function countNonWhitespaceCharacters(markdown: string): number {
  return Array.from(markdown).filter(character => !/\s/u.test(character)).length
}

/**
 * Evaluate only explicit Host discriminators; criterion descriptions never select code paths.
 * @param criteria Current scoped acceptance criteria.
 * @param context Host-observed text and layout measurements.
 * @returns Deterministic results in criterion order; semantic criteria are omitted.
 */
export function evaluateHostAcceptanceCriteria(
  criteria: readonly AcceptanceCriterion[],
  context: HostAcceptanceContext,
): HostAcceptanceResult[] {
  return criteria.flatMap((criterion): HostAcceptanceResult[] => {
    const evaluator = criterion.evaluator
    if (evaluator.kind !== 'deterministic') return []
    const measured = evaluator.metric === 'estimated_pages'
      ? context.estimatedPages
      : context.markdown === undefined ? undefined : countNonWhitespaceCharacters(context.markdown)
    return [{
      criterion_id: criterion.id,
      status: measured === undefined ? 'unavailable' : withinBounds(measured, evaluator.min, evaluator.max) ? 'met' : 'unmet',
      measured: measured ?? null,
      message: measured === undefined
        ? `${evaluator.metric} 无法测量。`
        : `${evaluator.metric}=${measured.toFixed(4)}，范围 ${evaluator.min ?? '-∞'}…${evaluator.max ?? '+∞'}。`,
    }]
  })
}
