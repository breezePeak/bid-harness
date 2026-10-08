/** 能力完成与失败恢复按真实 Session 事件绑定原 Work，独立于项目阶段的空闲状态。 */
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { bidCompletedCapabilityRun, bidRecoverableRun } from '../src/bid-recovery.ts'
import type { BidRunData, BidRunNotice, BidTaskState } from '../src/control-plane-contract.ts'

function run(id = 'capability-run', kind: BidRunData['work']['kind'] = 'capability_task'): BidRunData {
  return { runId: id, epoch: 1, baseProjectRevision: 0, startedAt: 1, updatedAt: 2,
    work: { kind, workId: `${id}-work`, stage: 'chapter_writing', requestRef: `requests/${id}.json`,
      requestSha256: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64) } }
}

function notice(active: BidRunData, patch: Partial<BidRunNotice> = {}): BidRunNotice {
  return { noticeId: `run:${active.runId}:completed`, supersedesTurn: null, runId: active.runId,
    stage: active.work.stage, workId: active.work.workId, kind: 'completed', severity: 'info',
    message: '任务完成', resultRef: `requests/${active.work.workId}/result.json`, ...patch }
}

function completedSession() {
  const session = Session.create(SessionId('completed-capability-owner'))
  const active = run()
  session.append('bid.run.started', { run: active })
  session.append('bid.run.completed', { run: active })
  session.append('bid.run.notice', notice(active))
  return { session, active }
}

it.each(['ready', 'waiting_user', 'completed'] as const)('原阶段 %s 接纳真实已完成能力 Work 的后续修正', (status) => {
  const { session, active } = completedSession()
  const task: BidTaskState = { stage: 'chapter_writing', status, run: null }
  expect(bidCompletedCapabilityRun(session, task)).toEqual(active)
})

it('只有完成通知而没有真实 completed 事件不能打开后续修正', () => {
  const session = Session.create(SessionId('missing-completed-owner'))
  const active = run()
  session.append('bid.run.started', { run: active })
  session.append('bid.run.notice', notice(active))
  expect(bidCompletedCapabilityRun(session, { stage: 'chapter_writing', status: 'ready', run: null })).toBeUndefined()
})

it.each(['running', 'user_stop', 'awaiting_input'] as const)('最新能力 Run 为 %s 时不借用旧完成事件', (state) => {
  const { session } = completedSession()
  const latest = run('new-capability-run')
  session.append('bid.run.started', { run: latest })
  const task: BidTaskState = state === 'running' ? { stage: 'chapter_writing', status: 'running', run: latest }
    : { stage: 'chapter_writing', status: 'suspended', run: { ...latest, cause: state } }
  expect(bidCompletedCapabilityRun(session, task)).toBeUndefined()
  expect(bidCompletedCapabilityRun(session, { stage: 'chapter_writing', status: 'ready', run: null })).toBeUndefined()
})

it.each(['work', 'run', 'stage', 'stopped'] as const)('完成凭据的 %s 不对应当前能力时拒绝修正', (fault) => {
  const { session, active } = completedSession()
  if (fault === 'work') session.append('bid.run.notice', notice(active, { workId: 'unrelated-work' }))
  if (fault === 'run') {
    const unrelated = run('unrelated-run')
    session.append('bid.run.started', { run: unrelated })
    session.append('bid.run.completed', { run: unrelated })
    session.append('bid.run.notice', notice(active, { runId: unrelated.runId }))
  }
  if (fault === 'stopped') session.append('bid.run.notice', notice(active, { kind: 'stopped' }))
  const task: BidTaskState = { stage: fault === 'stage' ? 'evidence_mapping' : 'chapter_writing', status: 'ready', run: null }
  expect(bidCompletedCapabilityRun(session, task)).toBeUndefined()
})

it('completed 事件中的 Work 身份必须与 started 相同', () => {
  const { session, active } = completedSession()
  session.append('bid.run.completed', { run: { ...active, work: { ...active.work, workId: 'unrelated-completion' } } })
  expect(bidCompletedCapabilityRun(session, { stage: 'chapter_writing', status: 'completed', run: null })).toBeUndefined()
})

it('后续原生阶段 Run 不遮住同一 Work 的能力完成凭据', () => {
  const { session, active } = completedSession()
  const native = run('native-stage-run', 'stage_execution')
  session.append('bid.run.started', { run: native })
  session.append('bid.run.completed', { run: native })
  session.append('bid.run.notice', notice(native))
  expect(bidCompletedCapabilityRun(session, { stage: 'chapter_writing', status: 'waiting_user', run: null })).toEqual(active)
})

it('failed 恢复按精确失败通知 Run 找 started，不被后续原生阶段遮住', () => {
  const session = Session.create(SessionId('failed-capability-owner'))
  const active = run('failed-capability-run')
  session.append('bid.run.started', { run: active })
  session.append('bid.run.notice', notice(active, { noticeId: `run:${active.runId}:failed`, kind: 'interrupted', severity: 'error' }))
  session.append('bid.run.started', { run: run('unrelated-native-run', 'stage_execution') })
  const failure = { code: 'EIO', message: '原任务写盘暂态失败' }
  const task: BidTaskState = { stage: 'chapter_writing', status: 'failed', run: null, failure }
  expect(bidRecoverableRun(session, task)).toEqual({ ...active, cause: 'executor_error', error: failure })
})

it.each(['run', 'stage', 'notice'] as const)('failed 恢复拒绝不匹配的 %s 身份', (fault) => {
  const session = Session.create(SessionId('failed-identity-owner'))
  const active = run('failed-capability-run')
  session.append('bid.run.started', { run: active })
  session.append('bid.run.notice', notice(active, { noticeId: fault === 'notice' ? 'other-notice' : `run:${active.runId}:failed`,
    runId: fault === 'run' ? 'unknown-run' : active.runId, stage: fault === 'stage' ? 'evidence_mapping' : active.work.stage,
    kind: 'interrupted', severity: 'error' }))
  expect(bidRecoverableRun(session, { stage: 'chapter_writing', status: 'failed', run: null,
    failure: { code: 'EIO', message: '失败' } })).toBeUndefined()
})
