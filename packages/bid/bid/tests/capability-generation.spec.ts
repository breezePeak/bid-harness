import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { createBidCapabilityDispatcher } from '../src/bid-capability-dispatcher.ts'
import { executeCapabilityTask, persistCapabilityTaskRequest } from '../src/bid-capability-task.ts'
import { BID_CAPABILITIES } from '../src/bid-capability-registry.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { seedProjectArtifacts } from './fixtures/project-session.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('招标分析任务接纳时登记真实 Manifest 输入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-tender-admission-'))
  roots.push(root)
  const workspace = new BidWorkspace(root)
  await seedProjectArtifacts(workspace)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    const session = ctx.sessions.create()
    const message = createUserMessage({ content: [{ type: 'text', text: '分析招标文件' }], source: { kind: 'user' } })
    session.append('user/message', message, { surfaceOp: 'append' })
    const work = await persistCapabilityTaskRequest(workspace, session, 'tender_analysis', {
      goal: '分析招标文件', scope: { kind: 'project' }, steps: [{ scope: { source: 'task' },
        call: { capability: 'tender.analyze', input: {} } }],
    }, { session_id: String(session.id), message_id: String(message.id) },
    BID_CAPABILITIES['tender.analyze'].requires, { stage: 'tender_analysis', status: 'completed', run: null })
    const request = JSON.parse(await readFile(join(workspace.projectRoot, work.requestRef), 'utf8')) as {
      payload: { input_sources: Array<{ path: string; sha256: string }> }
    }
    expect(request.payload.input_sources).toEqual([{ path: 'manifest.json', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }])
    const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 1,
      evidenceMappingMaxConcurrency: 1, chapterWritingMaxConcurrency: 1, webSearchEnabled: false })
    const agent = { id: 'tender-admission-agent', whenIdle: async () => {}, ctx: { get: (name: string) =>
      name === 'fs' || name === 'tools' ? {} : undefined } } as unknown as Agent
    const outcome = await executeCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher, agent, session)
    expect(outcome).toMatchObject({ status: 'completed' })
  } finally { await ctx.fiber.dispose() }
})

it('公共招标分析复用真实 S2 Validator，完整产物无需重复模型调用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-capability-tender-analyze-'))
  roots.push(root)
  const workspace = new BidWorkspace(root)
  await seedProjectArtifacts(workspace)
  const dispatcher = createBidCapabilityDispatcher({ modelStageRepairAttempts: 1,
    evidenceMappingMaxConcurrency: 1, chapterWritingMaxConcurrency: 1, webSearchEnabled: false })
  const call = { capability: 'tender.analyze' as const, input: {} }
  expect(() => dispatcher.allowedWrites(call, new Set(['SEC-1']), workspace, 'tender-step'))
    .toThrow('BID_GENERATION_PROJECT_SCOPE_REQUIRED')
  const writes = await dispatcher.allowedWrites(call, null, workspace, 'tender-step')
  const agent = { whenIdle: async () => {}, ctx: { get: (name: string) =>
    name === 'fs' || name === 'tools' ? {} : undefined } } as unknown as Agent
  const context = { canonical: workspace, working: workspace, agent,
    run: createTestBidRunContext(), sectionIds: null,
    stepDirectory: root, inputSources: new Map(), baselineHashes: new Map(), allowedWrites: writes,
    stepId: 'tender-step', rootWorkId: 'tender-task',
    authorization: { session_id: 'main', message_id: 'tender-request' }, inputSha256: '0'.repeat(64) }
  const result = await dispatcher.execute(call, context)
  await dispatcher.validate(call, context, result.result)
  expect(result.result.target_section_ids).toEqual([])
  expect(result.result.changed_artifacts).toEqual([])
})
