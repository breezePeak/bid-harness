/** S5 写作入口完整 Host 运行时与故障场景测试。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  BidHostRuntime,
  BidWorkspace,
  checkpointBidProjectState,
} from '@deepseek-ai/dsh-bid'
import type { WritingEntryView } from '../src/writing-entry-contract.ts'
import type { WritingRequest } from '../src/writing-requirements.ts'
import { WRITING_REQUIREMENT_NONE_OPTION } from '../src/writing-requirements.ts'
import { readWritingEntryStop } from '../src/writing-entry-state.ts'
import { seedProjectArtifacts } from './fixtures/project-session.ts'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise(resolve => setTimeout(resolve, 50))
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

class MockLlmAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: '' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setupS5Fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-s5-runtime-'))
  disposals.push(() => rm(root, { recursive: true, force: true }).catch(() => {}))
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())

  await ctx.plugin(LlmRuntime)
  const adapter = new MockLlmAdapter()
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(BidHostRuntime)

  const workspace = new BidWorkspace(root)
  const outline = await seedProjectArtifacts(workspace)
  await rm(join(workspace.projectRoot, 'chapters/writing-plan.json'), { force: true })
  await rm(join(workspace.projectRoot, 'chapters/writing-request.json'), { force: true })
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'waiting_user' })

  const host = ctx.bid as unknown as {
    inFlight: Map<string, unknown>
    writingEntryStops: Map<string, unknown>
    unsavedWritingAnswers: Map<string, unknown>
    resetStage: InstanceType<typeof BidHostRuntime>['resetStage']
  }

  const createMainAgent = async (id: string, cwd = root) => {
    const handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId(id),
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd, agentPreset: 'bid' },
    })
    await vi.waitFor(() => {
      expect(host.inFlight.size).toBe(0)
    })
    return handle.agent
  }

  return { ctx, workspace, root, outline, createMainAgent, host }
}

/** 从会话事件中读取最新的 WritingEntryView。 */
function latestWritingEntryView(agent: Agent): WritingEntryView | null {
  const events = agent.session.events as readonly { type: string; data: { view?: WritingEntryView } }[]
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event !== undefined && event.type === 'bid.writing_entry.changed' && event.data.view !== undefined) {
      return event.data.view
    }
  }
  return null
}

/** 等待直到 WritingEntryView 满足 predicate。 */
async function waitForView(agent: Agent, predicate: (view: WritingEntryView) => boolean): Promise<WritingEntryView> {
  return vi.waitFor(() => {
    const view = latestWritingEntryView(agent)
    if (view !== null && predicate(view)) return view
    throw new Error('view predicate not satisfied')
  })
}

describe('S5 写作入口运行时测试 (R01-R06)', () => {
  it('R01: 完整入口生命周期 — empty → awaiting_answer → planning → dismissed', async () => {
    const { ctx, workspace, createMainAgent } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let receivedQuestion: AskUserQuestionItem | undefined

    const ask = vi.fn(async ({ questions }: { questions: AskUserQuestionItem[] }) => {
      receivedQuestion = questions[0]
      return questionDeferred.promise
    })
    const dispose = ctx.userQuestions.registerProvider({ ask })

    try {
      const agent = await createMainAgent('r01-agent')

      await vi.waitFor(() => {
        const view = latestWritingEntryView(agent)
        expect(view).not.toBeNull()
        expect(view!.phase).toBe('empty')
      })

      const result = await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      expect(result.ok).toBe(true)

      await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })
      expect(receivedQuestion!.header).toBe('整体写作要求')

      await vi.waitFor(() => {
        const view = latestWritingEntryView(agent)
        expect(view).not.toBeNull()
        expect(view!.phase).toBe('awaiting_answer')
      })

      questionDeferred.resolve({
        answers: [{ id: receivedQuestion!.id, selected: [WRITING_REQUIREMENT_NONE_OPTION] }],
      })

      await vi.waitFor(async () => {
        const record = JSON.parse(await readFile(
          join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8',
        )) as WritingRequest
        expect(record.state).toBe('answered')
      })

      await vi.waitFor(() => {
        const view = latestWritingEntryView(agent)
        expect(view).not.toBeNull()
        expect(view!.phase === 'planning' || view!.phase === 'dismissed' || view!.phase === 'failed').toBe(true)
      })
    } finally {
      questionDeferred.resolve({ answers: [] })
      dispose()
    }
  })

  it('R02: 用户停止后入口进入 paused，停止记录持久化，不能被偷偷继续', async () => {
    const { ctx, workspace, createMainAgent, host } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()

    const ask = vi.fn(async () => questionDeferred.promise)
    const dispose = ctx.userQuestions.registerProvider({ ask })

    try {
      const agent = await createMainAgent('r02-agent')

      await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })

      const stopResult = await ctx.bid.stopRun(agent.session)
      expect(stopResult.accepted).toBe(true)

      await vi.waitFor(() => {
        expect(host.writingEntryStops.size).toBe(0)
      })

      const stop = await readWritingEntryStop(workspace)
      expect(stop).toBeDefined()
      expect(stop!.stop_id).toHaveLength(36)

      await vi.waitFor(() => {
        const view = latestWritingEntryView(agent)
        expect(view).not.toBeNull()
        expect(view!.phase).toBe('paused')
      })

      const resumeResult = await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      expect(resumeResult.ok).toBe(true)

      await vi.waitFor(() => {
        const view = latestWritingEntryView(agent)
        expect(view).not.toBeNull()
        expect(view!.phase).toBe('paused')
      })
    } finally {
      questionDeferred.resolve({ answers: [] })
      dispose()
    }
  })

  it('R03: CAS 冲突 — 旧 expected 被拒绝，新 expected 被接受', async () => {
    const { ctx, createMainAgent } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let receivedQuestion: AskUserQuestionItem | undefined

    const ask = vi.fn(async ({ questions }: { questions: AskUserQuestionItem[] }) => {
      receivedQuestion = questions[0]
      return questionDeferred.promise
    })
    const dispose = ctx.userQuestions.registerProvider({ ask })

    try {
      const agent = await createMainAgent('r03-agent')

      await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })

      const view = await waitForView(agent, v => v.phase === 'awaiting_answer')
      expect(view.expected.request_id).not.toBeNull()

      const staleExpected = { ...view.expected, request_id: 'stale-id' }
      const staleResult = await ctx.bid.requestWritingRequirements(agent.session, {
        mode: 'resume',
        expected: staleExpected,
      })
      expect(staleResult.ok).toBe(false)

      questionDeferred.resolve({
        answers: [{ id: receivedQuestion!.id, selected: [] }],
      })

      await vi.waitFor(() => {
        const v = latestWritingEntryView(agent)
        expect(v).not.toBeNull()
        expect(v!.phase === 'planning' || v!.phase === 'dismissed' || v!.phase === 'failed').toBe(true)
      })
    } finally {
      questionDeferred.resolve({ answers: [] })
      dispose()
    }
  })

  it('R04: dismissed 后可以 reopen 恢复已保存要求', async () => {
    const { ctx, workspace, createMainAgent, host } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()

    const ask = vi.fn(async () => questionDeferred.promise)
    const dispose = ctx.userQuestions.registerProvider({ ask })

    try {
      const agent = await createMainAgent('r04-agent')

      await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })

      const stopResult = await ctx.bid.stopRun(agent.session)
      expect(stopResult.accepted).toBe(true)

      await vi.waitFor(() => {
        const view = latestWritingEntryView(agent)
        expect(view).not.toBeNull()
        expect(view!.phase).toBe('paused')
        expect(view!.expected.stop_id).not.toBeNull()
      })

      const view = latestWritingEntryView(agent)!
      await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
      const reopenResult = await ctx.bid.requestWritingRequirements(agent.session, {
        mode: 'reopen',
        expected: view.expected,
      })
      expect(reopenResult.ok).toBe(true)

      await vi.waitFor(() => {
        const v = latestWritingEntryView(agent)
        expect(v).not.toBeNull()
        expect(v!.phase).toBe('awaiting_answer')
      })

      const record = JSON.parse(await readFile(
        join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8',
      )) as WritingRequest
      expect(record.state).toBe('awaiting_answer')
      expect(record.continuation).toBe('allowed')

      const stop = await readWritingEntryStop(workspace)
      expect(stop).toBeUndefined()
    } finally {
      questionDeferred.resolve({ answers: [] })
      dispose()
    }
  })

  it('R05: autoStartChapterWriting 在停止状态下被拒绝', async () => {
    const { ctx, createMainAgent, host } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()

    const ask = vi.fn(async () => questionDeferred.promise)
    const dispose = ctx.userQuestions.registerProvider({ ask })

    try {
      const agent = await createMainAgent('r05-agent')

      await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })

      await ctx.bid.stopRun(agent.session)

      await vi.waitFor(() => {
        expect(host.writingEntryStops.size).toBe(0)
      })

      const autoResult = await ctx.bid.autoStartChapterWriting(agent.session)
      expect(autoResult.ok).toBe(false)
    } finally {
      questionDeferred.resolve({ answers: [] })
      dispose()
    }
  })

  it('R06: 投影 expected 随状态变化更新，反映当前 request/stop/plan', async () => {
    const { ctx, createMainAgent } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()

    const ask = vi.fn(async () => questionDeferred.promise)
    const dispose = ctx.userQuestions.registerProvider({ ask })

    try {
      const agent = await createMainAgent('r06-agent')

      await vi.waitFor(() => {
        const view = latestWritingEntryView(agent)
        expect(view).not.toBeNull()
        expect(view!.expected.request_id).toBeNull()
        expect(view!.expected.stop_id).toBeNull()
        expect(view!.expected.plan_version).toBeNull()
      })

      await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })

      await vi.waitFor(() => {
        const view = latestWritingEntryView(agent)
        expect(view).not.toBeNull()
        expect(view!.expected.request_id).not.toBeNull()
        expect(view!.expected.attempt_id).not.toBeNull()
      })

      const beforeStop = latestWritingEntryView(agent)!

      await ctx.bid.stopRun(agent.session)

      await vi.waitFor(() => {
        const view = latestWritingEntryView(agent)
        expect(view).not.toBeNull()
        expect(view!.expected.stop_id).not.toBeNull()
        expect(view!.expected.request_id).toBe(beforeStop.expected.request_id)
      })
    } finally {
      questionDeferred.resolve({ answers: [] })
      dispose()
    }
  })
})
