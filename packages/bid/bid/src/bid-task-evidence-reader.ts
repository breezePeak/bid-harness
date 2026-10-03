/** 任务核验只读访问 Host 已冻结的完整证据，不开放文件路径或写入工具。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { chapterToolArgs } from './chapter-writing-protocol.ts'
import type { BidTaskVerificationInput } from './bid-task-verification.ts'

/**
 * 在唯一核验 Agent 上注册按字符窗口读取冻结证据的工具。
 * @param agent 本次核验会话。
 * @param evidence Host 已读取并绑定摘要的完整文件。
 * @returns 工具注册的释放函数。
 */
export function attachBidTaskEvidenceReader(agent: Agent, evidence: BidTaskVerificationInput['evidence']): () => void {
  return agent.ctx.tools.register({
    name: 'read_task_evidence',
    description: '按 evidence_position 分段读取本次任务的完整只读证据；返回下一段起点，不能修改文件。',
    parameters: {
      type: 'object', properties: {
        evidence_position: { type: 'integer' }, start: { type: 'integer' }, length: { type: 'integer' },
      }, required: ['evidence_position', 'start', 'length'], additionalProperties: false,
    },
    presentCall: () => ({ card: 'generic', title: '读取任务核验证据' }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      if (exec.agent !== agent) throw new Error('BID_ACTION_NOT_ALLOWED')
      exec.signal.throwIfAborted()
      const input = chapterToolArgs(z.object({
        evidence_position: z.number().int().nonnegative(), start: z.number().int().nonnegative(),
        length: z.number().int().min(1).max(12_000),
      }).strict(), args)
      const file = evidence[input.evidence_position]
      if (file === undefined) throw new ToolArgsError(['evidence_position: 未知证据位置。'])
      if (input.start >= file.text.length && !(input.start === 0 && file.text.length === 0)) {
        throw new ToolArgsError(['start: 超出当前证据文件。'])
      }
      const text = file.text.slice(input.start, input.start + input.length)
      const end = input.start + text.length
      return Promise.resolve({ evidence_position: input.evidence_position, path: file.path, sha256: file.sha256,
        start: input.start, end, total_characters: file.text.length, text,
        next_start: end < file.text.length ? end : null })
    },
  })
}
