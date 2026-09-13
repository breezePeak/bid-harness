import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const entrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('write'), path: z.string().min(1), staged: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('remove'), path: z.string().min(1), recursive: z.boolean() }).strict(),
])
const manifestSchema = z.object({
  schema_version: z.literal(1),
  publication_id: z.string().min(1),
  entries: z.array(entrySchema),
}).strict()
type PublicationManifest = z.infer<typeof manifestSchema>

/** Writes accepted by one crash-recoverable logical publication. */
export interface BidPublicationLease {
  writeText(path: string, value: string): Promise<void>
  writeJson(path: string, value: unknown): Promise<void>
  writeBytes(path: string, value: Uint8Array): Promise<void>
  remove(path: string, recursive?: boolean): Promise<void>
}

function publicationRoot(projectRoot: string): string { return resolve(projectRoot, '.publications') }

function destination(projectRoot: string, path: string): { absolute: string; relative: string } {
  const absolute = resolve(path)
  const child = relative(projectRoot, absolute)
  const samePath = (left: string, right: string) => process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || !samePath(resolve(projectRoot, child), absolute)) {
    throw new Error('BID_PUBLICATION_PATH_OUTSIDE_PROJECT')
  }
  return { absolute, relative: child.replaceAll('\\', '/') }
}

async function applyManifest(
  workspaceRoot: string,
  projectRoot: string,
  transactionRoot: string,
  manifest: PublicationManifest,
): Promise<void> {
  for (const entry of manifest.entries) {
    const target = within(projectRoot, entry.path)
    await assertNoLinkedPath(workspaceRoot, target)
    if (entry.kind === 'remove') {
      await rm(target, { recursive: entry.recursive, force: true })
      continue
    }
    const bytes = await readFile(within(transactionRoot, entry.staged))
    await writeFileAtomic(target, bytes, { mode: 0o600, dirMode: 0o700 })
  }
}

/**
 * Reconcile every publication before project state is read; prepared batches are discarded and batches with commit intent roll forward.
 * @param workspaceRoot - Security boundary used for linked-path checks.
 * @param projectRoot - Project containing publication recovery records.
 */
export async function reconcileBidPublications(workspaceRoot: string, projectRoot: string): Promise<void> {
  const root = publicationRoot(projectRoot)
  await assertNoLinkedPath(workspaceRoot, root)
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error('BID_PUBLICATION_ENTRY_INVALID')
    const transactionRoot = within(root, entry.name)
    const intentPath = within(transactionRoot, 'commit-intent')
    const committedPath = within(transactionRoot, 'committed')
    let committed = false
    let intent = false
    try { await readFile(committedPath); committed = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try { await readFile(intentPath); intent = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!committed && intent) {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(within(transactionRoot, 'manifest.json'), 'utf8')))
      await applyManifest(workspaceRoot, projectRoot, transactionRoot, manifest)
      await writeFileAtomic(committedPath, 'committed\n', { mode: 0o600, dirMode: 0o700 })
    }
    await rm(transactionRoot, { recursive: true, force: true })
  }
}

/**
 * Stage, commit, and clean up one crash-recoverable multi-file publication.
 * @param workspaceRoot - Security boundary used for linked-path checks.
 * @param projectRoot - Project that owns every publication destination.
 * @param write - Callback that stages the complete logical publication.
 * @returns Callback result after the publication is durable.
 */
export async function publishBidBatch<T>(
  workspaceRoot: string,
  projectRoot: string,
  write: (lease: BidPublicationLease) => Promise<T>,
): Promise<T> {
  const id = randomUUID()
  const transactionRoot = resolve(publicationRoot(projectRoot), id)
  const stagedRoot = resolve(transactionRoot, 'staged')
  await assertNoLinkedPath(workspaceRoot, transactionRoot)
  await mkdir(stagedRoot, { recursive: true, mode: 0o700 })
  const entries = new Map<string, z.infer<typeof entrySchema>>()
  let ordinal = 0
  const lease: BidPublicationLease = {
    async writeText(path, value) { await this.writeBytes(path, Buffer.from(value)) },
    async writeJson(path, value) { await this.writeText(path, `${JSON.stringify(value, null, 2)}\n`) },
    async writeBytes(path, value) {
      const target = destination(projectRoot, path)
      const staged = `staged/${String(++ordinal).padStart(6, '0')}`
      await writeFileAtomic(within(transactionRoot, staged), value, { mode: 0o600, dirMode: 0o700 })
      entries.set(target.relative, { kind: 'write', path: target.relative, staged })
    },
    remove(path, recursive = false) {
      const target = destination(projectRoot, path)
      entries.set(target.relative, { kind: 'remove', path: target.relative, recursive })
      return Promise.resolve()
    },
  }
  try {
    const result = await write(lease)
    const manifest = manifestSchema.parse({ schema_version: 1, publication_id: id, entries: [...entries.values()] })
    await writeFileAtomic(resolve(transactionRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    await writeFileAtomic(resolve(transactionRoot, 'commit-intent'), 'commit\n', { mode: 0o600, dirMode: 0o700 })
    await applyManifest(workspaceRoot, projectRoot, transactionRoot, manifest)
    await writeFileAtomic(resolve(transactionRoot, 'committed'), 'committed\n', { mode: 0o600, dirMode: 0o700 })
    await rm(transactionRoot, { recursive: true, force: true })
    return result
  } catch (error) {
    // A committed intent is recovery state, not temporary cleanup.
    try { await readFile(resolve(transactionRoot, 'commit-intent')) } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') await rm(transactionRoot, { recursive: true, force: true })
    }
    throw error
  }
}
