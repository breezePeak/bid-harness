/** 两步能力任务的真实磁盘夹具，供断点恢复测试共享。 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { BidWorkspace } from '../src/index.ts'
import { persistCapabilityTaskRequest, type CapabilityTaskDispatcher } from '../src/bid-capability-task.ts'
import type { BidCapabilityCall } from '../src/bid-capability-contract.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'

/**
 * 创建带两步计划、正式旧正文和独立候选目录的 Work。
 * @returns 可回收的磁盘 Work 与 Session。
 */
export async function capabilityRecoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-recovery-'))
  const workspace = new BidWorkspace(root)
  await mkdir(join(workspace.projectRoot, 'chapters'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'chapters/execution-log.json'), '{}\n')
  await writeFile(join(workspace.projectRoot, 'chapters/unrelated.md'), '范围外正文\n')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const message = createUserMessage({ content: [{ type: 'text', text: '审核两个范围' }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  const task = { goal: '审核两个范围', scope: { kind: 'project' as const }, steps: [
    { scope: { source: 'task' as const }, call: { capability: 'chapter.review' as const, input: { reason: '审核章节' } } },
    { scope: { source: 'task' as const }, call: { capability: 'document.review' as const, input: { reason: '审核全书' } } },
  ] }
  const authorization = { session_id: String(session.id), message_id: String(message.id) }
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task, authorization,
    ['chapters/execution-log.json'], { stage: 'chapter_writing', status: 'completed', run: null })
  const agent = { id: 'fault-injection-agent' } as Parameters<CapabilityTaskDispatcher['execute']>[1]['agent']
  return { root, workspace, ctx, session, work, task, authorization, agent,
    run: () => createTestBidRunContext({ work }),
    dispose: async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}

/**
 * 只写本步骤获准的结果文件。
 * @param onExecute 每次实际执行前的可控故障点。
 * @returns 两步审查所用的受控适配器。
 */
export function recoveryDispatcher(onExecute?: (call: BidCapabilityCall) => Promise<void>): CapabilityTaskDispatcher {
  return {
    allowedWrites: async call => new Set([call.capability === 'chapter.review'
      ? 'chapters/local-review.json' : 'chapters/document-review.json']),
    execute: async (call, context) => {
      await onExecute?.(call)
      const path = call.capability === 'chapter.review' ? 'chapters/local-review.json' : 'chapters/document-review.json'
      await context.run.commits.writeJson(join(context.working.projectRoot, path), { capability: call.capability })
      return { result: { target_section_ids: [], changed_artifacts: [path],
        change_summary: `完成 ${call.capability}`, warnings: [], missing_topics: [], needs_input: false } }
    },
    validate: async () => {},
  }
}
