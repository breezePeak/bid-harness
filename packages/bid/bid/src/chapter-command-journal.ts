import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { recordOnlySchemaVersion } from './schema-version.ts'
import type { BidCommitLease } from './run-coordinator.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

const commandSchema = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'applied', 'canceled']),
  command: z.unknown(),
}).strict()
const journalSchema = z.object({ schema_version: recordOnlySchemaVersion(1), commands: z.array(commandSchema) }).strict()
/** One durable S5 command and whether its canonical publication completed. */
export type BidChapterCommandRecord = z.infer<typeof commandSchema>

type JournalWorkspace = { readonly root: string; readonly projectRoot: string }
const journalTails = new Map<string, Promise<void>>()

function pathFor(workspace: JournalWorkspace, workId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workId)) throw new Error('BID_WORK_ID_INVALID')
  return join(workspace.projectRoot, 'runs', workId, 'commands.json')
}

/**
 * 同一 Host 内序列化一份 Work 命令日志的读改写事务。
 * @param workspace 当前正式项目。
 * @param workId 命令日志所属 Work。
 * @param update 在持锁期间读取和提交完整日志。
 * @returns 本次更新返回值。
 */
export async function withBidCommandJournalLock<T>(
  workspace: JournalWorkspace, workId: string, update: () => Promise<T>,
): Promise<T> {
  const path = pathFor(workspace, workId)
  const prior = journalTails.get(path) ?? Promise.resolve()
  const settled = Promise.withResolvers<void>()
  const tail = prior.then(() => settled.promise)
  journalTails.set(path, tail)
  await prior
  try { return await update() } finally {
    settled.resolve()
    if (journalTails.get(path) === tail) journalTails.delete(path)
  }
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
