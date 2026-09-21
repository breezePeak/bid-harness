import type { BidRunSnapshot, BidStage } from '@deepseek-ai/dsh-bid/control-plane'
import type {
  ChatConversationViewNode, ConversationNodeDefinition, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { RunProgressCardData, RunProgressStatus } from '@deepseek-ai/dsh-client-ui-primitives'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One durable Bid Run updated in place by its real lifecycle events. */
    'bid-run': RunProgressCardData
  }
}

const STAGE_LABELS: Readonly<Record<BidStage, string>> = {
  file_intake: 'S1 · 文件接入与拆分',
  tender_analysis: 'S2 · 招标信息提取',
  outline_generation: 'S3 · 初步目录生成',
  evidence_mapping: 'S4 · 资料映射与目录深化',
  chapter_writing: 'S5 · 正文编写与审核',
  docx_export: 'S6 · DOCX 导出',
}

type BidRunNodeState = BidRunSnapshot & { readonly startFailed?: true }

function runStatus(run: BidRunNodeState): RunProgressStatus {
  if (run.startFailed === true) return 'failed'
  switch (run.status) {
    case 'running':
    case 'cancelling': return 'running'
    case 'completed': return 'completed'
    case 'suspended':
      if (run.cause === 'user_stop') return 'cancelled'
      if (run.cause === 'host_restart') return 'interrupted'
      return 'failed'
  }
}

function phaseLabel(run: BidRunSnapshot): string {
  const progress = run.progress
  if (progress === undefined) return run.status === 'cancelling' ? '正在停止后台任务' : '正在启动阶段任务'
  const count = progress.completed === undefined || progress.total === undefined
    ? '' : ` · ${String(progress.completed)}/${String(progress.total)}`
  return `${progress.summary}${count}`
}

function projectRun(run: BidRunNodeState): RunProgressCardData {
  const status = runStatus(run)
  const childId = run.executionSessionId
  return {
    name: STAGE_LABELS[run.stage],
    status,
    phases: childId === undefined ? [] : [{
      key: run.stage,
      label: phaseLabel(run),
      members: [{
        key: run.epoch,
        label: STAGE_LABELS[run.stage],
        sessionId: childId as SessionId,
        status,
      }],
    }],
  }
}

/** Fold one Run's start, milestones, cancellation, suspension, and completion into one Chat node. */
export const bidRunDefinition: ConversationNodeDefinition<BidRunNodeState> = {
  kind: 'bid-run',
  target: 'chat',
  match: (event) => {
    if (event.type === 'bid.run.started') return { id: event.data.run.runId, role: 'start' }
    if (event.type === 'bid.run.progress') return { id: event.data.runId, role: 'update' }
    if (event.type === 'bid.run.start_failed') return { id: event.data.runId, role: 'update' }
    if (event.type === 'bid.run.cancelling'
      || event.type === 'bid.run.suspended'
      || event.type === 'bid.run.completed') {
      return { id: event.data.run.runId, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'bid.run.started') throw new Error('bid-run requires bid.run.started')
    return match.event.data.run
  },
  update: (context, match) => {
    if (match.event.type === 'bid.run.progress') {
      if (match.event.data.epoch !== context.state.epoch
        || match.event.data.stage !== context.state.stage) return context.state
      return { ...context.state, progress: match.event.data.progress, updatedAt: match.event.data.progress.updatedAt }
    }
    if (match.event.type === 'bid.run.start_failed') {
      if (match.event.data.epoch !== context.state.epoch) return context.state
      return { ...context.state, startFailed: true }
    }
    if (match.event.type === 'bid.run.cancelling'
      || match.event.type === 'bid.run.suspended'
      || match.event.type === 'bid.run.completed') return match.event.data.run
    return context.state
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: 'bid-run',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: projectRun(context.state),
    }
  },
}
