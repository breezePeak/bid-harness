/** 真实 Host 与 Agent 的自然语言循环；外部 provider 为明确脚本，不代表真实模型稳定性。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { BidHostRuntime } from '@deepseek-ai/dsh-bid'
import { expect, it } from 'vitest'
import { runMainTaskPlanningLoop } from './fixtures/main-task-planning-loop.ts'

for (const fault of [undefined, 'after_split', 'after_migration', 'writing', 'before_verification', 'repeat_completed'] as const) {
  it(fault === undefined ? '一条自然语言任务经真实工具 schema 完成拆章、迁移、写作、核验和发布'
    : fault === 'repeat_completed' ? '已完成新叶节再次写作仍按程序提供的保留块复用原文'
      : `真实拆章链在 ${fault} 中断后自动恢复同一 Work，不重跑前缀`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bid-main-task-loop-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(AttachmentLocal, { dshHome: join(root, '.dsh') })
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, '.session-store'), compression: 'none' })
      await ctx.plugin(SystemPrompt, { persona: 'test' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(spawn, { providerName: 'spawn' })
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(UserQuestionService)
      await ctx.plugin(BidHostRuntime)
      const result = await runMainTaskPlanningLoop(ctx, root, fault)
      expect(result).toMatchObject({ state: 'completed', children: ['收集输入', '校验结果', '交付成果'],
        workbench: Array(3).fill({ status: 'completed', content: true }),
        seedPreserved: true, outsidePreserved: true, exportedChildren: ['收集输入', '校验结果', '交付成果'],
        userMessages: 1 })
      expect(result.workIds).toHaveLength(1)
      expect(result.executionParentModelTurns).toBe(0)
      if (fault === undefined) {
        expect(result.calls).toEqual(['bid_project_inspect', 'bid_project_inspect', 'bid_run_task'])
        expect(result.verifiers).toBe(2)
      } else if (fault === 'repeat_completed') {
        expect(result.interrupted).toBe(false)
        expect(result.executions.filter(capability => capability === 'chapter.write')).toHaveLength(2)
      } else {
        expect(result.interrupted).toBe(true)
        expect(result.calls).toContain('bid_recover_task')
        expect(result.executions.filter(capability => capability === 'outline.update')).toHaveLength(1)
        expect(result.executions.filter(capability => capability === 'chapter.reorganize')).toHaveLength(1)
        expect(result.executions.filter(capability => capability === 'chapter.write')).toHaveLength(fault === 'writing' ? 2 : 1)
      }
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)
}
