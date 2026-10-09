import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { BidWorkspace } from '../src/index.ts'
import { safeRecoverableBidFailure, bidRunRecoveryEligibility, bidRecoveryInstructionRepeated, bidWritingPlanRecoveryEligibility,
  isLegacyOutlineReviewBudgetFailure } from '../src/bid-recovery.ts'
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

it('旧 S4 本地预算 blocked 重算资格但保留有限恢复历史和其他故障边界', async () => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const s4 = { ...work, stage: 'evidence_mapping' as const }
  const issue = { code: 'CONTEXT_WINDOW_EXCEEDED', message: '目录审查对象超过输入预算：位置 0，估算 15496 token，预算 12000 token。' }
  const failure = safeRecoverableBidFailure(s4, new BidStageExecutionError([issue]))
  const original = { ...run('old-s4'), work: s4 }
  session.append('bid.run.started', { run: original })
  session.append('bid.run.notice', { runId: original.runId, stage: s4.stage, kind: 'interrupted', severity: 'error',
    noticeId: `run:${original.runId}:failed`, supersedesTurn: null, message: issue.message })
  session.append('bid.task.changed', { state: { stage: s4.stage, status: 'failed', run: null, failure } })
  const target = { kind: 'run' as const, runId: original.runId, workId: s4.workId }
  session.append('bid.recovery.round', { ownerSessionId: String(session.id), target,
    fingerprint: 'old', round: 0, budget: 3, state: 'blocked', reason: issue.message })
  expect(failure.recovery?.kind).toBe('blocked')
  expect(bidRunRecoveryEligibility(session)).toMatchObject({ eligible: true, attempts: 0, target })
  expect(await inspectBidStage(undefined, session, undefined, 'recovery')).toMatchObject({ eligible: true,
    available_actions: ['bid_recover_task'], failure: { recovery: { kind: 'blocked' } } })
  for (const code of ['AUTH', 'EACCES', 'CREDENTIAL_MISSING', 'INPUT_CHANGED', 'FILE_CORRUPT']) {
    expect(isLegacyOutlineReviewBudgetFailure(s4, { ...failure, issues: [issue, { code, message: '真实阻断' }] })).toBe(false)
  }
  expect(isLegacyOutlineReviewBudgetFailure(work, failure)).toBe(false)
  expect(isLegacyOutlineReviewBudgetFailure({ ...s4, kind: 'capability_task' }, failure)).toBe(false)
  expect(isLegacyOutlineReviewBudgetFailure(s4, { ...failure, issues: [{ ...issue, message: 'provider context window exceeded' }] })).toBe(false)
  expect(isLegacyOutlineReviewBudgetFailure(s4, { ...failure, issues: [{ ...issue, message: issue.message.replace('12000', '5000') }] })).toBe(false)
  session.append('bid.recovery.round', { ownerSessionId: String(session.id), target,
    fingerprint: 'old', round: 0, budget: 3, state: 'blocked', reason: 'BID_RECOVERY_DISPATCH_BUDGET_EXHAUSTED' })
  expect(bidRunRecoveryEligibility(session).eligible).toBe(false)
  session.append('bid.recovery.round', { ownerSessionId: String(session.id), target,
    fingerprint: 'old', round: 3, budget: 3, state: 'blocked', reason: issue.message })
  expect(bidRunRecoveryEligibility(session).eligible).toBe(false)
})

it.each(['TIMEOUT', 'TRANSPORT', 'SERVER', 'RATE_LIMIT'])('已保存写作要求的 %s 进入原计划恢复', async (code) => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  session.append('bid.writing_entry.changed', { view: {
    phase: 'failed', owner_session_id: String(session.id),
    request_state: 'answered', continuation: 'allowed', has_answer: true, has_plan: false,
    processing_state: 'failed', answer_save_status: 'saved', can_retry_answer: false, durability: 'durable',
    expected: { project_revision: 1, request_id: 'request', attempt_id: 'attempt', stop_id: null,
      plan_version: null }, error: { code, message: '模型请求暂时失败' },
  } })
  expect(bidWritingPlanRecoveryEligibility(session)).toMatchObject({ eligible: true, attempts: 0 })
})

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

it('估算执行故障落盘保留安全 cause、错误码与失败阶段', () => {
  const cause = Object.assign(new Error('格式读取暂时失败'), { code: 'EIO' })
  const error = Object.assign(new BidStageExecutionError([{ code: 'EIO', artifact: 'word-export/default.config.json', message: '页数估算失败' }]), { cause })
  expect(safeRecoverableBidFailure({ ...work, stage: 'chapter_writing' }, error)).toMatchObject({
    cause: { code: 'EIO', message: '格式读取暂时失败' }, recovery: { kind: 'retry' },
    issues: [{ artifact: 'word-export/default.config.json' }],
  })
})

it.each([429, 503])('S4 Provider HTTP %s 的可重试 cause 保留状态码且不被通用 Provider 码阻断', (statusCode) => {
  const cause = Object.assign(new Error('联网请求暂时失败'), { code: 'WEB_PROVIDER_ERROR', statusCode, retryable: true })
  const error = new BidStageExecutionError([{ code: 'WEB_PROVIDER_ERROR', message: '联网请求已耗尽内层尝试预算' }])
  error.cause = cause
  expect(safeRecoverableBidFailure({ ...work, stage: 'evidence_mapping' }, error)).toMatchObject({
    cause: { code: 'WEB_PROVIDER_ERROR', status: statusCode, retryable: true }, recovery: { kind: 'retry' },
  })
})

it.each(['AUTH', 'QUOTA', 'EACCES'])('S4 可重试 Provider cause 不能覆盖 %s 阻断', (code) => {
  const error = new BidStageExecutionError([
    { code: 'WEB_PROVIDER_ERROR', message: '联网请求暂时失败' }, { code, message: '不能自动解除的故障' },
  ])
  error.cause = Object.assign(new Error('联网请求暂时失败'), { code: 'WEB_PROVIDER_ERROR', statusCode: 503, retryable: true })
  expect(safeRecoverableBidFailure({ ...work, stage: 'evidence_mapping' }, error).recovery)
    .toMatchObject({ kind: 'blocked', reason: '不能自动解除的故障' })
})

it('S4 HTTP 鉴权错误不因 retryable 标记而越过停止边界', () => {
  const error = new BidStageExecutionError([{ code: 'WEB_PROVIDER_ERROR', message: '鉴权失败' }])
  error.cause = Object.assign(new Error('鉴权失败'), { code: 'WEB_PROVIDER_ERROR', statusCode: 401, retryable: true })
  expect(safeRecoverableBidFailure({ ...work, stage: 'evidence_mapping' }, error).recovery?.kind).toBe('blocked')
})

it.each(['QUOTA', 'AUTH', 'NO_ADAPTER', 'INVALID_REQUEST', 'PI_AI_ERROR'])('模型通道 %s 阻断自动恢复且保留真实原因', (code) => {
  const issues = [{ code, message: '模型通道不可用' }]
  expect(safeRecoverableBidFailure(work, new BidStageExecutionError(issues)))
    .toMatchObject({ issues, recovery: { kind: 'blocked', reason: '模型通道不可用' } })
})

it.each(['TRANSPORT', 'TIMEOUT', 'SERVER', 'EMPTY_RESPONSE', 'RATE_LIMIT', 'WEB_SEARCH_TIMEOUT', 'WEB_FETCH_TIMEOUT', 'TOOL_TIMEOUT'])
('请求通道 %s 预算耗尽后按原错误码恢复网络请求', (code) => {
  const mappingWork: BidWorkDescriptor = { ...work, stage: 'evidence_mapping' }
  const issues = [{ code, artifact: 'MAP-INIT-SEC-009', message: '模型响应通道暂时失败' }]
  expect(safeRecoverableBidFailure(mappingWork, new BidStageExecutionError(issues)))
    .toMatchObject({ issues, recovery: { kind: 'retry', unit: 'MAP-INIT-SEC-009', reason: '模型响应通道暂时失败' } })
})

it.each(['QUOTA', 'AUTH', 'NO_ADAPTER', 'INVALID_REQUEST', 'PI_AI_ERROR'])('可重试传输错误不能覆盖 %s 永久阻断', (code) => {
  const issues = [
    { code: 'TRANSPORT', artifact: 'MAP-INIT-SEC-009', message: '流中断' },
    { code, artifact: 'MAP-INIT-SEC-010', message: '模型通道不可用' },
  ]
  expect(safeRecoverableBidFailure(work, new BidStageExecutionError(issues)))
    .toMatchObject({ issues, recovery: { kind: 'blocked', unit: 'MAP-INIT-SEC-010', reason: '模型通道不可用' } })
})

it('程序 Guard 故障阻断恢复，不按模型传输错误重试', () => {
  const issues = [{ code: 'EVIDENCE_MAPPING_GUARD_ERROR', artifact: 'MAP-INIT-SEC-009', message: '程序 Guard 失败' }]
  expect(safeRecoverableBidFailure(work, new BidStageExecutionError(issues)))
    .toMatchObject({ issues, recovery: { kind: 'blocked', unit: 'MAP-INIT-SEC-009', reason: '程序 Guard 失败' } })
})

it('相同指纹与方案只在同一 Work 内视为重复', async () => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  session.append('bid.recovery.requested', { ownerSessionId: String(session.id),
    target: { kind: 'run', workId: 'first', runId: 'run-first' }, unit: 'step',
    instruction: '重查来源', progressFingerprint: 'same-fingerprint' })
  expect(bidRecoveryInstructionRepeated(session,
    { kind: 'run', workId: 'first', runId: 'run-again' }, 'same-fingerprint', '重查来源')).toBe(true)
  expect(bidRecoveryInstructionRepeated(session,
    { kind: 'run', workId: 'second', runId: 'run-second' }, 'same-fingerprint', '重查来源')).toBe(false)
})

it.each(['EVIDENCE_MAPPING_OUTLINE_SCOPE_STALE', 'EVIDENCE_MAPPING_DEPENDENCY_STALE',
  'OUTLINE_GENERATION_INPUT_CHANGED', 'PREVIOUS_TARGET_INVALID', 'EACCES', 'INVARIANT_VIOLATION', 'STALE_BASE'])
('候选可修也不能掩盖后续 %s', (code) => {
  expect(safeRecoverableBidFailure(work, new Error('failed'), [
    { code: 'OUTLINE_GENERATION_CANDIDATE_INVALID', message: 'missing sections' },
    { code, message: '当前输入无法安全继续', artifact: 'outline/outline.json' },
  ]).recovery).toMatchObject({ kind: 'blocked', reason: '当前输入无法安全继续' })
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
  expect(infrastructure.recovery?.kind).toBe('retry')
  expect(safeRecoverableBidFailure(capabilityWork, new BidStageExecutionError([{
    code: 'CHAPTER_SUBAGENT_INFRASTRUCTURE_ERROR', message: 'Writer Session 创建失败',
  }])).recovery?.kind).toBe('retry')
  expect(safeRecoverableBidFailure(capabilityWork, new BidStageExecutionError([{
    code: 'BID_CAPABILITY_PLAN_PATCH_UNAUTHORIZED', message: '修改步骤超出当前授权',
  }])).recovery?.kind).toBe('repair')
})

it('可修复执行器问题保留原 Work 和诊断，自动修复无需挂起状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-executor-failure-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = new BidWorkspace(root)
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'ready', run: null } })
  const coordinator = new BidRunCoordinator(session,
    { paused: () => false, close: () => {}, waitUntilRunnable: async () => {} },
    { drain: async () => {} }, () => 0)
  await coordinator.start(work)
  await coordinator.suspend('executor_error', safeRecoverableBidFailure(work, new Error('BID_MIDDLEWARE_INVALID')))
  expect(session.events.some(event => event.type === 'bid.run.suspended')).toBe(false)
  expect(await inspectBidStage(workspace, session, undefined, 'recovery')).toMatchObject({
    task: { status: 'failed' }, eligible: true, failure: { message: 'BID_MIDDLEWARE_INVALID' },
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
  '能力任务 %s 边界不唤醒 Main Agent 自动修复', async (cause) => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('bid.task.changed', { state: { stage: 'chapter_writing', status: 'suspended',
      run: { ...run('run-input'), work: { ...work, kind: 'capability_task', stage: 'chapter_writing' },
        cause, error: { message: '需要补充资料', recovery: { kind: 'retry', unit: 'step-one', reason: '需要补充资料' } } } } })
    expect(bidRunRecoveryEligibility(session)).toMatchObject({ eligible: false, attempts: 0,
      reason: '用户停止、Host 重启或等待输入由各自边界处理。' })
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
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-one'), cause: 'retry_exhausted', error: failure } } })
  const inspected = await inspectBidStage(workspace, session, undefined, 'recovery')
  expect(inspected).toMatchObject({ eligible: true, target: { kind: 'run', runId: 'run-one', workId: 's3-work' },
    failure: { recovery: { kind: 'repair' } },
    artifact_diagnostic: { path: 'outline/outline.json', readable: false, reason: 'JSON 格式损坏。' } })
  const first = bidRunRecoveryEligibility(session)
  session.append('bid.recovery.requested', {
    ownerSessionId: String(session.id),
    target: { kind: 'run', workId: 's3-work', runId: 'run-one' },
    unit: 'outline/outline.json', instruction: '修正 sections 结构', progressFingerprint: first.fingerprint!,
  })
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-two'), cause: 'retry_exhausted', error: failure } } })
  expect(bidRunRecoveryEligibility(session)).toMatchObject({ eligible: true, attempts: 1 })
})

it.each(['repair', 'retry'] as const)('%s 不因两次自动接管耗尽权限', async (kind) => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const base = safeRecoverableBidFailure(work, new Error('bad candidate'), [{
    code: 'OUTLINE_GENERATION_CANDIDATE_INVALID', artifact: 'outline/outline.json', message: 'missing sections',
  }])
  const failureA = { ...base, recovery: { ...base.recovery!, kind, candidateSha256: 'a'.repeat(64) } }
  const failureB = { ...base, recovery: { ...base.recovery!, kind, candidateSha256: 'b'.repeat(64) } }
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-one'), cause: 'retry_exhausted', error: failureA } } })
  const first = bidRunRecoveryEligibility(session)
  expect(first.eligible).toBe(true)
  session.append('bid.recovery.requested', {
    ownerSessionId: String(session.id), target: { kind: 'run', workId: work.workId, runId: 'run-one' },
    unit: 'outline/outline.json', instruction: '修正章节', progressFingerprint: first.fingerprint!,
  })
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-two'), cause: 'retry_exhausted', error: failureB } } })
  const second = bidRunRecoveryEligibility(session)
  expect(second).toMatchObject({ eligible: true, attempts: 1 })
  expect(second.fingerprint).not.toBe(first.fingerprint)
  session.append('bid.recovery.requested', {
    ownerSessionId: String(session.id), target: { kind: 'run', workId: work.workId, runId: 'run-two' },
    unit: 'outline/outline.json', instruction: '补全目录', progressFingerprint: second.fingerprint!,
  })
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-three'), cause: 'retry_exhausted', error: { ...failureB, recovery: { ...failureB.recovery, candidateSha256: 'c'.repeat(64) } } } } })
  expect(bidRunRecoveryEligibility(session)).toMatchObject({ eligible: true, attempts: 2 })
})

it.each(['OUTLINE_SHARED_WRITABLE_NOT_LEAF', 'OUTLINE_SHARED_RESPONSE_POINT_MISSING',
  'OUTLINE_GENERATION_REPAIR_EXHAUSTED', 'EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING',
  'EVIDENCE_MAPPING_INTERNAL_ID_VISIBLE', 'BID_UNKNOWN_INTERNAL_ERROR'])(
  '%s 作为内部问题默认交给主 Agent 修复', (code) => {
    expect(safeRecoverableBidFailure(work, new BidStageExecutionError([{ code, message: '候选不符合要求' }])).recovery?.kind)
      .toBe('repair')
  })

it('相同检查点连续出现时执行恢复预算耗尽并保留已尝试策略', async () => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const failure = safeRecoverableBidFailure(work, new Error('candidate rejected'), [{ code: 'OUTLINE_SHARED_WRITABLE_NOT_LEAF', message: '父节不可写' }])
  session.append('bid.task.changed', { state: { stage: 'outline_generation', status: 'suspended',
    run: { ...run('run-one'), cause: 'retry_exhausted', error: failure } } })
  const fingerprint = bidRunRecoveryEligibility(session).fingerprint!
  for (let index = 0; index < 3; index++) session.append('bid.recovery.requested', {
    ownerSessionId: String(session.id),
    target: { kind: 'run', workId: work.workId, runId: `run-${index}` },
    unit: work.workId, instruction: `策略 ${index}`, progressFingerprint: fingerprint,
  })
  expect(bidRunRecoveryEligibility(session)).toMatchObject({ eligible: false, attempts: 3,
    sameProblemCount: 3, requiresStrategyChange: true, previousInstructions: ['策略 0', '策略 1', '策略 2'] })
})

it('恢复工具复用持久预算，配置增长不重置原 Work 上限', async () => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const failure = safeRecoverableBidFailure(work, new Error('candidate rejected'))
  session.append('bid.task.changed', { state: { stage: work.stage, status: 'suspended',
    run: { ...run('run-budget'), cause: 'retry_exhausted', error: failure } } })
  for (let index = 0; index < 3; index++) session.append('bid.recovery.requested', {
    ownerSessionId: String(session.id), target: { kind: 'run', workId: work.workId, runId: `run-${index}` },
    unit: work.workId, instruction: `策略 ${index}`, progressFingerprint: 'same',
  })
  session.append('bid.recovery.round', { ownerSessionId: String(session.id),
    target: { kind: 'run', workId: work.workId, runId: 'run-budget' }, fingerprint: 'same',
    round: 4, budget: 5, state: 'notified', reason: '仍需执行恢复' })
  expect(bidRunRecoveryEligibility(session).eligible).toBe(true)
  expect(bidRunRecoveryEligibility(session, 2).eligible).toBe(false)
  for (let index = 3; index < 5; index++) session.append('bid.recovery.requested', {
    ownerSessionId: String(session.id), target: { kind: 'run', workId: work.workId, runId: `run-${index}` },
    unit: work.workId, instruction: `策略 ${index}`, progressFingerprint: 'same',
  })
  expect(bidRunRecoveryEligibility(session, 20).eligible).toBe(false)
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
