import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BID_INITIAL_RUNTIME_STATE } from '../src/runtime-state.ts'
import { checkpointBidProjectState, readBidProjectState, writeBidProjectState } from '../src/project-state.ts'

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-project-state-'))
  return { root, projectStatePath: join(root, '.bid-harness', 'project-state.json') }
}

describe('Bid 项目状态', () => {
  it('按项目保存控制状态，并在每次成功 checkpoint 后递增修订号', async () => {
    const project = await workspace()
    await expect(readBidProjectState(project)).resolves.toBeUndefined()

    const initial = await checkpointBidProjectState(project, BID_INITIAL_RUNTIME_STATE)
    expect(initial).toEqual({
      schema_version: 1, runtime: { stage: 'file_intake', status: 'pending' }, revision: 1, updated_at: expect.any(Number),
    })
    const waiting = await checkpointBidProjectState(project, { stage: 'evidence_mapping', status: 'waiting_user' })
    expect(waiting.revision).toBe(2)
    await expect(readBidProjectState(project)).resolves.toEqual(waiting)

    const reset = await checkpointBidProjectState(project, { stage: 'outline_generation', status: 'pending' })
    expect(reset.revision).toBe(3)
    const failed = await checkpointBidProjectState(project, {
      stage: 'chapter_writing', status: 'failed', failureReason: '章节资料不足。',
      failureIssues: [{ code: 'MISSING_EVIDENCE', message: '缺少施工参数。', artifact: 'chapters/section-1.md', path: 'body' }],
    })
    expect(failed.revision).toBe(4)
    expect(JSON.parse(await readFile(project.projectStatePath, 'utf8'))).toEqual(failed)
    await expect(readBidProjectState(project)).resolves.toEqual(failed)
  })

  it('读取 running 时保留执行状态，交由持有项目锁的 Host 决定恢复', async () => {
    const project = await workspace()
    await writeBidProjectState(project, {
      schema_version: 1, runtime: { stage: 'chapter_writing', status: 'running' }, revision: 12, updated_at: 1,
    })
    await expect(readBidProjectState(project)).resolves.toEqual({
      schema_version: 1,
      runtime: { stage: 'chapter_writing', status: 'running' },
      revision: 12,
      updated_at: 1,
    })
  })

  it.each([
    ['无法解析的 JSON', '{'],
    ['未知版本', { schema_version: 2 }],
    ['未知阶段', { runtime: { stage: 'unknown', status: 'pending' } }],
    ['未知执行状态', { runtime: { stage: 'file_intake', status: 'unknown' } }],
    ['聊天记录', { messages: [{ role: 'user', content: '私有聊天内容' }] }],
    ['聊天摘要', { runtime: { stage: 'file_intake', status: 'pending', summary: '私有聊天摘要' } }],
    ['负修订号', { revision: -1 }],
    ['非整数修订号', { revision: 1.5 }],
    ['额外的问题字段', { runtime: { stage: 'file_intake', status: 'failed', failureIssues: [{ code: 'INVALID', message: '失败', prompt: '私有 prompt' }] } }],
  ])('拒绝 %s 且不以默认项目状态覆盖文件', async (_name, patch) => {
    const project = await workspace()
    const initial = await checkpointBidProjectState(project, BID_INITIAL_RUNTIME_STATE)
    const raw = typeof patch === 'string' ? patch : JSON.stringify({ ...initial, ...patch })
    await writeFile(project.projectStatePath, raw)

    await expect(readBidProjectState(project)).rejects.toThrow('bid-invalid-project-state')
    await expect(checkpointBidProjectState(project, BID_INITIAL_RUNTIME_STATE)).rejects.toThrow('bid-invalid-project-state')
    await expect(readFile(project.projectStatePath, 'utf8')).resolves.toBe(raw)
  })

  it('拒绝穿过链接的项目目录读取或写入状态', async () => {
    const project = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-bid-project-state-outside-'))
    await symlink(outside, join(project.root, '.bid-harness'), process.platform === 'win32' ? 'junction' : 'dir')
    const state = { schema_version: 1 as const, runtime: BID_INITIAL_RUNTIME_STATE, revision: 1, updated_at: 1 }

    await expect(readBidProjectState(project)).rejects.toThrow('bid-workspace-symbolic-link')
    await expect(writeBidProjectState(project, state)).rejects.toThrow('bid-workspace-symbolic-link')
    await expect(readFile(join(outside, 'project-state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('不会把目录读取错误当作全新项目', async () => {
    const project = await workspace()
    await mkdir(project.projectStatePath, { recursive: true })
    await expect(readBidProjectState(project)).rejects.toThrow()
  })
})
