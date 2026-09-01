import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { evidenceChunkId, parseDocumentChunkIndex, type DocumentChunkEntry } from './document-chunk.ts'
import type { DocumentSection } from './document-extract.ts'
import type { EvidenceMaterial } from './evidence-mapping-artifacts.ts'
import type { BidManifest, BidWorkspace, ManifestFile } from './index.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/** Host-resolved canonical location for one local Evidence reference. */
export interface ResolvedEvidenceChunk {
  file: ManifestFile
  entry: DocumentChunkEntry
  path: string
}

/** Host-resolved source heading from a parsed framework or reference bid. */
export interface ResolvedEvidenceSourceSection {
  file: ManifestFile
  section: DocumentSection
}

async function readSourceSections(workspace: BidWorkspace, file: ManifestFile): Promise<DocumentSection[]> {
  if (file.structurePath !== null) {
    const structurePath = within(workspace.sessionRoot, file.structurePath)
    await assertNoLinkedPath(workspace.root, structurePath)
    const raw = JSON.parse(await readFile(structurePath, 'utf8')) as { sections?: unknown }
    if (!Array.isArray(raw.sections)) throw new Error('evidence-source-structure-invalid')
    return raw.sections as DocumentSection[]
  }
  if (file.chunkIndexPath === null) return []
  const indexPath = within(workspace.sessionRoot, file.chunkIndexPath)
  await assertNoLinkedPath(workspace.root, indexPath)
  const index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
  const headings = new Map<string, DocumentSection>()
  for (const chunk of index.chunks) {
    for (let level = 1; level <= chunk.heading_path.length; level++) {
      const headingPath = chunk.heading_path.slice(0, level)
      const key = headingPath.join('\u0000')
      if (!headings.has(key)) headings.set(key, {
        id: `derived_${String(headings.size + 1).padStart(3, '0')}`,
        parent_id: null,
        level,
        title: headingPath.at(-1) ?? '',
        page_start: null,
        page_end: null,
        heading_path: headingPath,
        order: headings.size + 1,
      })
    }
  }
  return [...headings.values()]
}

/**
 * Resolve source metadata that the Evidence Map identifies only by file and section id.
 * @param workspace - Session-scoped Bid workspace.
 * @param manifest - current validated manifest.
 * @param source - source file and section identity.
 * @param role - required special-asset role.
 * @returns the owning file and Host-authoritative section metadata.
 */
export async function resolveEvidenceSourceSection(
  workspace: BidWorkspace,
  manifest: BidManifest,
  source: { file_id: string; source_section_id: string },
  role: 'outline_framework' | 'reference_bid',
): Promise<ResolvedEvidenceSourceSection> {
  const file = manifest.files.find(candidate => String(candidate.id) === source.file_id)
  if (file === undefined || file.role !== role || file.parseStatus !== 'success') throw new Error('evidence-source-file-invalid')
  const section = (await readSourceSections(workspace, file)).find(candidate => candidate.id === source.source_section_id)
  if (section === undefined) throw new Error('evidence-source-section-invalid')
  return { file, section }
}

/**
 * Resolve local Evidence by exact `file_id + chunk id`.
 * @param workspace - Session-scoped Bid workspace.
 * @param manifest - current validated manifest.
 * @param material - local Evidence reference.
 * @returns the owning manifest file, indexed entry, and Host-canonical absolute path.
 * @throws when the file is unavailable or its own chunk index does not contain the referenced id.
 */
export async function resolveEvidenceChunk(
  workspace: BidWorkspace,
  manifest: BidManifest,
  material: Pick<EvidenceMaterial, 'file_id' | 'chunk'>,
): Promise<ResolvedEvidenceChunk> {
  const file = manifest.files.find(candidate => String(candidate.id) === material.file_id)
  if (file === undefined || file.parseStatus !== 'success' || file.chunksPath === null || file.chunkIndexPath === null) {
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
  return { file, entry, path }
}
