import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StageValidationIssue } from './control-plane-contract.ts'
import { parseDocumentChunkIndex } from './document-chunk.ts'
import type { BidWorkspace, ManifestFile } from './index.ts'
import type { OutlineArtifact, OutlineFrameworkRef } from './outline-generation-artifacts.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/** One Host-parsed heading from an imported outline framework. */
export interface OutlineFrameworkHeading {
  readonly title: string
  readonly level: number
  readonly heading_path: readonly string[]
  readonly order: number
}

/** One imported framework tree in manifest order. */
export interface OutlineFrameworkStructure {
  readonly file_id: string
  readonly name: string
  readonly headings: readonly OutlineFrameworkHeading[]
}

function parseFrameworkStructure(value: unknown): OutlineFrameworkHeading[] {
  if (typeof value !== 'object' || value === null || !('sections' in value) || !Array.isArray(value.sections)) {
    throw new Error('outline-framework-structure-invalid')
  }
  return value.sections.map((section) => {
    if (typeof section !== 'object' || section === null) throw new Error('outline-framework-structure-invalid')
    const record = section as Record<string, unknown>
    if (typeof record.title !== 'string' || record.title.trim().length === 0
      || typeof record.level !== 'number' || !Number.isSafeInteger(record.level) || record.level < 1
      || typeof record.order !== 'number' || !Number.isSafeInteger(record.order) || record.order < 1
      || !Array.isArray(record.heading_path)
      || record.heading_path.some(heading => typeof heading !== 'string' || heading.trim().length === 0)) {
      throw new Error('outline-framework-structure-invalid')
    }
    return {
      title: record.title,
      level: record.level,
      heading_path: record.heading_path as string[],
      order: record.order,
    }
  })
}

async function readFrameworkHeadings(workspace: BidWorkspace, file: ManifestFile): Promise<OutlineFrameworkHeading[]> {
  if (file.structurePath !== null) {
    const path = within(workspace.projectRoot, file.structurePath)
    await assertNoLinkedPath(workspace.root, path)
    return parseFrameworkStructure(JSON.parse(await readFile(path, 'utf8')))
  }
  if (file.chunkIndexPath === null) throw new Error('outline-framework-chunk-index-missing')
  const path = within(workspace.projectRoot, file.chunkIndexPath)
  await assertNoLinkedPath(workspace.root, path)
  const index = parseDocumentChunkIndex(JSON.parse(await readFile(path, 'utf8')))
  const headings = new Map<string, OutlineFrameworkHeading>()
  for (const chunk of index.chunks) {
    for (let level = 1; level <= chunk.heading_path.length; level++) {
      const headingPath = chunk.heading_path.slice(0, level)
      const key = headingPath.join('\u0000')
      if (!headings.has(key)) headings.set(key, {
        title: headingPath.at(-1) ?? '', level, heading_path: headingPath, order: headings.size + 1,
      })
    }
  }
  return [...headings.values()]
}

/**
 * Read successful outline frameworks as ordered heading trees.
 * @param workspace - project workspace containing the imported framework files.
 * @returns framework heading trees in manifest order.
 */
export async function loadOutlineFrameworkStructures(workspace: BidWorkspace): Promise<OutlineFrameworkStructure[]> {
  const manifest = await workspace.readManifest()
  return Promise.all(manifest.files
    .filter(file => file.role === 'outline_framework' && file.parseStatus === 'success')
    .map(async file => ({
      file_id: String(file.id),
      name: file.originalName,
      headings: await readFrameworkHeadings(workspace, file),
    })))
}

/**
 * Validate only the durable file and heading identities carried by framework references.
 * @param workspace - project workspace containing the imported framework files.
 * @param outline - outline whose Section references require validation.
 * @param issues - mutable deterministic validation issue sink.
 * @returns nothing.
 */
export async function validateOutlineFrameworkRefs(
  workspace: BidWorkspace,
  outline: OutlineArtifact,
  issues: StageValidationIssue[],
): Promise<void> {
  const frameworks = await loadOutlineFrameworkStructures(workspace)
  const headings = new Map(frameworks.map(framework => [framework.file_id,
    new Set(framework.headings.map(heading => heading.heading_path.join('\u0000')))]))
  for (const section of outline.sections) {
    const references = section.framework_refs ?? []
    const identities = references.map(reference => `${reference.file_id}\u0000${reference.heading_path.join('\u0000')}`)
    if (new Set(identities).size !== identities.length) issues.push({
      code: 'OUTLINE_FRAMEWORK_REF_DUPLICATE', message: `Section ${section.id} repeats a framework reference.`, artifact: 'outline/outline.json',
    })
    for (const reference of references) {
      if (!headings.get(reference.file_id)?.has(reference.heading_path.join('\u0000'))) issues.push({
        code: 'OUTLINE_FRAMEWORK_REF_INVALID', message: `Section ${section.id} references an unknown outline-framework heading.`, artifact: 'outline/outline.json',
      })
    }
  }
}

/** One framework draft chunk available to S5 as user-authored writing input, not Evidence. */
export interface FrameworkDraftMaterial {
  readonly file_id: string
  readonly heading_path: readonly string[]
  readonly chunk: string
  readonly chunk_path: string
  readonly chunk_index_path: string
}

/**
 * Resolve exact-heading framework chunks without treating them as factual Evidence.
 * @param workspace - project workspace containing the imported framework files.
 * @param refs - exact framework file and heading references from one Section.
 * @returns matching draft chunks with validated absolute paths.
 */
export async function resolveFrameworkDraftMaterials(
  workspace: BidWorkspace,
  refs: readonly OutlineFrameworkRef[],
): Promise<FrameworkDraftMaterial[]> {
  const manifest = await workspace.readManifest()
  const materials: FrameworkDraftMaterial[] = []
  for (const reference of refs) {
    const file = manifest.files.find(candidate => String(candidate.id) === reference.file_id
      && candidate.role === 'outline_framework' && candidate.parseStatus === 'success')
    if (file?.chunkIndexPath === null || file?.chunkIndexPath === undefined || file.chunksPath === null) continue
    const indexPath = within(workspace.projectRoot, file.chunkIndexPath)
    await assertNoLinkedPath(workspace.root, indexPath)
    const index = parseDocumentChunkIndex(JSON.parse(await readFile(indexPath, 'utf8')))
    for (const chunk of index.chunks.filter(candidate => candidate.heading_path.length === reference.heading_path.length
      && candidate.heading_path.every((heading, index) => heading === reference.heading_path[index]))) {
      const chunkPath = join(workspace.projectRoot, file.chunksPath, chunk.path)
      await assertNoLinkedPath(workspace.root, chunkPath)
      materials.push({
        file_id: reference.file_id, heading_path: [...reference.heading_path], chunk: chunk.id,
        chunk_path: chunkPath, chunk_index_path: indexPath,
      })
    }
  }
  return [...new Map(materials.map(material => [`${material.file_id}\u0000${material.chunk}`, material])).values()]
}
