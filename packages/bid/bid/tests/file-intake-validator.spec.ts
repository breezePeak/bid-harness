import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BidWorkspace,
  validateFileIntake,
  type BidManifest,
  type IncomingFile,
  type ImportedFile,
  type StageValidationResult,
} from '@deepseek-ai/dsh-bid'

const artifact = [{ stage: 'file_intake', type: 'manifest', path: 'manifest.json' }] as const
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

function issueCodes(result: StageValidationResult): string[] {
  if (result.ok) return []
  return result.issues.map(issue => issue.code)
}

async function textBatch(...names: string[]): Promise<{
  workspace: BidWorkspace
  imported: ImportedFile[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-validator-'))
  const workspace = new BidWorkspace(root)
  const imported = await workspace.import(names.map(name => ({
    name,
    bytes: new TextEncoder().encode(`# ${name}\n\n有效内容。`),
  })))
  return { workspace, imported }
}

describe('file-intake validator', () => {
  it('accepts complete single-file and multi-file batches', async () => {
    for (const names of [['single.txt'], ['first.txt', 'second.md']]) {
      const { workspace, imported } = await textBatch(...names)
      await expect(validateFileIntake(workspace, imported, 'file_intake', [...artifact]))
        .resolves.toEqual({ ok: true })
    }
  })

  it('rejects a selected reference bid that the importer did not return', async () => {
    const { workspace, imported } = await textBatch('tender.txt')
    const expected: IncomingFile[] = [
      { name: 'tender.txt', role: 'tender', bytes: new TextEncoder().encode('# tender.txt\n\n有效内容。') },
      { name: 'reference-bid.txt', role: 'reference_bid', bytes: new TextEncoder().encode('参考旧标书') },
    ]

    expect(issueCodes(await validateFileIntake(workspace, imported, 'file_intake', [...artifact], expected)))
      .toContain('FILE_INTAKE_SELECTED_FILE_MISSING')
  })

  it('rejects missing, malformed, stale, and batch-incomplete manifests', async () => {
    const missing = await textBatch('missing.txt')
    await rm(missing.workspace.manifestPath)
    expect(issueCodes(await validateFileIntake(missing.workspace, missing.imported, 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_MANIFEST_MISSING')

    const malformed = await textBatch('malformed.txt')
    await writeFile(malformed.workspace.manifestPath, '{')
    expect(issueCodes(await validateFileIntake(malformed.workspace, malformed.imported, 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_MANIFEST_INVALID')

    const stale = await textBatch('stale.txt')
    await writeFile(stale.workspace.manifestPath, JSON.stringify({ version: 2, files: [] }))
    expect(issueCodes(await validateFileIntake(stale.workspace, stale.imported, 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_MANIFEST_VERSION_UNSUPPORTED')

    const incomplete = await textBatch('unrecorded.txt')
    await writeFile(incomplete.workspace.manifestPath, JSON.stringify({ version: 4, files: [] }))
    expect(issueCodes(await validateFileIntake(incomplete.workspace, incomplete.imported, 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_MANIFEST_RECORD_MISSING')
    expect(issueCodes(await validateFileIntake(incomplete.workspace, [], 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_BATCH_EMPTY')

    const changed = await textBatch('changed.txt')
    const changedManifest = JSON.parse(await readFile(changed.workspace.manifestPath, 'utf8')) as BidManifest
    changedManifest.files[0]!.corpusPath = 'corpus/another-file'
    await writeFile(changed.workspace.manifestPath, JSON.stringify(changedManifest))
    expect(issueCodes(await validateFileIntake(changed.workspace, changed.imported, 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_MANIFEST_RECORD_MISSING')
  })

  it('rejects missing documents, indexes, chunk files, and invalid chunk indexes', async () => {
    const document = await textBatch('document.txt')
    await rm(document.imported[0]!.absoluteDocumentPath!)
    expect(issueCodes(await validateFileIntake(document.workspace, document.imported, 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_DOCUMENT_MISSING')

    const index = await textBatch('index.txt')
    await rm(index.imported[0]!.absoluteChunkIndexPath!)
    expect(issueCodes(await validateFileIntake(index.workspace, index.imported, 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_CHUNK_INDEX_MISSING')

    const invalidIndex = await textBatch('invalid-index.txt')
    await writeFile(invalidIndex.imported[0]!.absoluteChunkIndexPath!, '{}')
    expect(issueCodes(await validateFileIntake(invalidIndex.workspace, invalidIndex.imported, 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_CHUNK_INDEX_INVALID')

    const chunk = await textBatch('chunk.txt')
    const parsed = JSON.parse(await readFile(chunk.imported[0]!.absoluteChunkIndexPath!, 'utf8')) as {
      chunks: Array<{ path: string }>
    }
    await rm(join(dirname(chunk.imported[0]!.absoluteChunkIndexPath!), parsed.chunks[0]!.path))
    expect(issueCodes(await validateFileIntake(chunk.workspace, chunk.imported, 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_CHUNK_MISSING')
  })

  it('rejects path traversal, missing artifacts, and missing document sidecars', async () => {
    const traversed = await textBatch('traversed.txt')
    const manifest = JSON.parse(await readFile(traversed.workspace.manifestPath, 'utf8')) as BidManifest
    manifest.files[0]!.documentPath = '../outside.md'
    await writeFile(traversed.workspace.manifestPath, JSON.stringify(manifest))
    const matchingBatch = [{ ...traversed.imported[0]!, documentPath: '../outside.md' }]
    expect(issueCodes(await validateFileIntake(traversed.workspace, matchingBatch, 'file_intake', [
      ...artifact,
      { stage: 'file_intake', type: 'other', path: '../outside.json' },
    ]))).toContain('FILE_INTAKE_PATH_OUTSIDE_PROJECT')
    expect(issueCodes(await validateFileIntake(traversed.workspace, matchingBatch, 'file_intake', [])))
      .toContain('FILE_INTAKE_MANIFEST_ARTIFACT_MISSING')
    expect(issueCodes(await validateFileIntake(traversed.workspace, matchingBatch, 'file_intake', [
      { stage: 'file_intake', type: 'other', path: 'manifest.json' },
    ]))).toContain('FILE_INTAKE_MANIFEST_ARTIFACT_MISSING')

    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-validator-'))
    const office = new BidWorkspace(root)
    const imported = await office.import([{
      name: '历史投标书.doc',
      bytes: await readFile(fixture('bid-document.doc')),
    }])
    await rm(imported[0]!.absoluteStructurePath!)
    expect(issueCodes(await validateFileIntake(office, imported, 'file_intake', [...artifact])))
      .toContain('FILE_INTAKE_STRUCTURE_MISSING')
  })

  it('requires one successfully parsed tender but ignores other settled parse failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-validator-'))
    const workspace = new BidWorkspace(root)
    const imported = await workspace.import([
      { name: '扫描件.pdf', bytes: await readFile(fixture('scanned-document.pdf')) },
      { name: '损坏.txt', bytes: new Uint8Array([0xff]) },
    ])
    expect(issueCodes(await validateFileIntake(workspace, imported, 'file_intake', [...artifact])))
      .toEqual(['FILE_INTAKE_NO_SUCCESSFUL_TENDER'])

    const mixed = new BidWorkspace(root)
    const mixedImported = await mixed.import([
      { name: '有效招标.txt', role: 'tender', bytes: new TextEncoder().encode('有效招标内容') },
      { name: '扫描件.pdf', role: 'reference', bytes: await readFile(fixture('scanned-document.pdf')) },
      { name: '损坏.txt', role: 'reference', bytes: new Uint8Array([0xff]) },
    ])
    await expect(validateFileIntake(mixed, mixedImported, 'file_intake', [...artifact]))
      .resolves.toEqual({ ok: true })
  })
})
