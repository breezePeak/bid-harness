import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { BidWorkspace } from '../src/index.ts'
import { safeRecoverableBidFailure, bidRunRecoveryEligibility } from '../src/bid-recovery.ts'
import { inspectBidStage } from '../src/stage-interaction.ts'
import type { BidRunData, BidWorkDescriptor } from '../src/control-plane-contract.ts'
import { BidRunCoordinator } from '../src/run-coordinator.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).reverse().map(dispose => dispose())) })

const work: BidWorkDescriptor = {
  kind: 'stage_execution', stage: 'outline_generation', workId: 's3-work',
  requestRef: 'requests/s3-work.json', requestSha256: '0'.repeat(64), inputFingerprint: '1'.repeat(64),
}

function run(runId: string): BidRunData {
  return { runId, epoch: 1, baseProjectRevision: 1, work, startedAt: 1, updatedAt: 1 }
}

it('keeps repairable candidate issues distinct from provider and input faults', () => {
  expect(safeRecoverableBidFailure(work, new Error('bad JSON'), [{
    code: 'OUTLINE_GENERATION_CANDIDATE_INVALID', artifact: 'outline/outline.json', message: 'invalid JSON',
  }]).recovery).toMatchObject({ kind: 'repair', unit: 'outline/outline.json' })
  expect(safeRecoverableBidFailure(work, new Error('provider unavailable')).recovery?.kind).toBe('blocked')
  expect(safeRecoverableBidFailure(work, new Error('input changed'), [{
    code: 'OUTLINE_GENERATION_INPUT_CHANGED', message: 'source version changed',
  }]).recovery?.kind).toBe('blocked')
})

it('does not hand an input question to automatic Goal recovery', async () => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  session.append('bid.goal.bound', { goalId: 'goal-input', ownerSessionId: String(session.id), initialS2WorkId: 's2-work' })
  session.append('bid.task.changed', { state: { stage: 'chapter_writing', status: 'suspended',
    run: { ...run('run-input'), work: { ...work, kind: 'capability_task', stage: 'chapter_writing' },
      cause: 'awaiting_input', error: { message: '需要补充资料', recovery: { kind: 'retry', unit: 'step-one', reason: '需要补充资料' } } } } })
  expect(bidRunRecoveryEligibility(session, 'goal-input')).toMatchObject({ eligible: false })
})

it('reads a suspended recovery diagnosis despite a corrupt formal outline and stops unchanged repeats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-recovery-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = new BidWorkspace(root)
  await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'outline/outline.json'), '{broken', 'utf8')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const failure = safeRecoverableBidFailure(work, new Error('bad candidate'), [{
    code: 'OUTLINE_GENERATION_CANDIDATE_INVALID', artifact: 'outline/outline.json', message: 'missing sections',
  }])
  session.append('bid.goal.bound', { goalId: 'goal-one', ownerSessionId: String(session.id), initialS2WorkId: 's2-work' })
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-one'), cause: 'retry_exhausted', error: failure } } })
  const inspected = await inspectBidStage(workspace, session, undefined, 'recovery')
  expect(inspected).toMatchObject({ eligible: true, target: { kind: 'run', runId: 'run-one', workId: 's3-work' },
    failure: { recovery: { kind: 'repair' } },
    artifact_diagnostic: { path: 'outline/outline.json', readable: false, reason: 'JSON 格式损坏。' } })
  const first = bidRunRecoveryEligibility(session, 'goal-one')
  session.append('bid.goal.recovery.requested', {
    goalId: 'goal-one', ownerSessionId: String(session.id),
    target: { kind: 'run', workId: 's3-work', runId: 'run-one' },
    unit: 'outline/outline.json', instruction: '修正 sections 结构', progressFingerprint: first.fingerprint!,
  })
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-two'), cause: 'retry_exhausted', error: failure } } })
  expect(bidRunRecoveryEligibility(session, 'goal-one')).toMatchObject({ eligible: false, attempts: 1,
    reason: '同一问题和检查点没有进展。' })
})

it('permits a changed candidate once but keeps the two-acceptance budget across Run identities', async () => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const base = safeRecoverableBidFailure(work, new Error('bad candidate'), [{
    code: 'OUTLINE_GENERATION_CANDIDATE_INVALID', artifact: 'outline/outline.json', message: 'missing sections',
  }])
  const failureA = { ...base, recovery: { ...base.recovery!, candidateSha256: 'a'.repeat(64) } }
  const failureB = { ...base, recovery: { ...base.recovery!, candidateSha256: 'b'.repeat(64) } }
  session.append('bid.goal.bound', { goalId: 'goal-one', ownerSessionId: String(session.id), initialS2WorkId: 's2-work' })
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-one'), cause: 'retry_exhausted', error: failureA } } })
  const first = bidRunRecoveryEligibility(session, 'goal-one')
  expect(first.eligible).toBe(true)
  session.append('bid.goal.recovery.requested', {
    goalId: 'goal-one', ownerSessionId: String(session.id), target: { kind: 'run', workId: work.workId, runId: 'run-one' },
    unit: 'outline/outline.json', instruction: '修正章节', progressFingerprint: first.fingerprint!,
  })
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-two'), cause: 'retry_exhausted', error: failureB } } })
  const second = bidRunRecoveryEligibility(session, 'goal-one')
  expect(second).toMatchObject({ eligible: true, attempts: 1 })
  expect(second.fingerprint).not.toBe(first.fingerprint)
  session.append('bid.goal.recovery.requested', {
    goalId: 'goal-one', ownerSessionId: String(session.id), target: { kind: 'run', workId: work.workId, runId: 'run-two' },
    unit: 'outline/outline.json', instruction: '补全目录', progressFingerprint: second.fingerprint!,
  })
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-three'), cause: 'retry_exhausted', error: { ...failureB, recovery: { ...failureB.recovery, candidateSha256: 'c'.repeat(64) } } } } })
  expect(bidRunRecoveryEligibility(session, 'goal-one')).toMatchObject({ eligible: false, attempts: 2,
    reason: '当前 work 的自动接管次数已耗尽。' })
})

it('records the digest of the exact failed candidate after a Run settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-candidate-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = new BidWorkspace(root)
  await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'outline/outline.json'), '{"sections":[]}', 'utf8')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const coordinator = new BidRunCoordinator(session,
    { paused: () => false, close: () => {}, waitUntilRunnable: async () => {} },
    { drain: async () => {} }, () => 0, undefined, undefined,
    { workspaceRoot: workspace.root, projectRoot: workspace.projectRoot })
  await coordinator.start(work)
  const failure = safeRecoverableBidFailure(work, new Error('bad candidate'), [{
    code: 'OUTLINE_GENERATION_CANDIDATE_INVALID', artifact: 'outline/outline.json', message: 'missing sections',
  }])
  const suspended = await coordinator.suspend('retry_exhausted', failure)
  const fileHash = createHash('sha256').update('{"sections":[]}').digest('hex')
  expect(suspended?.error?.recovery?.candidateSha256).toBe(createHash('sha256')
    .update(JSON.stringify([['outline/outline.json', fileHash]])).digest('hex'))
})
