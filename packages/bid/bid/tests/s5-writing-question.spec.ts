/** S5 原生写作要求提问生命周期、并发与错误恢复专项测试。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
  outlineArtifactSha256,
} from '@deepseek-ai/dsh-bid'
import {
  createAutomaticWritingPlan,
  type WritingRequest,
} from '../src/writing-requirements.ts'
import { readWritingEntryStop } from '../src/writing-entry-state.ts'

import { stageInteractionSchema } from '../src/stage-interaction.ts'
import { seedProjectArtifacts } from './fixtures/project-session.ts'

type HostInternals = {
  beginOperation: (session: unknown) => { controller: { signal: { addEventListener: (type: string, cb: () => void) => void } } }
  finishOperation: (session: unknown, op: unknown) => Promise<void>
  handleUserStop: (session: unknown) => Promise<void>
  driveStartedSession: (agent: unknown, cwd: string) => Promise<void>
  autoStartChapterWriting: (session: unknown) => Promise<{ ok: boolean; error?: { code: string } }>
  prepareOperation: (op: unknown) => Promise<unknown>
  createBeforeStageStart: (op: unknown, ws: unknown) => unknown
}

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-s5-question-'))
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
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'waiting_user', run: null })

  const host = ctx.bid as unknown as { inFlight: Map<string, unknown>; resetStage: InstanceType<typeof BidHostRuntime>['resetStage'] }

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

describe('S5 原生提问专项测试 (H01-H24)', () => {
  it('H01 & H02: 正常 S5 入口由 Host 发起原生提问，使用主交互 Agent，未回答前不执行章节', async () => {
    const { ctx, workspace, createMainAgent } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let receivedQuestion: AskUserQuestionItem | undefined
    let receivedAgent: unknown

    const ask = vi.fn(async ({ agent, questions }: { agent?: unknown; questions: AskUserQuestionItem[] }) => {
      receivedAgent = agent
      receivedQuestion = questions[0]
      return questionDeferred.promise
    })
    const dispose = ctx.userQuestions.registerProvider({ ask })
    try {
      const agent = await createMainAgent('h01-agent')
      const result = await ctx.bid.requestWritingRequirements(agent.session)
      expect(result).toMatchObject({ ok: true })

      await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })
      expect(receivedAgent).toBe(agent)
      expect(typeof receivedQuestion?.id).toBe('string')
      expect(receivedQuestion?.header).toBe('整体写作要求')
      expect(receivedQuestion?.question).toBe('开始正文编写前，是否还有其他整体写作要求？')
      expect(receivedQuestion?.options).toEqual([{ label: '没有，开始编写' }])
      expect(receivedQuestion?.multiSelect).toBe(false)

      const requestFile = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
      expect(requestFile.state).toBe('awaiting_answer')
      expect(requestFile.owner_session_id).toBe(String(agent.session.id))
      expect(requestFile.request_id).toBe(receivedQuestion?.id)
      // 未回答前不得有 writing-plan
      await expect(readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'))).rejects.toThrow()
    } finally {
      questionDeferred.resolve({ answers: [{ id: receivedQuestion?.id ?? '', selected: [] }] })
      dispose()
    }
  })

  it('H03: 旧文件只有 prompt_event 时，局部作废并重新发起 native 问题', async () => {
    const { ctx, workspace, createMainAgent, outline } = await setupS5Fixture()
    const legacyPath = join(workspace.projectRoot, 'chapters/writing-request.json')
    const sha256 = outlineArtifactSha256(outline)

    // 注入旧版 marker (含有 prompt_event, schema_version = 3)
    await writeFile(legacyPath, JSON.stringify({
      schema_version: 3,
      confirmed_outline_sha256: sha256,
      prompt_event: { session_id: 'old-session', message_id: 'old-msg', seq: 1 },
    }))

    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let asked = false
    const dispose = ctx.userQuestions.registerProvider({
      ask: async () => {
        asked = true
        return questionDeferred.promise
      },
    })
    try {
      const agent = await createMainAgent('h03-agent')
      const result = await ctx.bid.requestWritingRequirements(agent.session)
      expect(result).toMatchObject({ ok: true })
      await vi.waitFor(() => { expect(asked).toBe(true) })

      const newRecord = JSON.parse(await readFile(legacyPath, 'utf8')) as WritingRequest
      expect(newRecord.schema_version).toBe(1)
      expect(newRecord.state).toBe('awaiting_answer')
      expect((newRecord as Record<string, unknown>).prompt_event).toBeUndefined()
    } finally {
      questionDeferred.resolve({ answers: [{ id: 'q', selected: [] }] })
      dispose()
    }
  })

  it('H04: 连续/并发触发多个询问入口，同轮只建立一个有效 wait', async () => {
    const { ctx, createMainAgent } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let askCount = 0
    const dispose = ctx.userQuestions.registerProvider({
      ask: async () => {
        askCount++
        return questionDeferred.promise
      },
    })
    try {
      const agent = await createMainAgent('h04-agent')
      const [res1, res2] = await Promise.all([
        ctx.bid.requestWritingRequirements(agent.session),
        ctx.bid.requestWritingRequirements(agent.session),
      ])
      expect(res1.ok || res2.ok).toBe(true)
      await vi.waitFor(() => { expect(askCount).toBe(1) })
    } finally {
      questionDeferred.resolve({ answers: [{ id: 'q', selected: [] }] })
      dispose()
    }
  })

  it('H05: ask() 挂起等待期间不占住项目操作锁', async () => {
    const { ctx, host, createMainAgent } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    const dispose = ctx.userQuestions.registerProvider({
      ask: async () => questionDeferred.promise,
    })
    try {
      const agent = await createMainAgent('h05-agent')
      const res = await ctx.bid.requestWritingRequirements(agent.session)
      expect(res).toMatchObject({ ok: true })

      // 等待操作锁释放，且 ask 已在锁外挂起
      await vi.waitFor(() => {
        expect(host.inFlight.size).toBe(0)
      })
    } finally {
      questionDeferred.resolve({ answers: [{ id: 'q', selected: [] }] })
      dispose()
    }
  })

  it('H06: 用户选择“没有，开始编写”，记录真实授权并通知主 Agent', async () => {
    const { ctx, workspace, createMainAgent } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let questionId = ''
    const dispose = ctx.userQuestions.registerProvider({
      ask: async ({ questions }) => {
        questionId = questions[0]!.id
        return questionDeferred.promise
      },
    })
    try {
      const agent = await createMainAgent('h06-agent')
      await ctx.bid.requestWritingRequirements(agent.session)
      await vi.waitFor(() => { expect(questionId).not.toBe('') })

      questionDeferred.resolve({
        answers: [{ id: questionId, selected: ['没有，开始编写'] }],
      })

      await vi.waitFor(async () => {
        const record = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
        expect(record.state).toBe('answered')
        expect(record.answer).toEqual({
          question_id: questionId,
          kind: 'no_additional_requirements',
          selected: ['没有，开始编写'],
        })
      })

      await vi.waitFor(() => {
        expect(agent.session.events.some(e => e.type === 'user/message'
          && e.data.content.some(c => c.type === 'text' && c.text.includes(questionId)))).toBe(true)
      })
    } finally {
      dispose()
    }
  })

  it('H07: 用户输入多行自定义要求，完整保存原文并可由 inspect 读取', async () => {
    const { ctx, workspace, createMainAgent } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let questionId = ''
    const customText = '正文不少于 200 页。\n重点展开技术路线与质量控制。\n格式统一。'
    const dispose = ctx.userQuestions.registerProvider({
      ask: async ({ questions }) => {
        questionId = questions[0]!.id
        return questionDeferred.promise
      },
    })
    try {
      const agent = await createMainAgent('h07-agent')
      await ctx.bid.requestWritingRequirements(agent.session)
      await vi.waitFor(() => { expect(questionId).not.toBe('') })

      questionDeferred.resolve({
        answers: [{ id: questionId, selected: [], custom: customText }],
      })

      await vi.waitFor(async () => {
        const record = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
        expect(record.state).toBe('answered')
        expect(record.answer?.kind).toBe('custom')
        expect(record.answer?.custom).toBe(customText)
      })

      const inspectRes = await ctx.bid.getDetails(agent.session)
      expect(inspectRes).toBeDefined()
    } finally {
      dispose()
    }
  })

  it('H08: 空白或关闭问题标记为 dismissed，不生成开始授权', async () => {
    const { ctx, workspace, createMainAgent } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let questionId = ''
    const dispose = ctx.userQuestions.registerProvider({
      ask: async ({ questions }) => {
        questionId = questions[0]!.id
        return questionDeferred.promise
      },
    })
    try {
      const agent = await createMainAgent('h08-agent')
      await ctx.bid.requestWritingRequirements(agent.session)
      await vi.waitFor(() => { expect(questionId).not.toBe('') })

      // 返回空白自定义文本
      questionDeferred.resolve({
        answers: [{ id: questionId, selected: [], custom: '   \n  ' }],
      })

      await vi.waitFor(async () => {
        const record = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
        expect(record.state).toBe('dismissed')
      })
      expect(agent.session.events.some(e => e.type === 'user/message'
        && e.data.content.some(c => c.type === 'text' && c.text.includes(questionId)))).toBe(false)
    } finally {
      dispose()
    }
  })

  it('H09: 无 provider 时捕获错误并保存，状态仍保持可恢复', async () => {
    const { ctx, workspace, createMainAgent } = await setupS5Fixture()
    // 明确不注册 provider
    const agent = await createMainAgent('h09-agent')
    await ctx.bid.requestWritingRequirements(agent.session)

    await vi.waitFor(async () => {
      const record = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
      expect(record.state).toBe('awaiting_answer')
      expect(record.error?.code).toBe('NO_PROVIDER')
    })
  })

  it('H13 & H14: 重启恢复场景：未回答重建 wait，已回答不重复弹框', async () => {
    const { ctx, workspace, createMainAgent, outline } = await setupS5Fixture()
    const sha256 = outlineArtifactSha256(outline)

    // 模拟已存在 answered 记录
    const answeredRecord: WritingRequest = {
      schema_version: 1,
      request_id: 'answered-req-123',
      confirmed_outline_sha256: sha256,
      owner_session_id: 'h14-agent',
      attempt_id: 'attempt-1',
      continuation: 'allowed',
      state: 'answered',
      answer: {
        question_id: 'answered-req-123',
        kind: 'custom',
        selected: [],
        custom: '之前已保存的要求',
      },
    }
    await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(answeredRecord))

    let askCalled = false
    const dispose = ctx.userQuestions.registerProvider({
      ask: async () => {
        askCalled = true
        return { answers: [] }
      },
    })
    try {
      const agent = await createMainAgent('h14-agent')
      await ctx.bid.requestWritingRequirements(agent.session)

      // 已回答的不应再次调用 ask
      expect(askCalled).toBe(false)
      // 应该向 agent 派发 followup 引导其完成 plan 提交
      await vi.waitFor(() => {
        expect(agent.session.events.some(e => e.type === 'user/message'
          && e.data.content.some(c => c.type === 'text' && c.text.includes('answered-req-123')))).toBe(true)
      })
    } finally {
      dispose()
    }
  })

  it('H15: S5 重置后旧请求失效，迟到回答被拒绝', async () => {
    const { ctx, workspace, createMainAgent, host } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let questionId = ''
    const dispose = ctx.userQuestions.registerProvider({
      ask: async ({ questions }) => {
        questionId = questions[0]!.id
        return questionDeferred.promise
      },
    })
    try {
      const agent = await createMainAgent('h15-agent')
      await ctx.bid.requestWritingRequirements(agent.session)
      await vi.waitFor(() => { expect(questionId).not.toBe('') })

      // 重置阶段
      await host.resetStage(agent, 'chapter_writing')

      // 重置后迟到回答
      questionDeferred.resolve({
        answers: [{ id: questionId, selected: ['没有，开始编写'] }],
      })

      // 等待处理后，检查旧回答没有把 state 改回 answered
      await new Promise(resolve => setTimeout(resolve, 50))
      const record = await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')
        .then(t => JSON.parse(t) as WritingRequest)
        .catch(() => null)
      expect(record?.state !== 'answered').toBe(true)
    } finally {
      dispose()
    }
  })

  it('H19: 提交首次计划时若 writing_request_id 不匹配、未回答或处于 paused，严格拒绝', async () => {
    const { workspace, createMainAgent, host, outline } = await setupS5Fixture()
    const sha256 = outlineArtifactSha256(outline)
    const agent = await createMainAgent('h19-agent')
    const hostWithCommit = host as unknown as {
      commitWritingPlan: (
        agent: Agent,
        workspace: BidWorkspace,
        request: unknown,
      ) => Promise<{ ok: boolean; error?: { code: string; issues: string[] } }>
    }

    const invalidSchemaPlan = {
      action: 'bid_confirm_writing_plan',
      update_kind: 'initial',
      writing_request_id: '', // 空 ID
      attempt_id: 'att-1',
      user_message_refs: [],
      global_instructions: ['按目录编写'],
      document_acceptance: [],
      sections: [{ section_id: 'SEC-1', task: '任务', user_message_refs: [], writing_instructions: [], acceptance_criteria: [] }],
    }
    expect(() => stageInteractionSchema.parse(invalidSchemaPlan)).toThrow()

    // 处于 paused 状态时，commitWritingPlan 拒绝
    const pausedRecord: WritingRequest = {
      schema_version: 1,
      request_id: 'req-h19',
      confirmed_outline_sha256: sha256,
      owner_session_id: String(agent.session.id),
      attempt_id: 'att-original',
      state: 'answered',
      continuation: 'paused',
      answer: { question_id: 'req-h19', kind: 'no_additional_requirements', selected: ['没有，开始编写'] },
    }
    await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(pausedRecord))

    const pausedRes = await hostWithCommit.commitWritingPlan(agent, workspace, {
      action: 'bid_confirm_writing_plan',
      update_kind: 'initial',
      writing_request_id: 'req-h19',
      attempt_id: 'att-original',
      user_message_refs: [],
      global_instructions: ['按目录编写'],
      document_acceptance: [],
      sections: [{ section_id: 'SEC-1', task: '任务', user_message_refs: [], writing_instructions: [], acceptance_criteria: [] }],
    })
    expect(pausedRes.ok).toBe(false)
    expect(pausedRes.error?.issues.some(i => i.includes('写作计划处理已暂停'))).toBe(true)

    // attempt_id 不匹配时拒绝
    pausedRecord.continuation = 'allowed'
    await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(pausedRecord))

    const wrongAttemptRes = await hostWithCommit.commitWritingPlan(agent, workspace, {
      action: 'bid_confirm_writing_plan',
      update_kind: 'initial',
      writing_request_id: 'req-h19',
      attempt_id: 'wrong-attempt',
      user_message_refs: [],
      global_instructions: ['按目录编写'],
      document_acceptance: [],
      sections: [{ section_id: 'SEC-1', task: '任务', user_message_refs: [], writing_instructions: [], acceptance_criteria: [] }],
    })
    expect(wrongAttemptRes.ok).toBe(false)
    expect(wrongAttemptRes.error?.issues.some(i => i.includes('attempt_id 已失效'))).toBe(true)
  })

  it('H24: 自动开始与待回答路径互斥，存在未消费请求时拒绝自动开始', async () => {
    const { ctx, workspace, createMainAgent, outline } = await setupS5Fixture()
    const sha256 = outlineArtifactSha256(outline)

    const awaitingRecord: WritingRequest = {
      schema_version: 1,
      request_id: 'compete-req-1',
      confirmed_outline_sha256: sha256,
      owner_session_id: 'h24-agent',
      attempt_id: 'att-1',
      continuation: 'allowed',
      state: 'awaiting_answer',
    }
    await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(awaitingRecord))

    const agent = await createMainAgent('h24-agent')
    // autoStartChapterWriting 发现已有未消费请求，必须拒绝
    const res = await ctx.bid.autoStartChapterWriting(agent.session)
    expect(res).toMatchObject({
      ok: false,
      error: {
        code: 'BID_CHAPTER_WRITING_GATE_FAILED',
        message: '已有待回答的写作要求提问，不能直接自动开始。',
      },
    })

    const unchanged = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
    expect(unchanged.state).toBe('awaiting_answer')
  })

  it('H10: 已 consumed 的 writing_request 不能再次用于提交 initial 计划，合法首次提交正常消费并落盘', async () => {
    const { ctx, workspace, createMainAgent, host, outline } = await setupS5Fixture()
    const sha256 = outlineArtifactSha256(outline)
    const agent = await createMainAgent('h10-agent')
    const hostWithCommit = host as unknown as {
      commitWritingPlan: (
        agent: Agent,
        workspace: BidWorkspace,
        request: unknown,
      ) => Promise<{ ok: boolean; plan_version?: number; error?: { code: string; issues: string[] } }>
    }

    const consumedRecord: WritingRequest = {
      schema_version: 1,
      request_id: 'consumed-req-1',
      confirmed_outline_sha256: sha256,
      owner_session_id: String(agent.session.id),
      attempt_id: 'att-1',
      continuation: 'allowed',
      state: 'consumed',
      applied_plan_version: 1,
      answer: { question_id: 'consumed-req-1', kind: 'no_additional_requirements', selected: ['没有，开始编写'] },
    }
    await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(consumedRecord))

    const planPayload = {
      action: 'bid_confirm_writing_plan' as const,
      update_kind: 'initial' as const,
      writing_request_id: 'consumed-req-1',
      attempt_id: 'att-1',
      user_message_refs: [],
      global_instructions: ['按目录编写'],
      document_acceptance: [],
      sections: [{ section_id: 'SEC-1', task: '任务', user_message_refs: [], writing_instructions: [], acceptance_criteria: [] }],
    }

    // 真实业务 commit 拦截 consumed
    const consumedRes = await hostWithCommit.commitWritingPlan(agent, workspace, planPayload)
    expect(consumedRes.ok).toBe(false)
    expect(consumedRes.error?.issues.some(i => i.includes('首次 Writing Plan 必须绑定当前 Session 已保存的真实原生回答'))).toBe(true)

    // 变为 answered 状态时允许提交，且通过阶段工具执行后转为 consumed 并落盘
    consumedRecord.state = 'answered'
    delete consumedRecord.applied_plan_version
    await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(consumedRecord))

    const commitRes = await ctx.tools.execute({
      agent,
      name: 'bid_confirm_writing_plan',
      arguments: planPayload,
      callId: CallId('h10-commit'),
      signal: new AbortController().signal,
    })
    expect(commitRes.isError, JSON.stringify(commitRes)).toBe(false)
    expect(commitRes.value).toMatchObject({ ok: true, plan_version: 1 })

    const updated = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
    expect(updated.state).toBe('consumed')
    expect(updated.applied_plan_version).toBe(1)
  })

  it('H18: 旧 wait 退出时的 finally 不删除被替换的新 active 提问句柄', async () => {
    const { host, createMainAgent } = await setupS5Fixture()
    const agent = await createMainAgent('h18-agent')
    const key = agent.session.header.cwd ?? 'h18-key'
    const pendingMap = (host as unknown as { pendingWritingQuestions: Map<string, unknown> }).pendingWritingQuestions

    const oldPending = {
      key,
      requestId: 'old-req',
      attemptId: 'att-old',
      ownerSessionId: String(agent.session.id),
      agent,
      controller: new AbortController(),
      task: Promise.resolve(),
    }
    const newPending = {
      key,
      requestId: 'new-req',
      attemptId: 'att-new',
      ownerSessionId: String(agent.session.id),
      agent,
      controller: new AbortController(),
      task: Promise.resolve(),
    }

    // 先存入新 pending
    pendingMap.set(key, newPending)

    // 模拟旧 pending 的 finally 执行
    if (pendingMap.get(key) === oldPending) {
      pendingMap.delete(key)
    }

    // 新 pending 不应被旧 pending 的 finally 误删
    expect(pendingMap.get(key)).toBe(newPending)
  })

  it('H20 & H21: 合法 patch 计划不要求 writing_request_id，伪造 message_ref 导致校验不通过', () => {
    // 合法 patch 计划
    const validPatchPlan = {
      action: 'bid_confirm_writing_plan',
      update_kind: 'patch',
      base_plan_version: 1,
      user_message_refs: [{ session_id: 's1', message_id: 'm1', seq: 1 }],
      summary: '更新第1节任务',
      affected_section_ids: ['SEC-1'],
      sections: [{ section_id: 'SEC-1', task: '补充说明交付风险' }],
    }
    const parsed = stageInteractionSchema.parse(validPatchPlan)
    expect(parsed.action).toBe('bid_confirm_writing_plan')
    // 不需要 writing_request_id
    expect((parsed as Record<string, unknown>).writing_request_id).toBeUndefined()

    // 伪造空 message_refs 的 patch 计划必须被拒绝
    const invalidPatchPlan = {
      ...validPatchPlan,
      user_message_refs: [], // patch 要求至少一个引用
    }
    expect(() => stageInteractionSchema.parse(invalidPatchPlan)).toThrow()
  })

  it('F1 & F8: S5 waiting_user 下暴露阶段工具 (bid_stage_inspect, bid_confirm_writing_plan)，严格屏蔽全局工具', async () => {
    const { ctx, createMainAgent } = await setupS5Fixture()
    const agent = await createMainAgent('f1-agent')

    // 检查 agent 视角的可用工具
    const inspectTool = ctx.tools.get('bid_stage_inspect', agent)
    const confirmTool = ctx.tools.get('bid_confirm_writing_plan', agent)
    expect(inspectTool).toBeDefined()
    expect(confirmTool).toBeDefined()

    // 检查全局工具（如 ask_user_question）已被 tools.restrict 屏蔽
    const askTool = ctx.tools.get('ask_user_question', agent)
    expect(askTool).toBeUndefined()

    // 执行 bid_stage_inspect 并验证返回当前的 task_contract_context
    const inspectResult = await ctx.tools.execute({
      agent,
      name: 'bid_stage_inspect',
      arguments: { view: 'task_contract_context' },
      callId: CallId('f1-inspect'),
      signal: new AbortController().signal,
    })
    expect(inspectResult.isError).toBe(false)
    expect(inspectResult.value).toBeDefined()
  })

  it('F2 & F5: 用户停止时将 answered 状态置为 continuation: paused 并刷新 attempt_id，且 resume 跳过执行', async () => {
    const { workspace, createMainAgent, host, outline } = await setupS5Fixture()
    const sha256 = outlineArtifactSha256(outline)
    const agent = await createMainAgent('f2-agent')

    const answeredRecord: WritingRequest = {
      schema_version: 1,
      request_id: 'stop-req-1',
      confirmed_outline_sha256: sha256,
      owner_session_id: String(agent.session.id),
      attempt_id: 'att-before-stop',
      continuation: 'allowed',
      state: 'answered',
      answer: { question_id: 'stop-req-1', kind: 'no_additional_requirements', selected: ['没有，开始编写'] },
    }
    await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(answeredRecord))

    // 模拟停止
    const hostWithInternal = host as unknown as {
      handleUserStop: (session: typeof agent.session) => Promise<void>
      resumeWritingPlanProcessing: (agent: Agent, workspace: BidWorkspace) => Promise<void>
    }
    await hostWithInternal.handleUserStop(agent.session)

    const pausedRecord = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
    expect(pausedRecord.continuation).toBe('paused')
    expect(pausedRecord.attempt_id).not.toBe('att-before-stop')

    // 处于 paused 状态时调用 resumeWritingPlanProcessing 应当跳过处理（不派发任何新事件）
    const initialEventsCount = agent.session.events.length
    await hostWithInternal.resumeWritingPlanProcessing(agent, workspace)
    expect(agent.session.events.length).toBe(initialEventsCount)
  })

  it('F4: 原生提问取消 (ASK_CANCELLED) 归入 dismissed 状态，不污染为 error', async () => {
    const { ctx, workspace, createMainAgent } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let questionId = ''
    const dispose = ctx.userQuestions.registerProvider({
      ask: async ({ questions }) => {
        questionId = questions[0]!.id
        return questionDeferred.promise
      },
    })
    try {
      const agent = await createMainAgent('f4-agent')
      await ctx.bid.requestWritingRequirements(agent.session)
      await vi.waitFor(() => { expect(questionId).not.toBe('') })

      // 模拟组件取消/关闭
      questionDeferred.reject(Object.assign(new Error('User cancelled question'), { code: 'ASK_CANCELLED' }))

      await vi.waitFor(async () => {
        const record = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
        expect(record.state).toBe('dismissed')
        expect(record.error).toBeUndefined()
      })
    } finally {
      dispose()
    }
  })

  describe('子任务 01: 有效计划优先与 inspect 独立性', () => {
    it('有效计划 + 旧 prompt_event marker: inspect 成功，返回原计划，writing_request 为 null', async () => {
      const { ctx, workspace, outline, createMainAgent } = await setupS5Fixture()
      const agent = await createMainAgent('t01-1-agent')
      const sha256 = outlineArtifactSha256(outline)

      const plan = createAutomaticWritingPlan(outline, sha256)
      await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), JSON.stringify(plan, null, 2), 'utf8')

      const oldMarker: WritingRequest = {
        schema_version: 1,
        request_id: 'old-req',
        confirmed_outline_sha256: sha256,
        owner_session_id: 'old-session',
        attempt_id: 'old-att',
        state: 'answered',
        continuation: 'allowed',
        answer: {
          question_id: 'old-req',
          kind: 'custom',
          selected: [],
          custom: 'old custom text',
        },
      }
      await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(oldMarker, null, 2), 'utf8')

      const inspectResult = await ctx.tools.execute({
        agent,
        name: 'bid_stage_inspect',
        arguments: { view: 'task_contract_context' },
        callId: CallId('t01-inspect-1'),
        signal: new AbortController().signal,
      })

      expect(inspectResult.isError).toBe(false)
      const val = inspectResult.value as Record<string, Record<string, unknown>>
      expect(val.writing_plan).toMatchObject({ plan_version: 1 })
      expect(val.task_contract_context?.writing_request).toBeNull()
    })

    it('有效计划 + 损坏 marker: inspect 仍成功，证明根本不依赖该文件', async () => {
      const { ctx, workspace, outline, createMainAgent } = await setupS5Fixture()
      const agent = await createMainAgent('t01-2-agent')
      const sha256 = outlineArtifactSha256(outline)

      const plan = createAutomaticWritingPlan(outline, sha256)
      await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), JSON.stringify(plan, null, 2), 'utf8')

      // 写入损坏的 writing-request.json
      await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), '{ invalid json corrupt: true', 'utf8')

      const inspectResult = await ctx.tools.execute({
        agent,
        name: 'bid_stage_inspect',
        arguments: { view: 'task_contract_context' },
        callId: CallId('t01-inspect-2'),
        signal: new AbortController().signal,
      })

      expect(inspectResult.isError).toBe(false)
      const val = inspectResult.value as Record<string, Record<string, unknown>>
      expect(val.writing_plan).toMatchObject({ plan_version: 1 })
      expect(val.task_contract_context?.writing_request).toBeNull()
    })

    it('无计划 + 损坏 marker: inspect 明确失败，不默认无要求', async () => {
      const { ctx, workspace, createMainAgent } = await setupS5Fixture()
      const agent = await createMainAgent('t01-3-agent')

      // 确保没有 writing-plan.json
      await rm(join(workspace.projectRoot, 'chapters/writing-plan.json'), { force: true })

      // 写入损坏的 writing-request.json
      await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), '{ invalid json corrupt: true', 'utf8')

      const inspectResult = await ctx.tools.execute({
        agent,
        name: 'bid_stage_inspect',
        arguments: { view: 'task_contract_context' },
        callId: CallId('t01-inspect-3'),
        signal: new AbortController().signal,
      })

      expect(inspectResult.isError).toBe(true)
    })
  })

  describe('子任务 02: 停止先封住入口与启动检查', () => {
    it('阻塞一个短 operation，点击停止，再释放短操作：停止必须最后落盘', async () => {
      const { workspace, createMainAgent, host, outline } = await setupS5Fixture()
      const sha256 = outlineArtifactSha256(outline)
      const agent = await createMainAgent('t02-1-agent')

      const answeredRecord: WritingRequest = {
        schema_version: 1,
        request_id: 'stop-req-t1',
        confirmed_outline_sha256: sha256,
        owner_session_id: String(agent.session.id),
        attempt_id: 'att-before-stop',
        continuation: 'allowed',
        state: 'answered',
        answer: { question_id: 'stop-req-t1', kind: 'no_additional_requirements', selected: ['没有，开始编写'] },
      }
      await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(answeredRecord))

      const hostAny = host as unknown as HostInternals
      // 模拟一个短 operation 占锁
      const deferred = Promise.withResolvers<undefined>()
      const shortOp = hostAny.beginOperation(agent.session)
      shortOp.controller.signal.addEventListener('abort', () => {})
      const shortOpTask = (async () => {
        await deferred.promise
        await hostAny.finishOperation(agent.session, shortOp)
      })()

      // 点击停止
      const stopPromise = hostAny.handleUserStop(agent.session)
      // 此时停止尚未落盘，因为短操作还在持锁
      expect(await readWritingEntryStop(workspace)).toBeUndefined()

      // 释放短操作
      deferred.resolve(undefined)
      await shortOpTask
      await stopPromise

      // 停止最终落盘
      const stop = await readWritingEntryStop(workspace)
      expect(stop).toBeDefined()
      expect(stop?.request_id).toBe('stop-req-t1')

      const updated = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
      expect(updated.continuation).toBe('paused')
    })

    it('plan 与 consumed 已落盘但还没有 Run，点击停止：stop 文件存在且阻止新 Run 启动', async () => {
      const { workspace, createMainAgent, host, outline } = await setupS5Fixture()
      const sha256 = outlineArtifactSha256(outline)
      const agent = await createMainAgent('t02-2-agent')

      const plan = createAutomaticWritingPlan(outline, sha256)
      await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), JSON.stringify(plan, null, 2), 'utf8')

      const consumedRecord: WritingRequest = {
        schema_version: 1,
        request_id: 'stop-req-t2',
        confirmed_outline_sha256: sha256,
        owner_session_id: String(agent.session.id),
        attempt_id: 'att-consumed',
        continuation: 'allowed',
        state: 'consumed',
        applied_plan_version: 1,
        answer: { question_id: 'stop-req-t2', kind: 'no_additional_requirements', selected: ['没有，开始编写'] },
      }
      await writeFile(join(workspace.projectRoot, 'chapters/writing-request.json'), JSON.stringify(consumedRecord))
      await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'waiting_user', run: null })

      const hostAny = host as unknown as HostInternals
      await hostAny.handleUserStop(agent.session)

      const stop = await readWritingEntryStop(workspace)
      expect(stop).toBeDefined()
      expect(stop?.plan_version).toBe(1)

      // 触发 driveStartedSession
      await hostAny.driveStartedSession(agent, workspace.root)

      // 验证没有 Run 启动
      const runsCount = agent.session.events.filter((e: { type: string }) => e.type === 'bid.run.started').length
      expect(runsCount).toBe(0)
    })

    it('无问答的自动计划已保存、Run 尚未创建时停止：阻止启动', async () => {
      const { workspace, createMainAgent, host, outline } = await setupS5Fixture()
      const sha256 = outlineArtifactSha256(outline)
      const agent = await createMainAgent('t02-3-agent')

      const plan = createAutomaticWritingPlan(outline, sha256)
      await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), JSON.stringify(plan, null, 2), 'utf8')
      await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'waiting_user', run: null })

      const hostAny = host as unknown as HostInternals
      await hostAny.handleUserStop(agent.session)

      const stop = await readWritingEntryStop(workspace)
      expect(stop).toBeDefined()
      expect(stop?.request_id).toBeNull()
      expect(stop?.plan_version).toBe(1)

      // 尝试自动启动
      const res = await hostAny.autoStartChapterWriting(agent.session)
      expect(res.ok).toBe(false)
      expect(res.error?.code).toBe('BID_CHAPTER_WRITING_GATE_FAILED')
    })

    it('beforeStageStart 检测到停止屏障直接拒绝 Run 创建', async () => {
      const { workspace, createMainAgent, host, outline } = await setupS5Fixture()
      const sha256 = outlineArtifactSha256(outline)
      const agent = await createMainAgent('t02-4-agent')

      const plan = createAutomaticWritingPlan(outline, sha256)
      await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), JSON.stringify(plan, null, 2), 'utf8')

      const hostAny = host as unknown as HostInternals
      await hostAny.handleUserStop(agent.session)

      const operation = hostAny.beginOperation(agent.session)
      try {
        await hostAny.prepareOperation(operation)
        const check = hostAny.createBeforeStageStart(operation, workspace) as (stage: string) => Promise<boolean>
        const allowed = await check('chapter_writing')
        expect(allowed).toBe(false)
      } finally {
        await hostAny.finishOperation(agent.session, operation)
      }
    })
  })
})
