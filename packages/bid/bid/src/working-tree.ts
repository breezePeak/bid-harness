import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { BidWorkDescriptor } from './control-plane-contract.ts'
import { reconcileBidPublications } from './publication-batch.ts'
import type { BidCommitLease, BidRunContext } from './run-coordinator.ts'
import { bidWorkRoot } from './work-descriptor.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

interface WorkspacePaths {
  readonly root: string
  readonly projectRoot: string
}

const EXCLUDED_PROJECT_ENTRIES = new Set(['.publications', 'project-state.json', 'requests', 'runs'])

function relativeProjectRoot(workspace: WorkspacePaths): string {
  const value = relative(workspace.root, workspace.projectRoot)
  if (value === '' || value === '..' || value.startsWith(`..${sep}`)) throw new Error('BID_PROJECT_ROOT_INVALID')
  return value
}

async function copyRegularTree(workspaceRoot: string, source: string, target: string): Promise<void> {
  await assertNoLinkedPath(workspaceRoot, source)
  const metadata = await lstat(source)
  if (metadata.isSymbolicLink()) throw new Error('bid-linked-path-not-allowed')
  if (metadata.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(source)) {
      await copyRegularTree(workspaceRoot, resolve(source, entry), resolve(target, entry))
    }
    return
  }
  if (!metadata.isFile()) throw new Error('BID_WORKING_TREE_ENTRY_INVALID')
  await writeFileAtomic(target, await readFile(source), { mode: 0o600, dirMode: 0o700 })
}

/**
 * Prepare or reopen the durable private project used by one exact work item.
 * @param workspace - Canonical workspace used as the initial snapshot.
 * @param descriptor - Work identity bound to the private project.
 * @param options - Reset a candidate whose previous attempt did not publish a receipt.
 * @returns Private workspace paths for execution and resume.
 */
export async function prepareBidWorkingTree(
  workspace: WorkspacePaths,
  descriptor: BidWorkDescriptor,
  options: { readonly reset?: boolean } = {},
): Promise<WorkspacePaths> {
  const root = bidWorkRoot(workspace, descriptor)
  const markerPath = within(root, 'work-identity.json')
  const projectRoot = resolve(root, relativeProjectRoot(workspace))
  await assertNoLinkedPath(workspace.root, root)
  try {
    const saved = JSON.parse(await readFile(markerPath, 'utf8')) as unknown
    if (JSON.stringify(saved) !== JSON.stringify(descriptor)) throw new Error('BID_WORKING_TREE_IDENTITY_MISMATCH')
    if (!options.reset) {
      await reconcileBidPublications(root, projectRoot)
      return { root, projectRoot }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  await rm(root, { recursive: true, force: true })
  await mkdir(projectRoot, { recursive: true, mode: 0o700 })
  let entries: string[] = []
  try { entries = await readdir(workspace.projectRoot) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const entry of entries) {
    if (EXCLUDED_PROJECT_ENTRIES.has(entry)) continue
    await copyRegularTree(workspace.root, resolve(workspace.projectRoot, entry), resolve(projectRoot, entry))
  }
  await writeFileAtomic(markerPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  return { root, projectRoot }
}

async function stageWorkingEntry(
  lease: BidCommitLease,
  workingRoot: string,
  source: string,
  destination: string,
): Promise<void> {
  await assertNoLinkedPath(workingRoot, source)
  let metadata
  try { metadata = await lstat(source) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await lease.remove(destination, true)
      return
    }
    throw error
  }
  if (metadata.isSymbolicLink()) throw new Error('bid-linked-path-not-allowed')
  if (metadata.isDirectory()) {
    await lease.remove(destination, true)
    const visit = async (from: string, to: string): Promise<void> => {
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const childSource = resolve(from, entry.name)
        const childDestination = resolve(to, entry.name)
        if (entry.isSymbolicLink()) throw new Error('bid-linked-path-not-allowed')
        if (entry.isDirectory()) await visit(childSource, childDestination)
        else if (entry.isFile()) await lease.writeBytes(childDestination, await readFile(childSource))
        else throw new Error('BID_WORKING_TREE_ENTRY_INVALID')
      }
    }
    await visit(source, destination)
    return
  }
  if (!metadata.isFile()) throw new Error('BID_WORKING_TREE_ENTRY_INVALID')
  await lease.writeBytes(destination, await readFile(source))
}

/**
 * Publish selected private candidate paths through the canonical Run CommitScope.
 * @param run - Run that owns canonical commit authority.
 * @param canonical - Canonical destination workspace.
 * @param working - Private candidate workspace.
 * @param paths - Candidate-relative files or directories to publish.
 * @param removePaths - Canonical-relative paths to remove in the same publication.
 */
export async function publishBidWorkingPaths(
  run: BidRunContext,
  canonical: WorkspacePaths,
  working: WorkspacePaths,
  paths: readonly string[],
  removePaths: readonly string[] = [],
): Promise<void> {
  await run.commits.publish(async (lease) => {
    for (const path of paths) {
      await stageWorkingEntry(
        lease,
        working.root,
        within(working.projectRoot, path),
        within(canonical.projectRoot, path),
      )
    }
    for (const path of removePaths) await lease.remove(within(canonical.projectRoot, path), true)
  })
}
