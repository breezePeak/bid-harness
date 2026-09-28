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
import { BidStageExecutionError } from '../src/control-plane-contract.ts'
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

it('保留能力步骤的 Mapping 模型错误码，允许主 Agent 定向修复', () => {
  const capabilityWork: BidWorkDescriptor = { ...work, kind: 'capability_task', stage: 'evidence_mapping' }
  const issues = [{ code: 'EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING', artifact: 'MAP-REPAIR-S2.1',
    message: 'Mapping Subagent 未成功调用 finish_mapping_task 完成当前任务。' }]
  const failure = safeRecoverableBidFailure(capabilityWork, new BidStageExecutionError(issues))
  expect(failure).toMatchObject({ issues, recovery: { kind: 'repair', unit: 'MAP-REPAIR-S2.1' } })
  const infrastructure = safeRecoverableBidFailure(capabilityWork, new BidStageExecutionError([{
    code: 'EVIDENCE_MAPPING_SUBAGENT_INFRASTRUCTURE_ERROR', message: '子代理结果通道失败',
  }]))
  expect(infrastructure.recovery?.kind).toBe('blocked')
})

it('执行器失败不挂起，主 Agent 仍可读取实际错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-executor-failure-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = new BidWorkspace(root)
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const coordinator = new BidRunCoordinator(session,
    { paused: () => false, close: () => {}, waitUntilRunnable: async () => {} },
    { drain: async () => {} }, () => 0)
  await coordinator.start(work)
  await coordinator.suspend('executor_error', safeRecoverableBidFailure(work, new Error('BID_MIDDLEWARE_INVALID')))
  expect(session.events.some(event => event.type === 'bid.run.suspended')).toBe(false)
  expect(await inspectBidStage(workspace, session, undefined, 'recovery')).toMatchObject({
    task: { status: 'failed' }, eligible: false, failure: { message: 'BID_MIDDLEWARE_INVALID' },
  })
})

it('执行器的目录结构与响应点校验失败交给主 Agent，所有输入问题优先阻止恢复', () => {
  const issues = [
    { code: 'OUTLINE_SHARED_WRITABLE_NOT_LEAF', artifact: 'outline/outline.json', message: '父节不能直接写作' },
    { code: 'OUTLINE_SHARED_RESPONSE_POINT_MISSING', artifact: 'outline/outline.json', message: '响应点未覆盖' },
    { code: 'OUTLINE_GENERATION_REPAIR_FAILED', artifact: 'outline/repair-operations.json', message: '结构章节不能承担响应点' },
  ]
  expect(safeRecoverableBidFailure(work, new BidStageExecutionError(issues), issues).recovery)
    .toMatchObject({ kind: 'repair', unit: 'outline/outline.json' })
  for (const code of ['OUTLINE_GENERATION_INPUT_CHANGED', 'OUTLINE_SHARED_RESPONSE_POINT_CATALOG_MISMATCH', 'PROVIDER_ERROR']) {
    const mixed = [...issues, { code, artifact: 'analysis/scoring.json', message: '上游输入或服务不可用' }]
    expect(safeRecoverableBidFailure(work, new BidStageExecutionError(mixed), mixed).recovery)
      .toMatchObject({ kind: 'blocked', unit: 'analysis/scoring.json' })
  }
})

it.each(['awaiting_input', 'user_stop', 'host_restart'] as const)(
  '能力任务 %s 边界不由 Goal 自动续行', async (cause) => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('bid.goal.bound', { goalId: 'goal-input', ownerSessionId: String(session.id), initialS2WorkId: 's2-work' })
    session.append('bid.task.changed', { state: { stage: 'chapter_writing', status: 'suspended',
      run: { ...run('run-input'), work: { ...work, kind: 'capability_task', stage: 'chapter_writing' },
        cause, error: { message: '需要补充资料', recovery: { kind: 'retry', unit: 'step-one', reason: '需要补充资料' } } } } })
    expect(bidRunRecoveryEligibility(session, 'goal-input')).toMatchObject({ eligible: false, attempts: 0,
      reason: '用户停止、Host 重启或等待输入需用户明确继续。' })
  })

it('目录损坏与重复校验错误保留主 Agent 的继续修复权限', async () => {
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
  expect(bidRunRecoveryEligibility(session, 'goal-one')).toMatchObject({ eligible: true, attempts: 1 })
})

it.each(['repair', 'retry'] as const)('%s 按故障类别决定是否限制两次自动接管', async (kind) => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const base = safeRecoverableBidFailure(work, new Error('bad candidate'), [{
    code: 'OUTLINE_GENERATION_CANDIDATE_INVALID', artifact: 'outline/outline.json', message: 'missing sections',
  }])
  const failureA = { ...base, recovery: { ...base.recovery!, kind, candidateSha256: 'a'.repeat(64) } }
  const failureB = { ...base, recovery: { ...base.recovery!, kind, candidateSha256: 'b'.repeat(64) } }
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
  expect(bidRunRecoveryEligibility(session, 'goal-one')).toMatchObject({ eligible: kind === 'repair', attempts: 2 })
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
