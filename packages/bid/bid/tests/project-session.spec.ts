import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  BID_INITIAL_RUNTIME_STATE, BidHostRuntime, BidOrchestrator, BidWorkspace,
  checkpointBidProjectState, getBidClientProjection, parseEvidenceMapArtifact,
  readBidProjectState, reduceBidRuntimeState, validateTenderAnalysis,
  type BidStageExecutorPort, type BidStageValidatorPort,
} from '@deepseek-ai/dsh-bid'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seedConversation, seedProjectArtifacts } from './fixtures/project-session.ts'

interface HostExecution {
  readonly inFlight: Map<string, unknown>
  automaticOrchestrator(agent: Agent, workspace: BidWorkspace, signal?: AbortSignal): BidOrchestrator
}

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

function runtime(session: Session) {
  return session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-session-'))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(BidHostRuntime)
  const workspace = new BidWorkspace(root)
  const host = ctx.bid as unknown as HostExecution
  const executor: BidStageExecutorPort = { canExecute: () => false, execute: vi.fn(async () => []) }
  const validator: BidStageValidatorPort = { validate: async () => ({ ok: true, issues: [] }) }
  host.automaticOrchestrator = (agent, current, signal) => new BidOrchestrator(agent.session, executor, {
    validate: (stage, artifacts) => stage === 'tender_analysis' ? validateTenderAnalysis(current, stage, artifacts) : validator.validate(stage, artifacts),
  }, signal)
  const fresh = async (id: string, cwd = root, waitForIdle = true) => {
    const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd, agentPreset: 'bid' } })
    await vi.waitFor(() => {
      expect(handle.agent.session.events.some(event => event.type === 'bid.project.resumed'), `${id} 应完成项目恢复`).toBe(true)
      if (waitForIdle) expect(host.inFlight.size).toBe(0)
    })
    return handle.agent
  }
  return { ctx, workspace, fresh, host, executor, validator }
}

describe('Workspace 项目与独立 Session', () => {
  it('fresh Session 保留 S4 项目，聊天、推理、工具和 conversation nodes 均为空', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    const state = { stage: 'evidence_mapping', status: 'waiting_user' } as const
    await checkpointBidProjectState(workspace, state)
    const a = await fresh('session-a')
    seedConversation(a.session)
    const fork = vi.spyOn(ctx.sessions, 'fork')
    const b = await fresh('session-b')

    expect(runtime(b.session)).toEqual(state)
    expect(b.session.header.parentSession).toBeUndefined()
    expect(b.session.header.seedLength).toBeUndefined()
    expect(b.session.surface.nodes).toEqual([])
    expect(b.session.deriveMessages()).toEqual([])
    expect(b.session.events.every(event => event.type === 'bid.project.resumed')).toBe(true)
    expect(fork).not.toHaveBeenCalled()
    expect(executor.execute).not.toHaveBeenCalled()
    expect(a.session.deriveMessages()).toHaveLength(3)
    expect(await ctx.bid.getOutlineForConfirmation(b.session)).toEqual(outline)
    expect((await new BidWorkspace(b.session.header.cwd!).readManifest()).files).toHaveLength(1)
    const evidence = parseEvidenceMapArtifact(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8')))
    expect(evidence.section_mappings[0]?.missing_topics).toEqual(['待补充实施材料'])
  })

  it('新项目初始化 S1，S2 在新 Session 中读取、编辑并继续确认', async () => {
    const { ctx, workspace, fresh } = await fixture()
    const a = await fresh('session-a')
    expect(await readBidProjectState(workspace)).toMatchObject({ schema_version: 1, runtime: { stage: 'file_intake', status: 'pending' } })
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'tender_analysis', status: 'waiting_user' })
    const b = await fresh('session-b')
    expect((await ctx.bid.getTenderAnalysisForConfirmation(b.session)).project.project_name).toBe('项目 A')
    const before = (await readBidProjectState(workspace))!.revision
    const confirmation = await ctx.bid.confirmTenderAnalysis(b.session, [{ type: 'update_project', fields: { project_name: '项目 B' } }])
    expect(confirmation).toEqual({ ok: true, value: { stage: 'outline_generation', status: 'pending' } })
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/project.json'), 'utf8'))).toMatchObject({ project_name: '项目 B' })
    expect((await readBidProjectState(workspace))!.revision).toBeGreaterThan(before)
    expect(runtime(a.session)).toEqual({ stage: 'outline_generation', status: 'pending' })
    const c = await fresh('session-c')
    expect(runtime(c.session)).toEqual({ stage: 'outline_generation', status: 'pending' })
  })

  it('S5 失败后新 Session 继续读取已有正文和执行日志，并从 S5 retry', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    const failed = { stage: 'chapter_writing', status: 'failed', failureReason: '章节执行失败' } as const
    await checkpointBidProjectState(workspace, failed)
    await fresh('session-a')
    const b = await fresh('session-b')
    expect(runtime(b.session)).toEqual(failed)
    expect(getBidClientProjection(runtime(b.session)).allowedActions).toContain('retry_stage')
    expect(await ctx.bid.getReviewWorkbench(b.session)).toMatchObject({ outline: [{ section_id: 'SEC-1', writing_status: 'completed', content_available: true }], summary: { content_count: 1 } })
    expect(await ctx.bid.getReviewChapter(b.session, 'SEC-1')).toMatchObject({ markdown: '# 技术方案\n\n已有正文。\n' })
    executor.canExecute = stage => stage === 'chapter_writing'
    expect(await ctx.bid.retryStage(b.session)).toEqual({ ok: true, value: { stage: 'chapter_writing', status: 'completed' } })
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({ stage: 'chapter_writing' }))
    expect(await readBidProjectState(workspace)).toMatchObject({ runtime: { stage: 'chapter_writing', status: 'completed' } })
  })

  it('旧 S6 已完成项目仍保留审核工作台和按需导出动作', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'docx_export', status: 'completed' })
    await fresh('session-a')
    const b = await fresh('session-b')
    expect(runtime(b.session)).toEqual({ stage: 'docx_export', status: 'completed' })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(getBidClientProjection(runtime(b.session)).allowedActions).toEqual(['export_docx'])
    expect(await ctx.bid.exportDocx(b.session)).toMatchObject({ ok: true })
    expect(runtime(b.session)).toEqual({ stage: 'docx_export', status: 'completed' })
  })

  it('S5 完成后可重复导出独立 Word 文件且不改变审核阶段', async () => {
    const { ctx, workspace, fresh } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    const agent = await fresh('session-export')

    const first = await ctx.bid.exportDocx(agent.session)
    const second = await ctx.bid.exportDocx(agent.session)

    expect(first).toMatchObject({ ok: true, value: { path: expect.stringMatching(/^output\/bid-\d+-[a-f0-9]{6}\.docx$/u) } })
    expect(second).toMatchObject({ ok: true })
    if (!first.ok || !second.ok) throw new Error('DOCX export failed')
    expect(second.value.path).not.toBe(first.value.path)
    expect((await readFile(join(workspace.projectRoot, first.value.path))).readUInt32LE(0)).toBe(0x04034b50)
    expect(runtime(agent.session)).toEqual({ stage: 'chapter_writing', status: 'completed' })
    expect(await readBidProjectState(workspace)).toMatchObject({ runtime: { stage: 'chapter_writing', status: 'completed' } })
  })

  it('旧 Session 日志落盘失败不会让新聊天以 S1 覆盖已有 S4 项目', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const state = { stage: 'evidence_mapping', status: 'waiting_user' } as const
    await checkpointBidProjectState(workspace, state)
    const a = await fresh('session-a')
    const saved = (await readBidProjectState(workspace))!
    const flush = vi.fn((session: Session) => {
      if (session === a.session) throw new Error('旧聊天落盘失败')
    })
    const release = ctx.on('session/flush', flush, { global: true })
    try {
      const b = await fresh('session-b')
      expect(flush).toHaveBeenCalledWith(a.session)
      expect(runtime(b.session)).toEqual(state)
      expect(b.session.deriveMessages()).toEqual([])
      const restored = (await readBidProjectState(workspace))!
      expect(restored.runtime).toEqual(saved.runtime)
      expect(restored.revision).toBeGreaterThanOrEqual(saved.revision)
      expect(executor.execute).not.toHaveBeenCalled()
    } finally { release() }
  })

  it('reset 删除后续产物并等待用户确认，确认后才执行当前阶段', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'failed' })
    const a = await fresh('session-a')
    expect(await ctx.bid.resetStage(a, 'outline_generation')).toEqual({ stage: 'outline_generation', status: 'waiting_start' })
    expect(executor.execute).not.toHaveBeenCalled()
    await expect(readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    const b = await fresh('session-b')
    expect(runtime(b.session)).toEqual({ stage: 'outline_generation', status: 'waiting_start' })
    expect(b.session.deriveMessages()).toEqual([])
    executor.canExecute = stage => stage === 'outline_generation'
    expect(await ctx.bid.startStage(b.session)).toEqual({ ok: true, value: { stage: 'outline_generation', status: 'waiting_user' } })
    expect(executor.execute).toHaveBeenCalledOnce()
  })

  it('等待确认投影出现后，目录读取等待操作落盘并返回实际目录', async () => {
    const { ctx, workspace, fresh, executor } = await fixture()
    const outline = await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'outline_generation', status: 'failed' })
    const a = await fresh('session-a')
    executor.canExecute = stage => stage === 'outline_generation'
    const checkpoint = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const release = ctx.on('session/flush', async (session) => {
      if (session === a.session && runtime(session).status === 'waiting_user') {
        checkpoint.resolve(undefined)
        await gate.promise
      }
    }, { global: true })
    const retry = ctx.bid.retryStage(a.session)
    try {
      await checkpoint.promise
      let settled = false
      const draft = ctx.bid.getOutlineDraft(a.session).finally(() => { settled = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      gate.resolve(undefined)
      expect((await retry).ok).toBe(true)
      expect((await draft).outline).toEqual(outline)
    } finally { gate.resolve(undefined); release(); await retry }
  })

  it('后端中断的 running 在原阶段恢复为 failed，保留已有章节', async () => {
    const { workspace, fresh, executor } = await fixture()
    await seedProjectArtifacts(workspace)
    await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'running' })
    const b = await fresh('session-b')
    expect(runtime(b.session)).toEqual({ stage: 'chapter_writing', status: 'failed', failureReason: '阶段执行因后端停止而中断，请重试当前阶段。' })
    expect(await readBidProjectState(workspace)).toMatchObject({ runtime: runtime(b.session) })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('同一真实目录的 Session 共用锁，不同 Workspace 可并行执行', async () => {
    const { ctx, workspace, fresh, executor, host } = await fixture()
    await seedProjectArtifacts(workspace)
    const alias = join(workspace.root, 'workspace-link')
    await symlink(workspace.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const otherRoot = join(workspace.root, 'other-project')
    await mkdir(otherRoot)
    const otherWorkspace = new BidWorkspace(otherRoot)
    const failed = { stage: 'chapter_writing', status: 'failed' } as const
    await checkpointBidProjectState(workspace, failed)
    await checkpointBidProjectState(otherWorkspace, failed)
    const a = await fresh('session-a')
    const b = await fresh('session-b', alias)
    const c = await fresh('session-c', otherRoot)
    const gate = Promise.withResolvers<undefined>()
    executor.canExecute = stage => stage === 'chapter_writing'
    executor.execute = vi.fn(async () => { await gate.promise; return [] })
    const operationA = ctx.bid.retryStage(a.session)
    try {
      await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1))
      expect(await ctx.bid.retryStage(b.session)).toMatchObject({ ok: false, error: { code: 'BID_OPERATION_IN_PROGRESS' } })
      const operationC = ctx.bid.retryStage(c.session)
      await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(2))
      const d = await fresh('session-d', alias, false)
      expect(runtime(d.session)).toEqual({ stage: 'chapter_writing', status: 'running' })
      expect(d.session.deriveMessages()).toEqual([])
      expect(await ctx.bid.getReviewChapter(d.session, 'SEC-1')).toMatchObject({ markdown: '# 技术方案\n\n已有正文。\n' })
      gate.resolve(undefined)
      expect((await operationA).ok).toBe(true)
      expect((await operationC).ok).toBe(true)
      await vi.waitFor(() => expect(host.inFlight.size).toBe(0))
      expect(runtime(d.session)).toEqual({ stage: 'chapter_writing', status: 'completed' })
      expect(executor.execute).toHaveBeenCalledTimes(2)
    } finally { gate.resolve(undefined); await operationA }
  })
})
