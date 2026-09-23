import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { askCapabilityTaskInput, capabilityTaskRequestSchema, executeCapabilityTask,
  patchCapabilityTaskSteps, persistCapabilityTaskRequest,
  type CapabilityTaskDispatcher } from '../src/bid-capability-task.ts'
import type { BidCapabilityCall } from '../src/bid-capability-contract.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { readBidWorkRequest } from '../src/work-descriptor.ts'
import { prepareBidWorkingTree } from '../src/working-tree.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-task-'))
  roots.push(root)
  const workspace = new BidWorkspace(root)
  await mkdir(join(workspace.projectRoot, 'chapters'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), '{}\n')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const message = createUserMessage({ content: [{ type: 'text', text: '审核章节和整书' }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  const task = { goal: '审核章节和整书', scope: { kind: 'project' as const }, steps: [
    { scope: { source: 'task' as const }, call: { capability: 'chapter.review' as const, input: { reason: '审核章节' } } },
    { scope: { source: 'task' as const }, call: { capability: 'document.review' as const, input: { reason: '审核整书' } } },
  ] }
  const authorization = { session_id: String(session.id), message_id: String(message.id) }
  const descriptor = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task, authorization,
    ['chapters/execution-log.json'], { stage: 'chapter_writing', status: 'completed', run: null })
  const run = createTestBidRunContext({ work: descriptor })
  const agent = { id: 'execution-agent' } as Parameters<typeof executeCapabilityTask>[3]
  return { ctx, workspace, session, task, authorization, descriptor, run, agent }
}

function dispatcher(failSecond = false) {
  let failed = false
  const execute = vi.fn<CapabilityTaskDispatcher['execute']>(async (call, context) => {
    if (failSecond && call.capability === 'document.review' && !failed) {
      failed = true
      await context.run.commits.writeText(join(context.working.projectRoot, 'chapters/local-review.json'), '损坏的前一步输出')
      throw new Error('第二步暂时失败')
    }
    const path = call.capability === 'chapter.review' ? 'chapters/local-review.json' : 'chapters/document-review.json'
    await context.run.commits.writeJson(join(context.working.projectRoot, path), { reviewed: call.capability })
    return { result: { target_section_ids: [], changed_artifacts: [path], change_summary: '完成审核',
      warnings: [], missing_topics: [], needs_input: false } }
  })
  return {
    allowedWrites: async (call: BidCapabilityCall) => new Set([call.capability === 'chapter.review'
      ? 'chapters/local-review.json' : 'chapters/document-review.json']),
    execute,
    validate: async () => {},
  }
}

describe('同一 Work 的能力序列', () => {
  it('后续真实消息只能替换尚未开始的步骤', async () => {
    const { ctx, workspace, session, descriptor, run, agent } = await fixture()
    try {
      const base = dispatcher()
      let block = true
      const adapter: CapabilityTaskDispatcher = { ...base,
        allowedWrites: async (call, _sectionIds, _working) => {
          if (call.capability === 'document.review' && block) {
            block = false
            throw new Error('等待计划调整')
          }
          return base.allowedWrites(call)
        } }
      await expect(executeCapabilityTask(workspace, run, adapter, agent, session)).rejects.toThrow('等待计划调整')
      expect(base.execute).toHaveBeenCalledOnce()
      const message = createUserMessage({ content: [{ type: 'text', text: '调整整书审核范围' }], source: { kind: 'user' } })
      session.append('user/message', message, { surfaceOp: 'append' })
      const authorization = { session_id: String(session.id), message_id: String(message.id) }
      const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, descriptor))
      const working = new BidWorkspace((await prepareBidWorkingTree(workspace, descriptor)).root, workspace.config)
      const replacement = [{ scope: { source: 'task' as const },
        call: { capability: 'document.review' as const, input: { reason: '只核对当前完整目录' } } }]
      await expect(patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 0, replacement))
        .rejects.toThrow('BID_CAPABILITY_PLAN_PATCH_STARTED_STEP')
      const patched = await patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 1, replacement)
      expect(patched.steps.map(step => step.status)).toEqual(['completed', 'pending'])
      expect(patched.plan_patches).toHaveLength(1)
      await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work: descriptor }), adapter, agent, session))
        .resolves.toMatchObject({ status: 'completed' })
      expect(base.execute).toHaveBeenCalledTimes(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('串行执行两步，只使用一个根 Run 并留下同批发布结果', async () => {
    const { ctx, workspace, session, run, agent } = await fixture()
    try {
      const adapter = dispatcher()
      const outcome = await executeCapabilityTask(workspace, run, adapter, agent, session)
      expect(outcome.status).toBe('completed')
      expect(adapter.execute).toHaveBeenCalledTimes(2)
      expect(adapter.execute.mock.calls.map(call => call[1].run.runId)).toEqual([run.runId, run.runId])
      expect(await readFile(join(workspace.projectRoot, 'chapters/local-review.json'), 'utf8')).toContain('chapter.review')
      expect(await readFile(join(workspace.projectRoot, 'chapters/document-review.json'), 'utf8')).toContain('document.review')
    } finally { await ctx.fiber.dispose() }
  })

  it('第二步失败后保留第一步检查点；已发布但未结算时不重复执行', async () => {
    const { ctx, workspace, session, descriptor, run, agent } = await fixture()
    try {
      const adapter = dispatcher(true)
      await expect(executeCapabilityTask(workspace, run, adapter, agent, session)).rejects.toThrow('第二步暂时失败')
      expect(adapter.execute).toHaveBeenCalledTimes(2)
      const resumed = createTestBidRunContext({ work: descriptor })
      const outcome = await executeCapabilityTask(workspace, resumed, adapter, agent, session)
      expect(outcome.status).toBe('completed')
      expect(adapter.execute).toHaveBeenCalledTimes(3)
      expect(await readFile(join(workspace.projectRoot, 'chapters/local-review.json'), 'utf8')).toContain('chapter.review')
      const afterCommit = createTestBidRunContext({ work: descriptor })
      await expect(executeCapabilityTask(workspace, afterCommit, adapter, agent, session))
        .resolves.toMatchObject({ status: 'completed' })
      expect(adapter.execute).toHaveBeenCalledTimes(3)
    } finally { await ctx.fiber.dispose() }
  })

  it('同一用户消息复用原 Work，输入变化不能改写原指纹后继续', async () => {
    const { ctx, workspace, session, task, authorization, descriptor, run, agent } = await fixture()
    try {
      const duplicate = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task, authorization,
        ['chapters/execution-log.json'], { stage: 'chapter_writing', status: 'completed', run: null })
      expect(duplicate).toEqual(descriptor)
      await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), '{"changed":true}\n')
      const adapter = dispatcher()
      await expect(executeCapabilityTask(workspace, run, adapter, agent, session)).rejects.toThrow('BID_CAPABILITY_INPUT_CHANGED')
      expect(adapter.execute).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('步骤文件已合并但顶层检查点未写时，凭步骤回执恢复而不重复执行', async () => {
    const { ctx, workspace, session, descriptor, run, agent } = await fixture()
    try {
      const adapter = dispatcher()
      const originalWrite = run.commits.writeJson.bind(run.commits)
      let checkpointWrites = 0
      vi.spyOn(run.commits, 'writeJson').mockImplementation((path, value) => {
        if (path.endsWith('task-checkpoint.json') && ++checkpointWrites === 3) {
          return Promise.reject(new Error('检查点中断'))
        }
        return originalWrite(path, value)
      })
      await expect(executeCapabilityTask(workspace, run, adapter, agent, session)).rejects.toThrow('检查点中断')
      expect(adapter.execute).toHaveBeenCalledOnce()
      const resumed = createTestBidRunContext({ work: descriptor })
      await expect(executeCapabilityTask(workspace, resumed, adapter, agent, session))
        .resolves.toMatchObject({ status: 'completed' })
      expect(adapter.execute).toHaveBeenCalledTimes(2)
      expect(await readFile(join(workspace.projectRoot, 'chapters/local-review.json'), 'utf8')).toContain('chapter.review')
    } finally { await ctx.fiber.dispose() }
  })

  it('需要用户输入时保留问题身份并等待，不重复调用执行器', async () => {
    const { ctx, workspace, session, descriptor, run, agent } = await fixture()
    try {
      const execute = vi.fn<CapabilityTaskDispatcher['execute']>(async (call, context) => ({
        result: { target_section_ids: [], changed_artifacts: [], change_summary: context.inputAnswer === undefined
          ? '需要补充依据' : '依据已补充',
        warnings: [], missing_topics: context.inputAnswer === undefined && call.capability === 'chapter.review'
          ? ['缺少验收文件'] : [],
        needs_input: context.inputAnswer === undefined && call.capability === 'chapter.review' },
      }))
      const adapter: CapabilityTaskDispatcher = {
        allowedWrites: async () => new Set(), execute, validate: async () => {},
      }
      const first = await executeCapabilityTask(workspace, run, adapter, agent, session)
      expect(first).toMatchObject({ status: 'awaiting_input', result: { missing_topics: ['缺少验收文件'] } })
      const waiting = createTestBidRunContext({ work: descriptor })
      const second = await executeCapabilityTask(workspace, waiting, adapter, agent, session)
      expect(second).toEqual(first)
      expect(execute).toHaveBeenCalledOnce()
      if (first.status !== 'awaiting_input') throw new Error('应等待补充输入')
      const asked = vi.fn(async (question: { id: string }) => ({ id: question.id, selected: [], custom: '已补充验收文件。' }))
      await expect(askCapabilityTaskInput(session, descriptor.workId, first, asked, async () => {})).resolves.toBe(true)
      expect(asked).toHaveBeenCalledOnce()
      expect(session.events.filter(event => event.type === 'bid.capability.input.received')).toHaveLength(1)
      const resumed = createTestBidRunContext({ work: descriptor })
      await expect(executeCapabilityTask(workspace, resumed, adapter, agent, session))
        .resolves.toMatchObject({ status: 'completed' })
      expect(execute).toHaveBeenCalledTimes(3)
    } finally { await ctx.fiber.dispose() }
  })
})
