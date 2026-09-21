import { describe, expect, it } from 'vitest'
import type { BidRunSnapshot } from '@deepseek-ai/dsh-bid/control-plane'
import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { bidRunDefinition } from '../src/client/bid-run-definition.ts'

const run: BidRunSnapshot = {
  runId: 'run-1', interactionSessionId: 'main', executionSessionId: 'execution',
  stage: 'evidence_mapping', epoch: 3, baseProjectRevision: 8,
  work: {
    kind: 'stage_execution', workId: 'work-1', stage: 'evidence_mapping',
    requestRef: 'request', requestSha256: 'sha', inputFingerprint: 'inputs',
  },
  status: 'running', startedAt: 100, updatedAt: 100,
}

function match(event: SessionEvent, role: ConversationMatch['role']): ConversationMatch {
  return { event, view: undefined, role, location: { kind: 'session' } }
}

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, data, seq, time: seq } as SessionEvent
}

describe('Bid Run conversation node', () => {
  it('updates one durable node with live progress and navigates the real execution child', () => {
    const started = event('bid.run.started', { run }, 10)
    const startMatch = match(started, 'start')
    let state = bidRunDefinition.start({} as ConversationNodeContext<BidRunSnapshot>, startMatch, {} as never)
    const progress = event('bid.run.progress', {
      runId: run.runId, epoch: run.epoch, stage: run.stage,
      progress: { phase: 'mapping', summary: '正在映射章节证据', completed: 2, total: 5, updatedAt: 200 },
    }, 11)
    state = bidRunDefinition.update({ state } as ConversationNodeContext<BidRunSnapshot>, match(progress, 'update'), {} as never)
    const node = bidRunDefinition.buildViewNode!({
      key: 'bid-run:run-1', kind: 'bid-run', id: run.runId,
      matches: [startMatch, match(progress, 'update')], start: startMatch, state, current: new Map(),
    })
    expect(node).toMatchObject({
      id: run.runId,
      anchorSeq: 10,
      data: {
        name: 'S4 · 资料映射与目录深化',
        status: 'running',
        phases: [{
          label: '正在映射章节证据 · 2/5',
          members: [{ sessionId: 'execution', status: 'running' }],
        }],
      },
    })
  })

  it('updates the same node when the running-state checkpoint rejects admission', () => {
    const failed = event('bid.run.start_failed', { runId: run.runId, epoch: run.epoch }, 11)
    expect(bidRunDefinition.match(failed)).toEqual({ id: run.runId, role: 'update' })
    const state = bidRunDefinition.update(
      { state: run } as ConversationNodeContext<BidRunSnapshot>,
      match(failed, 'update'),
      {} as never,
    )
    const startMatch = match(event('bid.run.started', { run }, 10), 'start')
    const node = bidRunDefinition.buildViewNode!({
      key: 'bid-run:run-1', kind: 'bid-run', id: run.runId,
      matches: [startMatch, match(failed, 'update')], start: startMatch, state, current: new Map(),
    })
    expect(node).toMatchObject({ id: run.runId, data: { status: 'failed' } })
  })

  it('ignores stale milestones and projects suspension on the same run identity', () => {
    const stale = event('bid.run.progress', {
      runId: run.runId, epoch: run.epoch - 1, stage: run.stage,
      progress: { phase: 'mapping', summary: '过期进度', updatedAt: 150 },
    }, 12)
    expect(bidRunDefinition.update({ state: run } as ConversationNodeContext<BidRunSnapshot>, match(stale, 'update'), {} as never)).toBe(run)

    const suspended = { ...run, status: 'suspended' as const, cause: 'user_stop' as const, updatedAt: 300 }
    const terminal = event('bid.run.suspended', { run: suspended }, 13)
    const state = bidRunDefinition.update({ state: run } as ConversationNodeContext<BidRunSnapshot>, match(terminal, 'update'), {} as never)
    expect(state).toEqual(suspended)
    expect(bidRunDefinition.match(terminal)).toEqual({ id: run.runId, role: 'update' })
  })
})
