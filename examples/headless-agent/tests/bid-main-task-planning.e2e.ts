/** 自然语言 Main 任务的真实模型验收；保留全部会话和产物，禁止人工续行或补工具参数。 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { BidHostRuntime, DEFAULT_BID_CONFIG, parseOutlineArtifact, readBidProjectState } from '@deepseek-ai/dsh-bid'
import { describe, expect, it } from 'vitest'
import { seedMainTaskPlanningProject } from '../../../packages/bid/bid/tests/fixtures/main-task-planning-loop.ts'
import { collectDocxExportSnapshot } from '../../../packages/bid/bid/src/docx-export.ts'
import { readChapterLocations } from '../../../packages/bid/bid/src/chapter-storage.ts'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const provider = process.env.DSH_BID_EVAL_PROVIDER ?? 'deepseek-official'
const model = process.env.DSH_BID_EVAL_MODEL ?? 'deepseek-v4-flash'
const split = '只修改本章 S2.3，把三个阶段拆成真实目录子章节，保留原文、表格和流程图并完成正文和审核。不要改其他章节。'
const cases = [
  { id: 'A02-1', text: split }, { id: 'A02-2', text: split }, { id: 'A02-3', text: split },
  { id: 'A02-six', text: '只修改本章 S2.3，拆成收集输入、边界确认、校验结果、内业处理、复核整改、交付成果六个真实目录子章节。完整迁移原文，每个原文块唯一归属，表题和完整表格同章，流程图完整保留；原文不必分到每个子章，但所有六章都必须完成正文和独立审核，未分配原文的子章也要写完。不改其他章节，不虚构资料、人员、设备、标准或固定格式。' },
  { id: 'A02-clarification', text: 'S2.3', clarification: '本章也需要小章节。把三个阶段拆成真实目录子章节，保留原文、表格和流程图，并完成正文和审核。不要改其他章节；具体是哪章等我确认后再执行。' },
  { id: 'A03', text: '只修改 S2.3 中“流程一：收集输入。”这一个选区，将“收集输入”改为“收集并登记输入”，完成本次修订和审核。选区外所有字节、空白、锚点及目录均保持不变。' },
  { id: 'A04', text: split + '这是隔离测试项目中的授权故障注入验收：请提交第一份仅含正文修订、缺少目录修改的计划，验证 Host 必须据实拒绝；随后立即在同一 Work 自行修正计划并完成上述全部要求。不要直接提交完整计划跳过故障注入，不需要我继续催促。' },
  { id: 'A14', text: '更正第一条招标要求，将 REQ-1 的要求改为“回答主题1并保持可追踪交付”，只修改这条需求，不修改正文和目录。在当前阶段运行中登记排队，完成后主动报告实际结果。' },
]

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const evaluationSources = Object.fromEntries(await Promise.all([
  'packages/bid/bid/src/index.ts', 'packages/bid/bid/src/bid-model-task.ts',
  'packages/bid/bid/src/bid-capability-task.ts', 'packages/bid/bid/src/bid-task-verification.ts',
  'packages/bid/bid/src/bid-task-source.ts', 'packages/bid/bid/src/stage-interaction.ts',
  'packages/bid/bid/src/chapter-writing-executor.ts', 'packages/bid/bid/src/chapter-writing-writer.ts',
  'packages/bid/bid/src/bid-outline-capabilities.ts', 'packages/bid/bid/src/outline-capability-update.ts',
  'packages/bid/bid/src/bid-writing-capability.ts',
  'examples/headless-agent/tests/bid-main-task-planning.e2e.ts',
].map(async (path) => {
  const content = await readFile(new URL('../../../' + path, import.meta.url), 'utf8')
  return [path, sha256(content)] as const
})))

describe.skipIf(!process.env.DEEPSEEK_API_KEY && !process.env.DSH_BID_EVAL_PROVIDER)('真实模型 Main 自主任务规划', () => {
  for (const scenario of cases) it(scenario.id, { timeout: scenario.id === 'A02-six' ? 1_860_000 : 900_000, retry: 0 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-main-' + scenario.id + '-'))
    const ctx = new Context()
    const report: Record<string, unknown> = { scenario: scenario.id, provider, model, root,
      input: scenario.text, status: 'running', started_at: new Date().toISOString(),
      source_sha256: evaluationSources,
      fixture: '已完成五章的确定性历史项目，工作流程使用完整虚构采购条款及评分来源；历史完成态不是实际模型写作证明。全部本次规划、执行和核验调用使用真实 Provider。' }
    const reportPath = join(root, '验收记录.json')
    const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
    // 六章包含独立写作、审核及全任务核验，保留语义整改所需的真实模型调用时间。
    const deadline = AbortSignal.timeout(scenario.id === 'A02-six' ? 1_800_000 : 840_000)
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(FileSettingsProvider, { dshHome: home, watch: false })
      await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
      await ctx.plugin(AttachmentLocal, { dshHome: join(root, '.dsh') })
      if (provider === 'deepseek-official') await ctx.plugin(DeepSeek,
        process.env.DEEPSEEK_BASE_URL === undefined ? {} : { baseURL: process.env.DEEPSEEK_BASE_URL })
      else await ctx.plugin(PiAi, {})
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
      await ctx.plugin(SystemPrompt, { persona: '根据当前项目、用户原话和工具契约执行标书任务，不虚构资料或完成结果。' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(LocalSubprocess)
      await ctx.plugin(ToolFs)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(spawn, { providerName: 'spawn' })
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(UserQuestionService)
      await ctx.plugin(BidHostRuntime, { ...DEFAULT_BID_CONFIG,
        allowedExtensions: [...DEFAULT_BID_CONFIG.allowedExtensions], modelStageRepairAttempts: 2,
        evidenceMappingMaxConcurrency: 2, chapterWritingMaxConcurrency: 2, chapterWritingCompletionRepairRounds: 2,
        trustedHosts: [], webSearchEnabled: false, wordFormatMaxTokens: 8192, wordFormatTimeoutMs: 120_000, bidderName: '我方' })
      const workspace = await seedMainTaskPlanningProject(root, true)
      const outlineBefore = await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')
      const bodyBefore = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
      const outsideBefore = await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')
      report.before = { outline_sha256: sha256(outlineBefore), outline: JSON.parse(outlineBefore) as unknown,
        body_sha256: sha256(bodyBefore), body_markdown: bodyBefore, outside_sha256: sha256(outsideBefore) }
      await save()
      const stageStarted = Promise.withResolvers<undefined>()
      const taskDone = Promise.withResolvers<undefined>()
      let priorWorkId: string | undefined
      ctx.on('session/event', (session, event) => {
        if (String(session.id) !== 'real-main-' + scenario.id) return
        if (scenario.id === 'A14' && event.type === 'bid.run.started' && priorWorkId === undefined) {
          priorWorkId = event.data.run.work.workId
          report.prior_work_id = priorWorkId
          stageStarted.resolve(undefined)
        }
        if (event.type === 'bid.run.notice' && event.data.kind === 'completed' && event.data.workId !== priorWorkId && session.events.some(item =>
          item.type === 'bid.run.started' && item.data.run.work.kind === 'capability_task'
          && item.data.run.work.workId === event.data.workId)) taskDone.resolve(undefined)
      })
      if (scenario.id === 'A14') {
        report.initial_run = '真实用户前置审查任务，由模型自主规划；新更正任务在同一 Main、已有 Work 运行中登记排队。'
      }
      const createMain = (id: string) => ctx.agentLoop.createAgent(ctx, { sessionId: SessionId(id),
        agentOptions: { provider, model }, meta: { cwd: root, agentPreset: 'bid' } })
      const handle = await createMain('real-main-' + scenario.id)
      const agent = handle.agent
      if (scenario.id === 'A03' || scenario.id === 'A04') {
        const log = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/execution-log.json'), 'utf8')) as {
          sections: Array<{ section_id: string; final_writer_child_session_id: string | null }>
        }
        const original = log.sections.find(section => section.section_id === 'S2.3')
        if (original?.final_writer_child_session_id == null) throw new Error('初始项目没有原 Writer 身份')
        const childId = SessionId(original.final_writer_child_session_id)
        await ctx.subagents.startContinuable({ provider: 'spawn', childId, label: 'S2.3 原 Writer 历史', signal: deadline,
          request: { parent: agent, maxDepth: 1, toolFilter: { allow: [] },
            prompt: [{ type: 'text', text: '以下是当前已保存的 S2.3 原正文。现在仅确认已读取，不修改或审核；后续在本会话接收真实修订任务。\n' + bodyBefore }] } })
        const writer = ctx.agents.get(childId)
        if (writer === undefined) throw new Error('原 Writer 历史会话未建立')
        await writer.whenIdle()
        const end = writer.session.events.findLast(event => event.type === 'turn/end')
        report.original_writer_history = { child_id: childId, turn_end: end }
        if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed') throw new Error('原 Writer 真实历史回合未完成')
        await ctx.sessions.flush(writer.session)
        await ctx.subagents.drainContinuableChildren(agent, [childId])
        await agent.whenIdle()
      }
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'bid.run.notice') { report.latest_notice = event.data; void save() }
      })
      const aborted = new Promise<never>((_resolve, reject) => { deadline.addEventListener('abort', () => {
        agent.cancel({ kind: 'user' })
        reject(new Error('真实模型验收超时，保留全部运行证据。'))
      }, { once: true }) })
      if ('clarification' in scenario && scenario.clarification !== undefined) {
        report.prior_input = scenario.clarification
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: scenario.clarification }] }))
        await Promise.race([agent.whenIdle(), aborted])
        expect(agent.session.events.some(event => event.type === 'bid.run.started')).toBe(false)
        expect(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')).toBe(outlineBefore)
      }
      if (scenario.id === 'A14') {
        const priorText = '仅审查当前 S2.3（章节1），交付实际审查报告。发现问题也只记录在报告中，不修复正文、不修改目录。'
        report.prior_input = priorText
        const priorMessage = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: priorText }] })
        const priorClaimed = Promise.withResolvers<undefined>()
        const liftPriorClaim = ctx.on('session/event', (session, event) => {
          if (session === agent.session && event.type === 'user/message' && event.data.id === priorMessage.id) priorClaimed.resolve(undefined)
        })
        agent.followup(priorMessage)
        try { await Promise.race([priorClaimed.promise, aborted]) } finally { liftPriorClaim() }
        await Promise.race([stageStarted.promise, agent.whenIdle().then(() => {
          if (priorWorkId === undefined) throw new Error('前置真实用户审查任务未启动 Work')
        }), aborted])
      }
      const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: scenario.text }] })
      const claimed = Promise.withResolvers<undefined>()
      const liftClaim = ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'user/message' && event.data.id === message.id) claimed.resolve(undefined)
      })
      agent.followup(message)
      try { await Promise.race([claimed.promise, aborted]) } finally { liftClaim() }
      await Promise.race([agent.whenIdle(), aborted])
      // Main 工具提交的 Run 在后台执行；只观察 Host 完成，不干预计划或追加用户输入。
      const host = ctx.bid as unknown as { readonly inFlight: Map<string, { readonly done: Promise<unknown> }> }
      while (host.inFlight.size > 0) {
        await Promise.race([Promise.all([...host.inFlight.values()].map(operation => operation.done)), aborted])
        await Promise.race([agent.whenIdle(), aborted])
      }
      if (scenario.id === 'A14') {
        await Promise.race([taskDone.promise, aborted])
        await Promise.race([agent.whenIdle(), aborted])
      }
      const state = await readBidProjectState(workspace)
      report.state = state
      const outlineAfter = await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')
      const outline = parseOutlineArtifact(JSON.parse(outlineAfter))
      const children = outline.sections.filter(section => section.parent_id === 'S2.3')
      const locations = await readChapterLocations(workspace)
      const bodies = await Promise.all(children.map(async (section) => {
        const location = locations.get(section.id)
        if (location === undefined) throw new Error('真实新叶节缺少正文位置：' + section.id)
        return readFile(join(workspace.projectRoot, location.contentPath), 'utf8')
      }))
      const events = agent.session.events
      report.tools = events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
      report.notices = events.filter(event => event.type === 'bid.run.notice')
      report.turn_ends = events.filter(event => event.type === 'turn/end')
      const failedTurn = events.findLast(event => event.type === 'turn/end')
      if (failedTurn?.type === 'turn/end' && failedTurn.data.reason.kind === 'error') {
        throw new Error('REAL_MODEL_CALL_FAILED: ' + JSON.stringify(failedTurn.data.reason.error))
      }
      const requests = await readdir(join(workspace.projectRoot, 'requests'), { withFileTypes: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      const receipts = await Promise.all(requests.filter(entry => entry.isDirectory()).map(async ({ name: workId }) => {
        try { return JSON.parse(await readFile(join(workspace.projectRoot, 'requests', workId, 'result.json'), 'utf8')) as unknown }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      }))
      report.receipts = receipts
      if ('clarification' in scenario && scenario.clarification !== undefined) {
        const start = events.find(event => event.type === 'bid.run.started')
        if (start?.type !== 'bid.run.started') throw new Error('澄清任务没有已接纳 Work')
        const { capabilityTaskRequestSchema } = await import('../../../packages/bid/bid/src/bid-capability-task.ts')
        const { readBidWorkRequest } = await import('../../../packages/bid/bid/src/work-descriptor.ts')
        const source = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, start.data.run.work)).source_snapshot
        report.source_snapshot = source
        expect(source?.message.text).toBe('S2.3')
        expect(source?.context_messages?.map(item => item.text)).toEqual([scenario.clarification])
      }
      report.after = { outline_sha256: sha256(outlineAfter), outline, children,
        source_body_markdown: await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8'),
        children_bodies: bodies, body_sha256: await Promise.all(children.map(async (section) => {
          const location = locations.get(section.id)!
          return { section_id: section.id, sha256: sha256(await readFile(join(workspace.projectRoot, location.contentPath), 'utf8')) }
        })) }
      expect(scenario.id === 'A14' ? ['completed', 'waiting_user'].includes(state?.status ?? '') : state?.status === 'completed').toBe(true)
      expect(receipts.some(receipt => receipt !== null && typeof receipt === 'object' && 'goal_met' in receipt && receipt.goal_met === true)).toBe(true)
      const displayedPlan = await ctx.bid.getCapabilityTaskPlan(agent.session)
      report.displayed_plan = displayedPlan
      expect(displayedPlan).not.toBeNull()
      expect(displayedPlan?.steps.length).toBeGreaterThan(0)
      for (const step of displayedPlan?.steps ?? []) {
        expect(step.description.length).toBeLessThanOrEqual(20)
        expect(step.description).not.toMatch(/[\r\n\u2028\u2029]/u)
      }
      expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0002.md'), 'utf8')).toBe(outsideBefore)
      if (scenario.id === 'A03') {
        expect(outlineAfter).toBe(outlineBefore)
        expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8'))
          .toBe(bodyBefore.replace('流程一：收集输入。', '流程一：收集并登记输入。'))
      } else if (scenario.id !== 'A14') {
        expect(children).toHaveLength(scenario.id === 'A02-six' ? 6 : 3)
        expect(['流程一：收集输入。', '流程二：校验结果。', '流程三：交付成果。', '表1 校验产物', '| 校验 | 报告 |', '{{flowchart:process-flow}}']
          .every(text => bodies.some(body => body.includes(text)))).toBe(true)
        if (scenario.id === 'A02-six') {
          expect(['流程一：收集输入。', '流程二：校验结果。', '流程三：交付成果。', '表1 校验产物', '| 校验 | 报告 |', '{{flowchart:process-flow}}']
            .every(text => bodies.reduce((count, body) => count + body.split(text).length - 1, 0) === 1)).toBe(true)
        }
        const snapshot = await collectDocxExportSnapshot(workspace)
        expect(children.every(section => snapshot.markdown.includes(section.title))).toBe(true)
        const workbench = await ctx.bid.getReviewWorkbench(agent.session)
        expect(children.every(section => workbench.outline.some(row => row.section_id === section.id
          && row.writing_status === 'completed' && row.content_available))).toBe(true)
      }
      if (scenario.id === 'A04') {
        const starts = agent.session.events.filter(event => event.type === 'bid.run.started')
        expect(new Set(starts.map(event => event.data.run.work.workId)).size).toBe(1)
        expect(agent.session.events.some(event => event.type === 'tool/call' && event.data.name === 'bid_plan_task')).toBe(true)
        expect(agent.session.events.some(event => event.type === 'bid.run.notice'
          && event.data.message.includes('BID_TASK_PLAN_MISMATCH'))).toBe(true)
      }
      if (scenario.id === 'A14') {
        expect(agent.session.events.some(event => event.type === 'tool/result'
          && event.data.message.content.some(block => block.type === 'tool-result'
            && block.content.some(item => item.type === 'text' && item.text.includes('"queued":true'))))).toBe(true)
        const starts = agent.session.events.flatMap(event => event.type === 'bid.run.started'
          && event.data.run.work.kind === 'capability_task' && event.data.run.work.workId !== priorWorkId ? [event.data.run.work.workId] : [])
        expect(starts).toHaveLength(1)
        expect(agent.session.events.filter(event => event.type === 'bid.run.notice'
          && event.data.kind === 'completed' && event.data.workId === starts[0])).toHaveLength(1)
        expect(agent.session.events.filter(event => event.type === 'user/message'
          && event.data.source.kind === 'user')).toHaveLength(2)
        expect(agent.session.events.filter(event => event.type === 'user/message' && event.data.id === message.id)).toHaveLength(1)
        const requirements = await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8')
        expect(requirements).toContain('回答主题1并保持可追踪交付')
      }
      report.status = 'passed'
    } catch (error) {
      report.status = 'failed'
      report.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      const main = ctx.get('agents')?.get(SessionId('real-main-' + scenario.id))
      if (main !== undefined) {
        report.tools = main.session.events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
        report.notices = main.session.events.filter(event => event.type === 'bid.run.notice')
        report.turn_ends = main.session.events.filter(event => event.type === 'turn/end')
        await ctx.sessions.flush(main.session)
      }
      report.finished_at = new Date().toISOString()
      await mkdir(root, { recursive: true })
      await save()
      await ctx.fiber.dispose()
      console.log('真实模型验收记录：' + reportPath)
    }
  })
})
