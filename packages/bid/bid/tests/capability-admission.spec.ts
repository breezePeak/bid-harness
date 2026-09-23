import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { createBidCapabilityDispatcher } from '../src/bid-capability-dispatcher.ts'
import { executeCapabilityTask, persistCapabilityTaskRequest } from '../src/bid-capability-task.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { seedCapabilityProject } from './capability-fixture.ts'

const settings = { modelStageRepairAttempts: 1, evidenceMappingMaxConcurrency: 1,
  chapterWritingMaxConcurrency: 1, webSearchEnabled: false }

it.each(['outline_generation', 'evidence_mapping', 'chapter_writing'] as const)(
  '%s 阶段仍可按真实用户消息修改招标理解', async (stage) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-capability-admission-')))
    await seedCapabilityProject(workspace, 'complete')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create()
      const message = createUserMessage({ content: [{ type: 'text', text: '把第一条要求改为明确实施边界' }],
        source: { kind: 'user' } })
      session.append('user/message', message, { surfaceOp: 'append' })
      const task = { goal: '把第一条要求改为明确实施边界', scope: { kind: 'project' as const },
        steps: [{ scope: { source: 'task' as const }, call: { capability: 'tender.update' as const,
          input: { operations: [{ type: 'update_requirement' as const, requirement_id: 'REQ-1',
            fields: { normalized_requirement: '明确实施边界' } }] } } }] }
      const descriptor = await persistCapabilityTaskRequest(workspace, session, stage, task,
        { session_id: String(session.id), message_id: String(message.id) },
        ['analysis/requirements.json'], { stage, status: 'completed', run: null })
      const run = createTestBidRunContext({ work: descriptor })
      const agent = { id: 'execution-agent' } as Parameters<typeof executeCapabilityTask>[3]
      const result = await executeCapabilityTask(workspace, run, createBidCapabilityDispatcher(settings), agent, session)
      expect(result.status).toBe('completed')
      if (result.status === 'completed') expect(result.results[0]?.target_section_ids).toEqual(['SEC-1'])
      const requirements = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8')) as {
        requirements: Array<{ normalized_requirement: string }>
      }
      expect(requirements.requirements[0]?.normalized_requirement).toBe('明确实施边界')
    } finally { await ctx.fiber.dispose() }
  },
)
