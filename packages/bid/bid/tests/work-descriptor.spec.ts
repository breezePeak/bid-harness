import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { bidResetWorkPaths, persistBidWorkRequest, readBidWorkRequest } from '../src/work-descriptor.ts'
import { prepareBidWorkingTree, publishBidWorkingPaths } from '../src/working-tree.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-descriptor-'))
  return { root, projectRoot: join(root, '.bid-harness') }
}

describe('Bid Work Descriptor', () => {
  it('在 Run start 前持久化并校验精确 request identity', async () => {
    const workspace = await fixture()
    const descriptor = await persistBidWorkRequest(
      workspace,
      'outline_regeneration',
      'evidence_mapping',
      { feedback: '拆分实施与验收' },
      { outline_sha256: 'a'.repeat(64) },
      'regenerate-1',
    )

    await expect(readBidWorkRequest(workspace, descriptor))
      .resolves.toEqual({ feedback: '拆分实施与验收' })
    await writeFile(join(workspace.projectRoot, descriptor.requestRef), '{}\n')
    await expect(readBidWorkRequest(workspace, descriptor))
      .rejects.toThrow('BID_WORK_REQUEST_IDENTITY_MISMATCH')
  })

  it('同一 workId 恢复私有工作树且成功前不修改 canonical', async () => {
    const workspace = await fixture()
    const canonical = join(workspace.projectRoot, 'outline', 'outline.json')
    await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
    await writeFile(canonical, 'canonical')
    const descriptor = await persistBidWorkRequest(
      workspace,
      'evidence_remap',
      'evidence_mapping',
      { section_ids: ['SEC-1'] },
      { outline_sha256: 'b'.repeat(64) },
      'remap-1',
    )
    const first = await prepareBidWorkingTree(workspace, descriptor)
    const candidate = join(first.projectRoot, 'outline', 'outline.json')
    await writeFile(candidate, 'candidate')

    const reopened = await prepareBidWorkingTree(workspace, descriptor)

    expect(reopened).toEqual(first)
    expect(await readFile(join(reopened.projectRoot, 'outline', 'outline.json'), 'utf8')).toBe('candidate')
    expect(await readFile(canonical, 'utf8')).toBe('canonical')

    const base = createTestBidRunContext({ work: descriptor })
    const run = { ...base, commits: base.commits.forPublication({
      workspaceRoot: workspace.root,
      projectRoot: workspace.projectRoot,
    }) }
    await publishBidWorkingPaths(run, workspace, reopened, ['outline/outline.json'])
    expect(await readFile(canonical, 'utf8')).toBe('candidate')
  })

  it('重置阶段时枚举请求、私有工作树及后续阶段，不误删上游工作', async () => {
    const workspace = await fixture()
    const upstream = await persistBidWorkRequest(workspace, 'outline_regeneration', 'outline_generation', {}, {}, 'upstream')
    const target = await persistBidWorkRequest(workspace, 'stage_execution', 'evidence_mapping', {}, {}, 'target')
    const downstream = await persistBidWorkRequest(workspace, 'chapter_revision', 'chapter_writing', {}, {}, 'downstream')
    await mkdir(join(workspace.projectRoot, 'requests', target.workId), { recursive: true })
    await mkdir(join(workspace.projectRoot, 'runs', target.workId, 'work'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'runs', target.workId, 'work', 'work-identity.json'), `${JSON.stringify(target)}\n`)
    await mkdir(join(workspace.projectRoot, 'runs', downstream.workId, 'work'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'runs', downstream.workId, 'work', 'work-identity.json'), `${JSON.stringify(downstream)}\n`)

    const paths = await bidResetWorkPaths(workspace, 'evidence_mapping')

    expect(paths).toEqual(expect.arrayContaining([
      join(workspace.projectRoot, target.requestRef),
      join(workspace.projectRoot, 'requests', target.workId),
      join(workspace.projectRoot, 'runs', target.workId),
      join(workspace.projectRoot, downstream.requestRef),
      join(workspace.projectRoot, 'runs', downstream.workId),
    ]))
    expect(paths).not.toContain(join(workspace.projectRoot, upstream.requestRef))
    expect(paths).not.toContain(join(workspace.projectRoot, 'runs', upstream.workId))
  })

  it('请求附属目录缺少同名 JSON 时按工作树身份确认归属', async () => {
    const workspace = await fixture()
    const descriptor = await persistBidWorkRequest(workspace, 'stage_execution', 'evidence_mapping', {}, {}, 'orphan-payload')
    await mkdir(join(workspace.projectRoot, 'requests', descriptor.workId), { recursive: true })
    await mkdir(join(workspace.projectRoot, 'runs', descriptor.workId, 'work'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'runs', descriptor.workId, 'work', 'work-identity.json'), `${JSON.stringify(descriptor)}\n`)
    await rm(join(workspace.projectRoot, descriptor.requestRef))

    await expect(bidResetWorkPaths(workspace, 'evidence_mapping')).resolves.toEqual(expect.arrayContaining([
      join(workspace.projectRoot, 'requests', descriptor.workId),
      join(workspace.projectRoot, 'runs', descriptor.workId),
    ]))
  })

  it('重置时清理仅含 staging 或 scratch 的未提交 Run，但拒绝其他无身份目录', async () => {
    const workspace = await fixture()
    const runId = '5b7193e3-9a7a-4a09-b7f1-f1ab8c3a699d'
    const runRoot = join(workspace.projectRoot, 'runs', runId)
    await mkdir(join(runRoot, 'staging'), { recursive: true })

    await expect(bidResetWorkPaths(workspace, 'evidence_mapping')).resolves.toContain(runRoot)

    await mkdir(join(runRoot, 'scratch'), { recursive: true })
    await expect(bidResetWorkPaths(workspace, 'evidence_mapping')).resolves.toContain(runRoot)

    await writeFile(join(runRoot, 'unknown'), 'unowned')
    await expect(bidResetWorkPaths(workspace, 'evidence_mapping'))
      .rejects.toThrow(`BID_RESET_ORPHAN_WORK_UNRESOLVED:${runRoot}`)
  })

  it('请求元信息与工作树身份矛盾时报告身份文件路径', async () => {
    const workspace = await fixture()
    const descriptor = await persistBidWorkRequest(workspace, 'stage_execution', 'evidence_mapping', {}, {}, 'mismatch')
    await mkdir(join(workspace.projectRoot, 'runs', descriptor.workId, 'work'), { recursive: true })
    const marker = join(workspace.projectRoot, 'runs', descriptor.workId, 'work', 'work-identity.json')
    await writeFile(marker, `${JSON.stringify({ ...descriptor, stage: 'chapter_writing' })}\n`)

    await expect(bidResetWorkPaths(workspace, 'evidence_mapping'))
      .rejects.toThrow(`BID_RESET_WORK_IDENTITY_MISMATCH:${marker}`)
  })
})
