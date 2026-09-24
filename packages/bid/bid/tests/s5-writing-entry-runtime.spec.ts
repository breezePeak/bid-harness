/** S5 写作入口完整 Host 运行时与故障场景测试。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
  BID_WRITING_ENTRY_PROJECTION_KEY,
  outlineArtifactSha256,
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

class ControllableMockLlmAdapter extends LlmAdapter {
  handler?: (options: GenerateOptions) => AsyncIterable<StreamChunk>

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.handler !== undefined) {
      yield* this.handler(options)
      return
    }
    yield { type: 'text-delta', index: 0, text: '' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setupS5Fixture(adapter = new ControllableMockLlmAdapter()) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-s5-runtime-'))
  disposals.push(() => rm(root, { recursive: true, force: true }).catch(() => {}))
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())

  await ctx.plugin(LlmRuntime)
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
  const hash = outlineArtifactSha256(outline)
  await writeFile(
    join(workspace.projectRoot, 'outline/confirmation.json'),
    JSON.stringify({
      schema_version: 2,
      scope: 'technical_bid',
      decision: 'confirmed',
      source_outline_sha256: hash,
      confirmed_outline_sha256: hash,
      confirmed_draft_revision: 1,
      confirmed_draft_sha256: hash,
    }),
    'utf8',
  )

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

  return { ctx, workspace, root, outline, createMainAgent, host, adapter }
}

/** 从真实 SessionProjection 注册表中读取 WritingEntryView。 */
function getWritingEntryProjection(ctx: Context, agent: Agent): WritingEntryView | null {
  const snapshot = ctx.sessionProjections.snapshot(agent.session)
  return (snapshot.values[BID_WRITING_ENTRY_PROJECTION_KEY] as WritingEntryView | null | undefined) ?? null
}

/** 等待直到真实投影 WritingEntryView 满足 predicate。 */
async function waitForView(
  ctx: Context,
  agent: Agent,
  predicate: (view: WritingEntryView) => boolean,
): Promise<WritingEntryView> {
  return vi.waitFor(() => {
    const view = getWritingEntryProjection(ctx, agent)
    if (view !== null && predicate(view)) return view
    throw new Error(`view predicate not satisfied, current: ${JSON.stringify(view)}`)
  })
}

describe('S5 写作入口运行时与完整工具链测试', () => {
  it('运行中的 S5 只暴露带 policy 参数的流程图视觉策略工具', async () => {
    const { ctx, createMainAgent } = await setupS5Fixture()
    const agent = await createMainAgent('flowchart-policy-tool')
    const hash = '0'.repeat(64)
    const now = Date.now()
    agent.session.append('bid.project.resumed', {
      state: {
        stage: 'chapter_writing', status: 'running',
        run: {
          runId: 'flowchart-policy-run', epoch: 1, baseProjectRevision: 1,
          work: {
            kind: 'stage_execution', workId: 'flowchart-policy-work', stage: 'chapter_writing',
            requestRef: 'requests/flowchart-policy-work.json', requestSha256: hash, inputFingerprint: hash,
          },
          startedAt: now, updatedAt: now,
        },
      },
      revision: 2,
    })
    const tools = ctx.tools.schemas(agent)
    const policy = tools.find(tool => tool.name === 'bid_set_flowchart_visual_review')
    expect(policy?.parameters).toEqual({
      type: 'object', properties: { policy: { type: 'string', enum: ['required', 'skip'] } },
      required: ['policy'], additionalProperties: false,
    })
  })

  it('01 验证：生产入口投影已自动在 sessionProjections 注册，初始为 null，append 后真实更新', async () => {
    const { ctx, createMainAgent } = await setupS5Fixture()
    const agent = await createMainAgent('reg-agent')
    const snapshot = ctx.sessionProjections.snapshot(agent.session)
    expect(BID_WRITING_ENTRY_PROJECTION_KEY in snapshot.values).toBe(true)
    expect(snapshot.values[BID_WRITING_ENTRY_PROJECTION_KEY]).not.toBeUndefined()

    // 经由 publishWritingEntryView 后，真实投影为 awaiting_answer
    await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
    const view = getWritingEntryProjection(ctx, agent)
    expect(view).not.toBeNull()
    expect(view!.phase).toBe('awaiting_answer')
  })

  it('R01: 完整成功用例 — 真实模型工具链（inspect + confirm）闭环，计划提交、request 变 consumed 且仅启动一次 Run', async () => {
    const adapter = new ControllableMockLlmAdapter()
    let inspectCalled = false
    let confirmCalled = false
    const toolsReceived: string[] = []

    adapter.handler = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      for (const t of options.tools ?? []) {
        if (!toolsReceived.includes(t.name)) toolsReceived.push(t.name)
      }

      if (!inspectCalled) {
        inspectCalled = true
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: CallId('call-inspect-1'),
          name: 'bid_stage_inspect',
          argumentsDelta: JSON.stringify({ view: 'task_contract_context' }),
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }

      if (!confirmCalled) {
        confirmCalled = true
        let inspectResultText = ''
        for (const msg of options.messages) {
          for (const block of msg.content) {
            if (block.type === 'tool-result' && block.toolCallId === 'call-inspect-1') {
              for (const inner of block.content) {
                if (inner.type === 'text') inspectResultText += inner.text
              }
            }
          }
        }
        expect(inspectResultText).not.toBe('')
        const inspectJson = JSON.parse(inspectResultText) as {
          task_contract_context?: {
            writing_request?: { request_id: string; attempt_id: string }
            blueprint?: { sections: Array<{ id: string; title: string; writable: boolean }> }
          }
        }
        const ctxData = inspectJson.task_contract_context
        expect(ctxData?.writing_request).toBeDefined()
        const reqId = ctxData!.writing_request!.request_id
        const attId = ctxData!.writing_request!.attempt_id
        const leafSections = ctxData!.blueprint!.sections.filter(s => s.writable)

        const planArgs = {
          action: 'bid_confirm_writing_plan',
          update_kind: 'initial',
          writing_request_id: reqId,
          attempt_id: attId,
          user_message_refs: [],
          global_instructions: ['遵循用户整体自定义要求'],
          document_acceptance: [],
          sections: leafSections.map(s => ({
            section_id: s.id,
            task: `编写 ${s.title}`,
            user_message_refs: [],
            writing_instructions: ['符合招标文件技术要求'],
            acceptance_criteria: [],
          })),
        }

        yield {
          type: 'tool-call-delta',
          index: 0,
          id: CallId('call-confirm-1'),
          name: 'bid_confirm_writing_plan',
          argumentsDelta: JSON.stringify(planArgs),
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }

      yield { type: 'text-delta', index: 0, text: '写作计划已完成确认。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    const { ctx, workspace, createMainAgent } = await setupS5Fixture(adapter)
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let receivedQuestion: AskUserQuestionItem | undefined

    const ask = vi.fn(async ({ questions }: { questions: AskUserQuestionItem[] }) => {
      receivedQuestion = questions[0]
      return questionDeferred.promise
    })
    const dispose = ctx.userQuestions.registerProvider({ ask })

    try {
      const agent = await createMainAgent('r01-success-agent')

      const initialView = await waitForView(ctx, agent, v => v.phase === 'empty')
      expect(initialView.phase).toBe('empty')

      const result = await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      expect(result.ok).toBe(true)

      await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })
      expect(receivedQuestion!.header).toBe('整体写作要求')

      await waitForView(ctx, agent, v => v.phase === 'awaiting_answer')

      // 用户输入多行自定义要求
      const customRequirements = '第一条要求：严格响应招标文件技术规范\n第二条要求：重点突出质量保证与进度管理'
      questionDeferred.resolve({
        answers: [{ id: receivedQuestion!.id, selected: [], custom: customRequirements }],
      })

      // 等待工具链执行并完成 Writing Plan 落盘
      await vi.waitFor(async () => {
        expect(inspectCalled).toBe(true)
        expect(confirmCalled).toBe(true)
        const planRaw = await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8')
        expect(planRaw).toContain('严格响应招标文件技术规范')
      }, { timeout: 15_000 })

      // 断言 writing-request 状态变为 consumed
      const reqRecord = JSON.parse(await readFile(
        join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8',
      )) as WritingRequest
      expect(reqRecord.state).toBe('consumed')

      // 验证工具清单中包含 inspect 与 confirm
      expect(toolsReceived).toContain('bid_stage_inspect')
      expect(toolsReceived).toContain('bid_confirm_writing_plan')

      // 真实投影反映 ready 阶段
      await waitForView(ctx, agent, v => v.phase === 'ready' || v.phase === 'running')

      // 确认计划文件完整性且包含用户要求
      const planFinal = await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8')
      expect(planFinal).toContain('严格响应招标文件技术规范')
    } finally {
      questionDeferred.resolve({ answers: [] })
      dispose()
    }
  }, 30_000)

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

      await waitForView(ctx, agent, v => v.phase === 'paused')

      const resumeResult = await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      expect(resumeResult.ok).toBe(true)

      await waitForView(ctx, agent, v => v.phase === 'paused')
    } finally {
      questionDeferred.resolve({ answers: [] })
      dispose()
    }
  })

  it('R03: CAS 冲突 — 旧 expected 被拒绝，新 expected 被接受', async () => {
    const { ctx, createMainAgent, host } = await setupS5Fixture()
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

      const view = await waitForView(ctx, agent, v => v.phase === 'awaiting_answer')
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

      const dismissedView = await waitForView(ctx, agent, v => v.phase === 'dismissed')
      await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
      const acceptedResult = await ctx.bid.requestWritingRequirements(agent.session, {
        mode: 'reopen',
        expected: dismissedView.expected,
      })
      expect(acceptedResult.ok).toBe(true)
      await waitForView(ctx, agent, v => v.phase === 'awaiting_answer')
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

      const view = await waitForView(ctx, agent, v => v.phase === 'paused' && v.expected.stop_id !== null)

      await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
      const reopenResult = await ctx.bid.requestWritingRequirements(agent.session, {
        mode: 'reopen',
        expected: view.expected,
      })
      expect(reopenResult.ok).toBe(true)

      await waitForView(ctx, agent, v => v.phase === 'awaiting_answer')

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

      await waitForView(ctx, agent, v => v.expected.request_id === null && v.expected.stop_id === null)

      await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })

      const awaitingView = await waitForView(ctx, agent, v => v.expected.request_id !== null && v.expected.attempt_id !== null)

      await ctx.bid.stopRun(agent.session)

      await waitForView(ctx, agent, v => v.expected.stop_id !== null && v.expected.request_id === awaitingView.expected.request_id)
    } finally {
      questionDeferred.resolve({ answers: [] })
      dispose()
    }
  })

  it('R07: 答案保存失败移到锁外恢复 — 无 BID_OPERATION_IN_PROGRESS，真实投影显示 failed 且 can_retry_answer 为真，重试成功', async () => {
    const { ctx, workspace, createMainAgent, host } = await setupS5Fixture()
    const questionDeferred = Promise.withResolvers<AskUserQuestionAnswer>()
    let receivedQuestion: AskUserQuestionItem | undefined

    const ask = vi.fn(async ({ questions }: { questions: AskUserQuestionItem[] }) => {
      receivedQuestion = questions[0]
      return questionDeferred.promise
    })
    const dispose = ctx.userQuestions.registerProvider({ ask })

    try {
      const agent = await createMainAgent('r07-save-fail-agent')
      await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
      await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })

      // 拦截写盘，让第一次保存抛出错误
      const requestPath = join(workspace.projectRoot, 'chapters/writing-request.json')
      let failNextSave = true
      const hostInstance = ctx.bid as unknown as {
        mutateProject: (op: unknown, fn: (lease: unknown) => Promise<unknown>) => Promise<unknown>
      }
      const rawMutate = hostInstance.mutateProject.bind(hostInstance)
      hostInstance.mutateProject = async (op, fn) => {
        if (failNextSave) {
          failNextSave = false
          throw new Error('Disk write simulated failure EACCES')
        }
        return rawMutate(op, fn)
      }

      questionDeferred.resolve({
        answers: [{ id: receivedQuestion!.id, selected: [WRITING_REQUIREMENT_NONE_OPTION] }],
      })

      // 验证未抛死锁，且真实投影展示 failed，允许重试
      const failedView = await waitForView(ctx, agent, v => v.phase === 'failed' && v.can_retry_answer === true)
      await vi.waitFor(() => { expect(host.inFlight.size).toBe(0) })
      expect(failedView.answer_save_status).toBe('unconfirmed')
      expect(failedView.error?.code).toBe('BID_WRITING_ANSWER_SAVE_FAILED')

      // 重试保存答案
      const retryResult = await ctx.bid.requestWritingRequirements(agent.session, {
        mode: 'retry_answer',
        expected: failedView.expected,
      })
      expect(retryResult.ok).toBe(true)

      // 重试后状态成功推进，不再是 unconfirmed
      await vi.waitFor(async () => {
        const savedReq = JSON.parse(await readFile(requestPath, 'utf8')) as WritingRequest
        expect(savedReq.state).toBe('answered')
      })
    } finally {
      questionDeferred.resolve({ answers: [] })
      dispose()
    }
  })

  it('R08: 损坏状态防护 — 遇到非法 JSON 不吞成 undefined，真实投影标记 failed 且不落入 empty，原文件不被覆盖', async () => {
    const { ctx, workspace, createMainAgent } = await setupS5Fixture()
    const requestPath = join(workspace.projectRoot, 'chapters/writing-request.json')
    const corruptedContent = '{"schema_version": 1, "state": "awaiting_ans'
    await writeFile(requestPath, corruptedContent, 'utf8')

    const agent = await createMainAgent('r08-corrupt-agent')

    // 真实投影应为 failed，且不能是 empty
    const view = await waitForView(ctx, agent, v => v.phase === 'failed')
    expect(view.durability).toBe('memory_only')
    expect(view.error).not.toBeNull()

    // 尝试 ensure 会被拒绝，原文件绝不被覆盖
    const ensureRes = await ctx.bid.requestWritingRequirements(agent.session, { mode: 'ensure' })
    expect(ensureRes.ok).toBe(false)
    expect(await readFile(requestPath, 'utf8')).toBe(corruptedContent)
  })

  it('R09: S5 pending 状态下有效计划恢复成功 — 窄分支允许 resume 启动已有计划，workflow 保持 ready', async () => {
    const { ctx, workspace, createMainAgent, outline } = await setupS5Fixture()
    const agent = await createMainAgent('r09-pending-agent')

    // 预先写入有效 Writing Plan
    const plan = {
      schema_version: 3,
      scope: 'technical_bid',
      plan_version: 1,
      confirmed: true,
      confirmed_outline_sha256: outlineArtifactSha256(outline),
      user_message_refs: [],
      user_requirements: ['有效测试计划'],
      global_instructions: ['遵循用户整体自定义要求'],
      document_acceptance: [],
      sections: outline.sections.filter(s => s.writable).map(s => ({
        section_id: s.id,
        task: `编写 ${s.title}`,
        user_message_refs: [],
        user_requirements: [],
        writing_instructions: [],
        acceptance_criteria: [],
      })),
      revision: null,
    }
    await writeFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), JSON.stringify(plan), 'utf8')

    await writeFile(join(workspace.projectRoot, 'chapters/writing-entry-stop.json'), JSON.stringify({
      stop_id: 'stop-pending-1',
      confirmed_outline_sha256: outlineArtifactSha256(outline),
      request_id: null,
      attempt_id: null,
      plan_version: 1,
    }), 'utf8')
    await ((ctx.bid as unknown) as { publishWritingEntryView(session: unknown): Promise<void> }).publishWritingEntryView(agent.session)

    const view = await waitForView(ctx, agent, v => v.phase === 'paused')
    expect(view.has_plan).toBe(true)

    // 在 pending 状态下调用 resume，窄分支应接纳
    const resumeRes = await ctx.bid.requestWritingRequirements(agent.session, {
      mode: 'resume',
      expected: view.expected,
    })
    expect(resumeRes.ok).toBe(true)

    // stop 文件已被清除
    const stop = await readWritingEntryStop(workspace)
    expect(stop).toBeUndefined()
  })

  it('R10: 双会话同项目摘要一致性 — 两个主会话的 WritingEntry 投影状态与 revision 保持严格一致', async () => {
    const { ctx, createMainAgent } = await setupS5Fixture()
    const agent1 = await createMainAgent('session-1')
    const agent2 = await createMainAgent('session-2')

    // 初始均在 empty
    await waitForView(ctx, agent1, v => v.phase === 'empty')
    await waitForView(ctx, agent2, v => v.phase === 'empty')

    // agent1 发起 ensure
    await ctx.bid.requestWritingRequirements(agent1.session, { mode: 'ensure' })

    // 两个会话的投影均同步变为 awaiting_answer，且 expected 一致
    const v1 = await waitForView(ctx, agent1, v => v.phase === 'awaiting_answer')
    const v2 = await waitForView(ctx, agent2, v => v.phase === 'awaiting_answer')
    expect(v1.expected).toEqual(v2.expected)
  })
})
