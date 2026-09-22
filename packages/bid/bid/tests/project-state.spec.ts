import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BID_INITIAL_TASK_STATE } from '../src/runtime-state.ts'
import { checkpointBidProjectState, commitBidProjectMutation, readBidProjectState, writeBidProjectState } from '../src/project-state.ts'

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-project-state-'))
  return { root, projectStatePath: join(root, '.bid-harness', 'project-state.json') }
}

const run = {
  runId: 'run-12', epoch: 12, baseProjectRevision: 11,
  work: { kind: 'stage_execution' as const, workId: 'work-12', stage: 'chapter_writing' as const,
    requestRef: 'requests/work-12.json', requestSha256: '1'.repeat(64), inputFingerprint: '2'.repeat(64) },
  startedAt: 1, updatedAt: 1,
}

describe('Bid 项目状态', () => {
  it('以 v4 扁平结构保存唯一任务状态并只在状态变化时递增修订号', async () => {
    const project = await workspace()
    await expect(readBidProjectState(project)).resolves.toBeUndefined()
    const initial = await checkpointBidProjectState(project, BID_INITIAL_TASK_STATE)
    expect(initial).toMatchObject({ schema_version: 4, stage: 'file_intake', status: 'waiting_user', run: null, revision: 1 })
    expect((await checkpointBidProjectState(project, BID_INITIAL_TASK_STATE)).revision).toBe(1)
    const ready = await checkpointBidProjectState(project, { stage: 'evidence_mapping', status: 'ready', run: null })
    expect(ready.revision).toBe(2)
    const failed = await checkpointBidProjectState(project, {
      stage: 'chapter_writing', status: 'failed', run: null,
      failure: { message: '章节资料不足。', issues: [{ code: 'MISSING_EVIDENCE', message: '缺少施工参数。' }] },
    })
    expect(failed.revision).toBe(3)
    expect(JSON.parse(await readFile(project.projectStatePath, 'utf8'))).toEqual(failed)
  })

  it('保留 running 供持锁 Host 在恢复时转换', async () => {
    const project = await workspace()
    await writeBidProjectState(project, {
      schema_version: 4, stage: 'chapter_writing', status: 'running', run, revision: 12, updated_at: 1,
    })
    await expect(readBidProjectState(project)).resolves.toMatchObject({ status: 'running', run, revision: 12 })
  })

  it('结构化读取 v3 并归一为 v4 单一状态', async () => {
    const project = await workspace()
    await mkdir(join(project.root, '.bid-harness'), { recursive: true })
    await writeFile(project.projectStatePath, `${JSON.stringify({
      schema_version: 3,
      workflow: { stage: 'chapter_writing', gate: 'ready' },
      run: { ...run, stage: 'chapter_writing', status: 'suspended', cause: 'host_restart' },
      last_run: null,
      runtime: { stage: 'chapter_writing', status: 'suspended' },
      revision: 12,
      updated_at: 1,
    })}\n`)
    await expect(readBidProjectState(project)).resolves.toMatchObject({
      schema_version: 4, stage: 'chapter_writing', status: 'suspended', revision: 12,
      run: { runId: 'run-12', cause: 'host_restart' },
    })
  })

  it('拒绝非法状态组合', async () => {
    const project = await workspace()
    await mkdir(join(project.root, '.bid-harness'), { recursive: true })
    const raw = JSON.stringify({ schema_version: 4, revision: 1, updated_at: 1,
      stage: 'chapter_writing', status: 'waiting_user', run })
    await writeFile(project.projectStatePath, raw)
    await expect(readBidProjectState(project)).rejects.toThrow('bid-invalid-project-state')
    await expect(readFile(project.projectStatePath, 'utf8')).resolves.toBe(raw)
  })

  it('ProjectMutation 把 canonical 修改与 revision bump 归入同一发布', async () => {
    const project = await workspace()
    const initial = await checkpointBidProjectState(project, BID_INITIAL_TASK_STATE)
    const artifact = join(project.root, '.bid-harness', 'outline', 'draft.json')
    const task = { stage: 'outline_generation', status: 'ready', run: null } as const
    const committed = await commitBidProjectMutation(project, initial.revision, task,
      lease => lease.writeJson(artifact, { revision: 1 }))
    expect(committed.revision).toBe(initial.revision + 1)
    expect(JSON.parse(await readFile(artifact, 'utf8'))).toEqual({ revision: 1 })
    await expect(commitBidProjectMutation(project, initial.revision, task,
      lease => lease.writeJson(artifact, { revision: 2 }))).rejects.toThrow('BID_PROJECT_REVISION_CONFLICT')
  })

  it('拒绝穿过链接的项目目录读取或写入状态', async () => {
    const project = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-bid-project-state-outside-'))
    await symlink(outside, join(project.root, '.bid-harness'), process.platform === 'win32' ? 'junction' : 'dir')
    const state = { schema_version: 4, revision: 1, updated_at: 1, ...BID_INITIAL_TASK_STATE }
    await expect(readBidProjectState(project)).rejects.toThrow('bid-workspace-symbolic-link')
    await expect(writeBidProjectState(project, state)).rejects.toThrow('bid-workspace-symbolic-link')
  })

  it('不会把目录读取错误当作全新项目', async () => {
    const project = await workspace()
    await mkdir(project.projectStatePath, { recursive: true })
    await expect(readBidProjectState(project)).rejects.toThrow()
  })
})
