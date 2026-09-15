/** Bid-preset human commands that rewind a workflow stage before native Host confirmation. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { BidStage } from './control-plane-contract.ts'
import { BidOrchestratorError } from './orchestrator.ts'

export const name = 'bid-stage-reset-commands'
export const inject = ['bid', 'commands']

const COMMANDS: ReadonlyArray<{
  readonly name: string
  readonly description: string
  readonly stage: BidStage
  readonly label: string
}> = [
  { name: 'bid-reset-s2', description: '回退招标分析阶段（S2），确认后再开始', stage: 'tender_analysis', label: '招标分析' },
  { name: 'bid-reset-s3', description: '回退初步目录阶段（S3），确认后再开始', stage: 'outline_generation', label: '初步目录' },
  { name: 'bid-reset-s4', description: '回退资料映射阶段（S4），确认后再开始', stage: 'evidence_mapping', label: '资料映射' },
  { name: 'bid-reset-s5', description: '回退章节编写阶段（S5），确认后再开始', stage: 'chapter_writing', label: '章节编写' },
]

/** Execute one argument-free, stage-specific reset command. */
async function resetStage(
  ctx: Context,
  invocation: CommandInvocation,
  stage: BidStage,
  label: string,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: '阶段重置命令不接受参数。' }
  }
  try {
    const state = await ctx.bid.resetStage(invocation.agent, stage)
    return {
      kind: 'success',
      text: `${label}阶段已重置完毕，等待你确认后开始执行。当前状态：${state.stage} / ${state.status}。`,
    }
  } catch (error: unknown) {
    if (error instanceof BidOrchestratorError) {
      return {
        kind: 'error',
        text: error.code === 'BID_OPERATION_IN_PROGRESS'
          ? '当前阶段仍有 Host 操作在运行，请等待其结束或后端恢复中断状态后重试。'
          : `只能回退到当前或更早的${label}阶段。`,
      }
    }
    throw error
  }
}

/**
 * Register S2–S5 reset commands only inside the Bid agent preset; the post-reset
 * start decision is presented by the shared DSH user-question provider.
 * @param ctx - agent-scoped Context carrying the Host Bid runtime and command registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(function* () {
    for (const command of COMMANDS) {
      yield ctx.commands.register({
        name: command.name,
        description: command.description,
        handler: invocation => resetStage(ctx, invocation, command.stage, command.label),
      })
    }
  }, 'bid: stage reset commands')
}
