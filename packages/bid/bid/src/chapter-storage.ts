/** 章节的存储序号由 execution-log 持有；旧项目只从真实产物恢复身份。 */
import { readFile, readdir } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import { parseChapterMetadata, parseChapterWritingManifest } from './chapter-writing-artifacts.ts'
import { parseOrMigrateChapterExecutionLog, type ChapterExecutionLog } from './chapter-writing-plan-artifacts.ts'
import type { BidCommitLease } from './run-coordinator.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const MAX_SERIAL = 9_999
const LOG_PATH = 'chapters/execution-log.json'
const MANIFEST_PATH = 'chapters/manifest.json'

/** 一个章节固定的正文、metadata 和审核文件位置。 */
export interface ChapterLocation {
  readonly sectionId: string
  readonly storageSerial: number
  readonly contentPath: string
  readonly metadataPath: string
  readonly reviewPath: string
}

/** 尚未提交的章节位置分配；提交后才可启动对应 Writer。 */
export interface ChapterStoragePlan {
  readonly locations: ReadonlyMap<string, ChapterLocation>
  readonly nextStorageSerial: number
}

/**
 * 为章节分配稳定的正文、元数据和审核记录路径。
 * @param sectionId 章节身份。
 * @param storageSerial Host 分配的持久序号。
 * @returns 章节的固定存储路径。
 */
export function chapterLocation(sectionId: string, storageSerial: number): ChapterLocation {
  if (!Number.isInteger(storageSerial) || storageSerial < 1 || storageSerial > MAX_SERIAL) {
    throw new Error(`BID_CHAPTER_STORAGE_CAPACITY: ${sectionId}`)
  }
  const serial = String(storageSerial).padStart(4, '0')
  return { sectionId, storageSerial, contentPath: `chapters/sections/${serial}.md`,
    metadataPath: `chapters/meta/${serial}.json`, reviewPath: `chapters/reviews/${serial}.json` }
}

async function readOptionalJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  try { return JSON.parse(await readFile(absolute, 'utf8')) as unknown } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function serialFiles(workspace: BidWorkspace, directory: string, suffix: string): Promise<number[]> {
  const absolute = within(workspace.projectRoot, directory)
  await assertNoLinkedPath(workspace.root, absolute)
  let names: string[]
  try { names = await readdir(absolute) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const pattern = new RegExp(`^(\\d{4})\\.${suffix}$`, 'u')
  return names.flatMap((name) => {
    const match = pattern.exec(name)
    return match === null ? [] : [Number(match[1])]
  })
}

interface StorageEvidence {
  readonly log: ChapterExecutionLog | undefined
  readonly owners: ReadonlyMap<string, number>
  readonly occupied: ReadonlySet<number>
  readonly next: number
}

function chapterExecutionLogResult(value: unknown, tolerant: boolean): ChapterExecutionLog | undefined {
  try { return parseOrMigrateChapterExecutionLog(value) } catch (error) {
    if (tolerant) return undefined
    throw error
  }
}

function chapterManifestResult(value: unknown, tolerant: boolean): ReturnType<typeof parseChapterWritingManifest> | undefined {
  try { return parseChapterWritingManifest(value) } catch (error) {
    if (tolerant) return undefined
    throw error
  }
}

async function inspectStorage(workspace: BidWorkspace, tolerateDamagedIndexes = false): Promise<StorageEvidence> {
  const [logValue, manifestValue, metadataSerials, contentSerials, reviewSerials] = await Promise.all([
    readOptionalJson(workspace, LOG_PATH).catch((error: unknown) => {
      if (tolerateDamagedIndexes && error instanceof SyntaxError) return undefined
      throw error
    }),
    readOptionalJson(workspace, MANIFEST_PATH).catch((error: unknown) => {
      if (tolerateDamagedIndexes && error instanceof SyntaxError) return undefined
      throw error
    }),
    serialFiles(workspace, 'chapters/meta', 'json'), serialFiles(workspace, 'chapters/sections', 'md'),
    serialFiles(workspace, 'chapters/reviews', 'json'),
  ])
  const logResult = logValue === undefined ? undefined : chapterExecutionLogResult(logValue, tolerateDamagedIndexes)
  const manifestResult = manifestValue === undefined ? undefined : chapterManifestResult(manifestValue, tolerateDamagedIndexes)
  const log = logResult
  const manifest = manifestResult
  const owners = new Map<string, number>()
  const serialOwners = new Map<number, string>()
  const claim = (sectionId: string, storageSerial: number, evidence: string): void => {
    const currentSerial = owners.get(sectionId)
    const currentOwner = serialOwners.get(storageSerial)
    if (currentSerial !== undefined && currentSerial !== storageSerial
      || currentOwner !== undefined && currentOwner !== sectionId) {
      throw new Error(`BID_CHAPTER_STORAGE_CONFLICT: ${evidence} ${sectionId} ${storageSerial}`)
    }
    owners.set(sectionId, storageSerial)
    serialOwners.set(storageSerial, sectionId)
  }
  for (const storageSerial of metadataSerials) {
    const value = await readOptionalJson(workspace, chapterLocation('metadata', storageSerial).metadataPath)
    if (value === undefined) throw new Error(`BID_CHAPTER_STORAGE_METADATA_MISSING: ${storageSerial}`)
    const metadata = parseChapterMetadata(value)
    claim(metadata.section_id, storageSerial, 'metadata')
  }
  for (const entry of manifest?.chapters ?? []) {
    const match = /^chapters\/sections\/(\d{4})\.md$/u.exec(entry.content_path)
    if (match === null) throw new Error(`BID_CHAPTER_STORAGE_MANIFEST_PATH_INVALID: ${entry.section_id}`)
    const storageSerial = Number(match[1])
    if (entry.review_path !== chapterLocation(entry.section_id, storageSerial).reviewPath) {
      throw new Error(`BID_CHAPTER_STORAGE_MANIFEST_MISMATCH: ${entry.section_id}`)
    }
    claim(entry.section_id, storageSerial, 'manifest')
  }
  const contents = new Set(contentSerials)
  for (const section of log?.sections ?? []) {
    if (section.storage_serial !== undefined) claim(section.section_id, section.storage_serial, 'execution-log')
    else if (section.status === 'completed' && !owners.has(section.section_id)) {
      throw new Error(`BID_CHAPTER_STORAGE_IDENTITY_MISSING: ${section.section_id}`)
    }
  }
  for (const storageSerial of contents) {
    if (!serialOwners.has(storageSerial)) {
      throw new Error(`BID_CHAPTER_STORAGE_IDENTITY_MISSING: chapters/sections/${String(storageSerial).padStart(4, '0')}.md`)
    }
  }
  const occupied = new Set([...metadataSerials, ...contentSerials, ...reviewSerials, ...serialOwners.keys()])
  const next = Math.max(log?.next_storage_serial ?? 1, ...[...occupied].map(serial => serial + 1))
  return { log, owners, occupied, next }
}

/**
 * 按真实章节身份读取固定位置；不存在已证明的位置时返回 null，且不写项目。
 * @param workspace 当前项目。
 * @param sectionId 真实章节 ID。
 * @returns 已保存的章节位置，或 null。
 */
export async function readChapterLocation(workspace: BidWorkspace, sectionId: string): Promise<ChapterLocation | null> {
  const evidence = await inspectStorage(workspace, true)
  const serial = evidence.owners.get(sectionId)
  return serial === undefined ? null : chapterLocation(sectionId, serial)
}

/**
 * 一次读取当前项目所有已证明的章节位置，供整书视图和导出使用。
 * @param workspace 当前项目。
 * @returns 按章节 ID 索引的固定位置；未写章节不在其中。
 */
export async function readChapterLocations(workspace: BidWorkspace): Promise<ReadonlyMap<string, ChapterLocation>> {
  const evidence = await inspectStorage(workspace, true)
  return new Map([...evidence.owners].map(([sectionId, serial]) => [sectionId, chapterLocation(sectionId, serial)]))
}

/**
 * 为当前可写章节计算位置；已有产物只接受 metadata、Manifest 或日志证明的身份。
 * @param workspace 当前项目。
 * @param sectionIds 当前可写章节 ID，顺序只影响首次空项目的分配。
 * @returns 待提交的位置与下一个未使用序号。
 */
export async function planChapterLocations(workspace: BidWorkspace, sectionIds: readonly string[]): Promise<ChapterStoragePlan> {
  if (new Set(sectionIds).size !== sectionIds.length) throw new Error('BID_CHAPTER_STORAGE_DUPLICATE_ID')
  const evidence = await inspectStorage(workspace)
  const locations = new Map<string, ChapterLocation>()
  let next = evidence.next
  for (const sectionId of sectionIds) {
    let serial = evidence.owners.get(sectionId)
    if (serial === undefined) {
      if (next > MAX_SERIAL) throw new Error(`BID_CHAPTER_STORAGE_CAPACITY: ${sectionId}`)
      serial = next++
    }
    locations.set(sectionId, chapterLocation(sectionId, serial))
  }
  return { locations, nextStorageSerial: next }
}

/**
 * 持有项目提交权限时把固定位置写入同一 execution-log。
 * @param workspace 当前项目。
 * @param log 待提交的执行记录，章节 ID 必须与计划一致。
 * @param plan 从当前项目读取的分配计划。
 * @param lease 当前 Run 的提交权限。
 * @returns 已写入固定位置的执行记录。
 */
export async function ensureChapterLocations(
  workspace: BidWorkspace, log: ChapterExecutionLog, plan: ChapterStoragePlan,
  lease: Pick<BidCommitLease, 'writeJson'>,
): Promise<ChapterExecutionLog> {
  if (log.sections.length !== plan.locations.size
    || log.sections.some(section => !plan.locations.has(section.section_id))) {
    throw new Error('BID_CHAPTER_STORAGE_LOG_SECTION_MISMATCH')
  }
  const updated: ChapterExecutionLog = {
    ...log, next_storage_serial: plan.nextStorageSerial,
    sections: log.sections.map((section) => {
      const assigned = plan.locations.get(section.section_id)
      if (assigned === undefined) throw new Error(`BID_CHAPTER_STORAGE_LOG_SECTION_MISMATCH: ${section.section_id}`)
      return { ...section, storage_serial: assigned.storageSerial }
    }),
  }
  const current = await readOptionalJson(workspace, LOG_PATH)
  if (JSON.stringify(current) !== JSON.stringify(updated)) {
    await lease.writeJson(within(workspace.projectRoot, LOG_PATH), updated)
  }
  return updated
}
