import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Version of the Host-owned Bid Web evidence source ledger. */
export const WEB_EVIDENCE_SOURCES_SCHEMA_VERSION = 2 as const

const httpUrl = z.url().refine(value => normalizeWebEvidenceUrl(value) !== undefined, {
  message: 'Web evidence URL must use http or https',
})

const sourceSchema = z.object({
  source_id: z.string().regex(/^WEB-[a-f0-9]{16}$/u),
  requested_url: httpUrl,
  final_url: httpUrl,
  status_code: z.number().int().min(200).max(299),
  truncated: z.boolean(),
  fetched_at: z.iso.datetime({ offset: true }),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  snapshot_path: z.string().regex(/^analysis\/web-sources\/WEB-[a-f0-9]{16}\.md$/u),
  chapter_context: z.object({
    section_id: z.string().min(1),
    child_session_id: z.string().min(1),
    writer_attempt: z.number().int().positive(),
  }).strict().optional(),
}).strict().superRefine((source, context) => {
  if (source.snapshot_path !== `analysis/web-sources/${source.source_id}.md`) {
    context.addIssue({ code: 'custom', message: 'Snapshot path must be owned by its source id' })
  }
})

const ledgerSchema = z.object({
  schema_version: z.literal(WEB_EVIDENCE_SOURCES_SCHEMA_VERSION),
  stage: z.literal('evidence_mapping'),
  sources: z.array(sourceSchema),
}).strict().superRefine((ledger, context) => {
  const sourceIds = new Set<string>()
  for (const [index, source] of ledger.sources.entries()) {
    if (sourceIds.has(source.source_id)) context.addIssue({ code: 'custom', path: ['sources', index, 'source_id'], message: 'Source id must be unique' })
    sourceIds.add(source.source_id)
  }
})

/** Host 保存的成功 Web fetch 正文来源。 */
export type WebEvidenceSource = z.infer<typeof sourceSchema>
/** S4 与 S5 共用的 Web 正文快照清单。 */
export type WebEvidenceSourcesArtifact = z.infer<typeof ledgerSchema>

/**
 * Parse a Host-owned Web evidence ledger through the strict current schema.
 * @param value - untrusted JSON value read from the Project Workspace.
 * @returns the validated current ledger.
 */
export function parseWebEvidenceSourcesArtifact(value: unknown): WebEvidenceSourcesArtifact {
  return ledgerSchema.parse(value)
}

/**
 * Normalize an HTTP(S) URL for exact source matching.
 * @param value - candidate absolute URL.
 * @returns the fragment-free standard serialization, or `undefined` for an invalid or unsupported URL.
 */
export function normalizeWebEvidenceUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Compute the lowercase SHA-256 digest of the exact UTF-8 snapshot text.
 * @param content - text persisted in the Host-owned snapshot.
 * @returns a 64-character lowercase hexadecimal digest.
 */
export function webEvidenceContentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Derive a stable, filename-safe source id from one fetched page.
 * @param finalUrl - provider-returned final URL.
 * @param contentSha256 - digest of the model-visible snapshot text.
 * @returns the `WEB-` prefixed short digest used by the ledger and snapshot filename.
 */
export function webEvidenceSourceId(finalUrl: string, contentSha256: string): string {
  const digest = createHash('sha256').update(`${finalUrl}\0${contentSha256}`, 'utf8').digest('hex')
  return `WEB-${digest.slice(0, 16)}`
}
