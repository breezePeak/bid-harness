import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { persistBidWorkRequest, readBidWorkRequest } from '../src/work-descriptor.ts'
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
})
