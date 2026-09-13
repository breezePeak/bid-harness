import type { BidRunSnapshot, StageValidationIssue } from './control-plane-contract.ts'

const SECRET = /(?:authorization\s*[:=]\s*bearer\s+|bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/giu
const PROVIDER_PAYLOAD = /(?:provider\s+(?:payload|response)|raw\s+(?:payload|response))\s*[:=][\s\S]*/giu

/**
 * Remove credentials and provider payloads from one browser-visible diagnostic.
 * @param value - Untrusted diagnostic text.
 * @returns Length-bounded browser-safe text.
 */
export function sanitizeBidErrorText(value: string): string {
  const sanitized = value.replace(SECRET, '$1[REDACTED]').replace(PROVIDER_PAYLOAD, 'provider response: [REDACTED]').trim()
  return sanitized.slice(0, 2_000) || 'Bid Run 执行失败。'
}

/**
 * Convert an execution failure into the only durable, browser-safe error shape.
 * @param error - Untrusted execution failure.
 * @param issues - Structured validation issues to sanitize when present.
 * @returns Durable error payload safe for browser projection.
 */
export function safeBidRunError(
  error: unknown,
  issues?: readonly StageValidationIssue[],
): NonNullable<BidRunSnapshot['error']> {
  const candidate = error as { code?: unknown; message?: unknown }
  const code = typeof candidate.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(candidate.code)
    ? candidate.code
    : 'BID_EXECUTOR_ERROR'
  const message = sanitizeBidErrorText(typeof candidate.message === 'string' ? candidate.message : String(error))
  return {
    code,
    message,
    ...(issues === undefined ? {} : {
      issues: issues.map(issue => ({
        code: sanitizeBidErrorText(issue.code),
        message: sanitizeBidErrorText(issue.message),
        ...(issue.artifact === undefined ? {} : { artifact: sanitizeBidErrorText(issue.artifact) }),
        ...(issue.path === undefined ? {} : { path: sanitizeBidErrorText(issue.path) }),
      })),
    }),
  }
}
