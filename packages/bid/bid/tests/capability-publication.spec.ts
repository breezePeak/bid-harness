import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { publishCapabilityChanges, readCapabilityPublicationReceipt } from '../src/bid-capability-changes.ts'
import { BidCommitScope, createTestBidRunContext } from '../src/run-coordinator.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-publication-'))
  const candidateRoot = await mkdtemp(join(tmpdir(), 'dsh-capability-candidate-'))
  roots.push(root, candidateRoot)
  const canonical = new BidWorkspace(root)
  const working = new BidWorkspace(candidateRoot)
  await mkdir(canonical.projectRoot, { recursive: true })
  await mkdir(join(working.projectRoot, 'chapters'), { recursive: true })
  const descriptor = { kind: 'capability_task' as const, workId: 'work-publication', stage: 'chapter_writing' as const,
    requestRef: 'requests/work-publication.json', requestSha256: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64) }
  const base = createTestBidRunContext({ work: descriptor })
  const run = { ...base, commits: new BidCommitScope({ runId: base.runId, epoch: base.epoch,
    controlRevision: 0, signal: base.signal }, () => 0,
  { workspaceRoot: canonical.root, projectRoot: canonical.projectRoot }) }
  return { canonical, working, run }
}

describe('能力任务精确发布', () => {
  it('将候选文件和请求结果凭据一次写入正式项目并核对摘要', async () => {
    const { canonical, working, run } = await fixture()
    await writeFile(join(working.projectRoot, 'chapters/0001.md'), '# 正文\n')
    const receipt = await publishCapabilityChanges(run, canonical, working, ['chapters/0001.md'], [])
    expect(receipt.files.map(file => file.path)).toEqual(['chapters/0001.md'])
    expect(await readFile(join(canonical.projectRoot, 'chapters/0001.md'), 'utf8')).toBe('# 正文\n')
    expect(await readCapabilityPublicationReceipt(canonical, run.work.workId, run.work.requestSha256)).toEqual(receipt)
    await writeFile(join(canonical.projectRoot, 'chapters/0001.md'), '# 意外改动\n')
    await expect(readCapabilityPublicationReceipt(canonical, run.work.workId, run.work.requestSha256))
      .rejects.toThrow('BID_CAPABILITY_RESULT_FILE_MISMATCH')
  })

  it('拒绝目录发布、越界路径和冲突的文件操作', async () => {
    const { canonical, working, run } = await fixture()
    await writeFile(join(working.projectRoot, 'chapters/0001.md'), '# 正文\n')
    await expect(publishCapabilityChanges(run, canonical, working, ['chapters'], []))
      .rejects.toThrow('BID_CAPABILITY_PUBLICATION_NOT_FILE')
    await expect(publishCapabilityChanges(run, canonical, working, ['../outside.md'], []))
      .rejects.toThrow('BID_CAPABILITY_PUBLICATION_PATH_INVALID')
    await expect(publishCapabilityChanges(run, canonical, working, ['chapters/0001.md'], ['chapters/0001.md']))
      .rejects.toThrow('BID_CAPABILITY_PUBLICATION_DUPLICATE_PATH')
    await expect(readCapabilityPublicationReceipt(canonical, run.work.workId, run.work.requestSha256)).resolves.toBeNull()
  })
})
