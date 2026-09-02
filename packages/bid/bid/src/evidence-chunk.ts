import { lstat, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { evidenceChunkId, parseDocumentChunkIndex, type DocumentChunkEntry } from './document-chunk.ts'
import type { LocalEvidenceMaterial } from './evidence-mapping-artifacts.ts'
import type { BidManifest, BidWorkspace, ManifestFile } from './index.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/** Host-resolved canonical location for one local Evidence reference. */
export interface ResolvedEvidenceChunk {
  file: ManifestFile
  entry: DocumentChunkEntry
  path: string
}

/**
 * Resolve local Evidence by exact source role, file id, and chunk id.
 * @param workspace - Session-scoped Bid workspace.
 * @param manifest - current validated manifest.
 * @param material - local Evidence reference.
 * @returns the owning manifest file, indexed entry, and Host-canonical absolute path.
 * @throws when the file is unavailable or its own chunk index does not contain the referenced id.
 */
export async function resolveEvidenceChunk(
  workspace: BidWorkspace,
  manifest: BidManifest,
  material: Pick<LocalEvidenceMaterial, 'source_kind' | 'file_id' | 'chunk'>,
): Promise<ResolvedEvidenceChunk> {
  const file = manifest.files.find(candidate => String(candidate.id) === material.file_id
    && candidate.role === material.source_kind)
  if (file === undefined || file.parseStatus !== 'success'
    || file.chunksPath === null || file.chunkIndexPath === null) {
    throw new Error('evidence-chunk-file-invalid')
  }
  const chunkId = evidenceChunkId(material.chunk)
  if (chunkId === undefined) throw new Error('evidence-chunk-id-invalid')
  const indexPath = within(workspace.sessionRoot, file.chunkIndexPath)
  await assertNoLinkedPath(workspace.root, indexPath)
  const index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
  const entry = index.chunks.find(candidate => candidate.id === chunkId)
  if (entry === undefined) throw new Error('evidence-chunk-id-unknown')
  const path = within(workspace.sessionRoot, posix.join(file.chunksPath, entry.path))
  await assertNoLinkedPath(workspace.root, path)
  if (!(await lstat(path)).isFile()) throw new Error('evidence-chunk-file-invalid')
  return { file, entry, path }
}
