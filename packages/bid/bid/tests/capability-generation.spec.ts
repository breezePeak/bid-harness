import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { createBidCapabilityDispatcher } from '../src/bid-capability-dispatcher.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { seedProjectArtifacts } from './fixtures/project-session.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

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
