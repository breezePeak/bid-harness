import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BID_SESSION_EVENT_TYPES,
  appendBidSchemaWarning,
  BID_INITIAL_TASK_STATE,
  createBidSchemaWarning,
  BID_STAGES,
  getBidStagePolicy,
  BID_TASK_STATUSES,
  parseBidReviewWorkbenchView,
  reduceBidTaskState,
  suspendForHostRestart,
  type BidSessionEventMap,
  type BidStagePolicy,
  type BidStageTask,
  type StageValidationResult,
} from '@deepseek-ai/dsh-bid'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { BidEvidenceMappingProgress, BidRunNotice } from '@deepseek-ai/dsh-bid/control-plane'

describe('bid control-plane public contract', () => {
  it('校验工作台页数返回，拒绝把异常估算伪装成零页', () => {
    const view = parseBidReviewWorkbenchView({
      schema_version: 6,
      outline: [{ section_id: 'root', parent_id: null, order: 1, title: '方案', writable: false, writing_status: 'not_started', review_status: 'not_started', chapter_indicator: { status: 'not_started', tooltip: '概述待补充' }, content_available: false, page_estimate: { status: 'empty', source: 'default', method: 'fast', template: null } }],
      summary: { chapter_count: 0, content_count: 0, reviewed_count: 0, needs_attention_count: 0, page_estimate: { status: 'unavailable' }, page_target: { status: 'not_set' } },
      global_compliance: { status: 'not_required', reviewed_count: 0, total_count: 0, document_issues: [], delivery_todos: [] },
    })
    expect(view.summary.page_estimate.status).toBe('unavailable')
    expect(() => parseBidReviewWorkbenchView({ ...view, summary: { ...view.summary,
      page_estimate: { status: 'available', pages: 0, source: 'default', method: 'fast', template: null } } })).toThrow()
  })

  it('要求 Host 提供规范化的章节状态指标', () => {
    const view = parseBidReviewWorkbenchView({
      schema_version: 6,
      outline: [{ section_id: 'leaf', parent_id: null, order: 1, title: '方案', writable: true, writing_status: 'writing', review_status: 'not_started', chapter_indicator: { status: 'writing', tooltip: '正在编写' }, content_available: false }],
      summary: { chapter_count: 1, content_count: 0, reviewed_count: 0, needs_attention_count: 0, page_estimate: { status: 'unavailable' }, page_target: { status: 'not_set' } },
      global_compliance: { status: 'not_required', reviewed_count: 0, total_count: 0, document_issues: [], delivery_todos: [] },
    })
    expect(view.outline[0]?.chapter_indicator).toEqual({ status: 'writing', tooltip: '正在编写' })
    expect(() => parseBidReviewWorkbenchView({ ...view, outline: [{ ...view.outline[0]!, chapter_indicator: undefined }] })).toThrow()
  })

  it('exports the fixed stage, status, and event names', () => {
    expect(BID_STAGES).toEqual([
      'file_intake',
      'tender_analysis',
      'outline_generation',
      'evidence_mapping',
      'chapter_writing',
      'docx_export',
    ])
    expect(BID_TASK_STATUSES).toEqual(['ready', 'running', 'waiting_user', 'suspended', 'failed', 'completed'])
    expect(BID_SESSION_EVENT_TYPES).toEqual([
      'bid.project.resumed',
      'bid.task.changed',
      'bid.run.started',
      'bid.run.progress',
      'bid.run.start_failed',
      'bid.run.cancelling',
      'bid.run.suspended',
      'bid.run.notice',
      'bid.run.completed',
      'bid.workflow.failed',
      'bid.stage.started',
      'bid.stage.completed',
      'bid.stage.attention_required',
      'bid.stage.failed',
      'bid.stage.reset',
      'bid.run.decision.required',
      'bid.run.decision.received',
      'bid.user_confirmation.required',
      'bid.user_confirmation.received',
      'bid.writing_entry.changed',
      'bid.docx_export.changed',
      'bid.schema.warning',
      'bid.goal.bound',
      'bid.goal.recovery.requested',
      'bid.capability.input.required',
      'bid.capability.input.received',
    ])
  })

  it('keeps only matching Run progress in the single task state', () => {
    const run = {
      runId: 'run-current', epoch: 3, baseProjectRevision: 4,
      work: {
        kind: 'stage_execution' as const, workId: 'work-current', stage: 'tender_analysis' as const,
        requestRef: 'requests/work-current.json', requestSha256: '1'.repeat(64), inputFingerprint: '2'.repeat(64),
      },
      startedAt: 10, updatedAt: 10,
    }
    const started = reduceBidTaskState(BID_INITIAL_TASK_STATE, {
      type: 'bid.project.resumed',
      data: { state: { stage: 'tender_analysis', status: 'running', run }, revision: 4 },
    } as SessionEvent)
    const progress = { phase: 'collecting', summary: '已整理技术要求。', completed: 28, total: 35, updatedAt: 20 }
    const current = reduceBidTaskState(started, {
      type: 'bid.run.progress', data: { runId: run.runId, epoch: run.epoch, stage: run.work.stage, progress },
    } as SessionEvent)

    expect(current.stage).toBe('tender_analysis')
    expect(current.run?.progress).toEqual(progress)
    expect(reduceBidTaskState(current, {
      type: 'bid.run.progress', data: { runId: 'stale', epoch: run.epoch, stage: run.work.stage,
        progress: { ...progress, summary: '旧 Run' } },
    } as SessionEvent)).toBe(current)
    expect(reduceBidTaskState(current, {
      type: 'bid.run.progress', data: { runId: run.runId, epoch: 2, stage: run.work.stage,
        progress: { ...progress, summary: '旧 epoch' } },
    } as SessionEvent)).toBe(current)
    expect(reduceBidTaskState(current, {
      type: 'bid.run.progress', data: { runId: run.runId, epoch: run.epoch, stage: 'outline_generation',
        progress: { ...progress, summary: '旧阶段' } },
    } as SessionEvent)).toBe(current)

    const suspended = reduceBidTaskState(current, {
      type: 'bid.run.suspended',
      data: { run: { ...current.run!, cause: 'user_stop', updatedAt: 30 } },
    } as SessionEvent)
    expect(suspended.status).toBe('suspended')
    expect(suspended.run?.progress).toEqual(progress)

    const completed = reduceBidTaskState(current, {
      type: 'bid.run.completed',
      data: { run: { ...current.run!, updatedAt: 30 } },
    } as SessionEvent)
    expect(completed).toBe(current)
  })

  it('把遗留 running 确定性转换为 host_restart 挂起', () => {
    const running = reduceBidTaskState(BID_INITIAL_TASK_STATE, {
      type: 'bid.task.changed',
      data: { state: { stage: 'evidence_mapping', status: 'ready', run: null } },
    } as SessionEvent)
    const active = reduceBidTaskState(running, {
      type: 'bid.run.started',
      data: { run: {
        runId: 'run-restart', epoch: 2, baseProjectRevision: 4,
        work: { kind: 'stage_execution', workId: 'work-restart', stage: 'evidence_mapping',
          requestRef: 'requests/work-restart.json', requestSha256: '1'.repeat(64), inputFingerprint: '2'.repeat(64) },
        startedAt: 10, updatedAt: 10,
      } },
    } as SessionEvent)

    expect(suspendForHostRestart(active, 20)).toMatchObject({
      stage: 'evidence_mapping', status: 'suspended',
      run: { runId: 'run-restart', cause: 'host_restart', updatedAt: 20 },
    })
  })

  it('creates non-blocking schema warnings only for non-current values', () => {
    expect(createBidSchemaWarning('outline/outline.json', 3, 3, 'outline_generation')).toBeUndefined()
    expect(createBidSchemaWarning('outline/outline.json', 3, 5, 'outline_generation')).toMatchObject({ reason: 'mismatch', stage: 'outline_generation' })
    expect(createBidSchemaWarning('outline/outline.json', 3, undefined, null)).toMatchObject({ reason: 'missing', stage: null })
    expect(createBidSchemaWarning('outline/outline.json', 3, 'old', null)).toMatchObject({ reason: 'invalid' })
  })

  it('deduplicates the same schema warning within one session and returns boolean', () => {
    const events: Array<{ type: string; data: unknown }> = []
    const session = {
      events,
      append: (type: string, data: unknown) => events.push({ type, data }),
    } as never
    const warning1 = createBidSchemaWarning('outline/outline.json', 3, 999, 'outline_generation')
    const warning2 = createBidSchemaWarning('chapters/execution-log.json', 4, undefined, 'chapter_writing')
    expect(appendBidSchemaWarning(session, undefined)).toBe(false)
    expect(appendBidSchemaWarning(session, warning1)).toBe(true)
    expect(appendBidSchemaWarning(session, warning1)).toBe(false)
    expect(appendBidSchemaWarning(session, warning2)).toBe(true)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'bid.schema.warning', data: { reason: 'mismatch', stage: 'outline_generation' } })
    expect(events[1]).toMatchObject({ type: 'bid.schema.warning', data: { reason: 'missing', stage: 'chapter_writing' } })
    expect(reduceBidTaskState(BID_INITIAL_TASK_STATE, { type: 'bid.schema.warning', data: warning1 } as SessionEvent)).toEqual(BID_INITIAL_TASK_STATE)
  })

  it('keeps every Bid durable event readable by the persistence runtime', () => {
    expect(BID_SESSION_EVENT_TYPES.every(type => KNOWN_SESSION_EVENT_TYPES.has(type))).toBe(true)
  })

  it('expresses a stage policy and task through the package entry', () => {
    const policy: BidStagePolicy = {
      stage: 'tender_analysis',
      executor: 'agent',
      requiredInputs: ['manifest.json'],
      allowedTools: ['grep', 'read', 'write'],
      forbiddenTools: ['bash'],
      requiredArtifacts: ['analysis/requirements.json'],
      validator: 'tender-analysis-validator',
      userGate: 'none',
      nextStage: 'outline_generation',
    }
    const task: BidStageTask = {
      stage: 'tender_analysis',
      objective: 'Extract tender requirements and atomic scoring items.',
      inputs: policy.requiredInputs,
      requiredArtifacts: policy.requiredArtifacts,
      allowedTools: policy.allowedTools,
      constraints: ['Write only the required analysis artifacts.'],
    }

    expect(policy.nextStage).toBe('outline_generation')
    expect(task).toMatchObject({ stage: 'tender_analysis', requiredArtifacts: ['analysis/requirements.json'] })
  })

  it('exports S4 Mapping progress through the browser-safe entry', () => {
    expectTypeOf<BidEvidenceMappingProgress>().toEqualTypeOf<{
      readonly total: number
      readonly initial: number
      readonly supplemental: number
      readonly completed: number
      readonly running: number
      readonly not_started: number
      readonly failed: number
      readonly failed_section_ids: readonly string[]
      readonly tasks: readonly {
        readonly task_id: string
        readonly title: string
        readonly phase: 'initial' | 'final_check'
        readonly status: 'pending' | 'running' | 'completed' | 'failed'
        readonly section_ids: readonly string[]
        readonly child_session_id: string | null
        readonly latest_issue: string | null
      }[]
    }>()
  })

  it('exports the model-invisible Run notice payload', () => {
    expectTypeOf<BidRunNotice>().toEqualTypeOf<{
      readonly noticeId: string
      readonly supersedesTurn: number | null
      readonly runId: string
      readonly stage: typeof BID_STAGES[number]
      readonly kind: 'stopped' | 'interrupted' | 'completed'
      readonly severity: 'info' | 'error'
      readonly message: string
      readonly workId?: string
      readonly resultRef?: string
    }>()
  })

  it('limits evidence mapping Main-Agent policy to planning tools', () => {
    const policy = getBidStagePolicy('evidence_mapping')

    expect(policy.allowedTools).toEqual(['read', 'write'])
    expect(policy.forbiddenTools).toEqual(['bash'])
  })

  it('distinguishes successful and failed validation with multiple issues', () => {
    const success: StageValidationResult = { ok: true }
    const failure: StageValidationResult = {
      ok: false,
      issues: [
        { code: 'MISSING_ARTIFACT', message: 'Requirements are missing.', artifact: 'analysis/requirements.json' },
        { code: 'EMPTY_SCORING', message: 'No scoring items were extracted.' },
      ],
    }

    expect(success.ok).toBe(true)
    expect(failure).toMatchObject({ ok: false, issues: [{ code: 'MISSING_ARTIFACT' }, { code: 'EMPTY_SCORING' }] })
  })

  it('merges bid payloads into the shared session event map', () => {
    expectTypeOf<BidSessionEventMap>().toEqualTypeOf<Pick<SessionEventMap, typeof BID_SESSION_EVENT_TYPES[number]>>()
    expectTypeOf<SessionEventMap['bid.stage.started']>().toEqualTypeOf<{
      stage: 'file_intake' | 'tender_analysis' | 'outline_generation' | 'evidence_mapping' | 'chapter_writing' | 'docx_export'
      status: 'running'
    }>()
    expectTypeOf<SessionEventMap['bid.stage.failed']>().toEqualTypeOf<{
      stage: 'file_intake' | 'tender_analysis' | 'outline_generation' | 'evidence_mapping' | 'chapter_writing' | 'docx_export'
      status: 'failed'
      reason: string
      issues?: Array<{
        code: string
        message: string
        artifact?: string | undefined
        path?: string | undefined
      }>
    }>()
    expectTypeOf<SessionEventMap['bid.stage.reset']>().toEqualTypeOf<{
      stage: 'file_intake' | 'tender_analysis' | 'outline_generation' | 'evidence_mapping' | 'chapter_writing' | 'docx_export'
      status?: 'pending' | 'waiting_start' | 'ready' | 'waiting_user'
    }>()
    expectTypeOf<SessionEventMap['bid.user_confirmation.received']>().toEqualTypeOf<
      | {
        stage: 'file_intake' | 'tender_analysis' | 'outline_generation' | 'evidence_mapping' | 'chapter_writing' | 'docx_export'
        confirmed: true
      }
      | { stage: 'outline_generation' | 'evidence_mapping'; confirmed: false; feedback: string }
    >()
  })
})
