import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { recordOnlySchemaVersion } from './schema-version.ts'
import type { BidCommitLease } from './run-coordinator.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const commandSchema = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'applied']),
  command: z.unknown(),
}).strict()
const journalSchema = z.object({ schema_version: recordOnlySchemaVersion(1), commands: z.array(commandSchema) }).strict()
/** One durable S5 command and whether its canonical publication completed. */
export type BidChapterCommandRecord = z.infer<typeof commandSchema>

type JournalWorkspace = { readonly root: string; readonly projectRoot: string }

function pathFor(workspace: JournalWorkspace, workId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workId)) throw new Error('BID_WORK_ID_INVALID')
  return join(workspace.projectRoot, 'runs', workId, 'commands.json')
}

/**
 * Read the durable S5 command journal; a missing journal is empty.
 * @param workspace - Workspace that owns the command journal.
 * @param workId - Work identity whose commands are read.
 * @returns Persisted commands in admission order.
 */
export async function readBidChapterCommandJournal(
  workspace: JournalWorkspace,
  workId: string,
): Promise<BidChapterCommandRecord[]> {
  const path = pathFor(workspace, workId)
  await assertNoLinkedPath(workspace.root, path)
  try { return journalSchema.parse(JSON.parse(await readFile(path, 'utf8'))).commands } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Atomically replace the command journal inside its owning Run or ProjectMutation publication.
 * @param workspace - Workspace that owns the command journal.
 * @param workId - Work identity whose commands are replaced.
 * @param commands - Complete next journal contents.
 * @param lease - Existing publication lease that groups commands with their artifacts.
 */
export async function writeBidChapterCommandJournal(
  workspace: JournalWorkspace,
  workId: string,
  commands: readonly BidChapterCommandRecord[],
  lease: BidCommitLease,
): Promise<void> {
  const path = pathFor(workspace, workId)
  await assertNoLinkedPath(workspace.root, path)
  const value = journalSchema.parse({ schema_version: 1, commands })
  await lease.writeJson(path, value)
}
