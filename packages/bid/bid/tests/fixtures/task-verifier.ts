/** 执行器回归显式注入的语义替身；不用于证明真实 Main 或模型理解。 */
import { executeCapabilityTask as executeProductionCapabilityTask } from '../../src/bid-capability-task.ts'
import type { BidTaskVerifier } from '../../src/bid-task-verification.ts'
import { CallId, type GenerateOptions } from '@deepseek-ai/dsh-llm'

/**
 * 应用回放的语义替身，只输出模型协议允许的判断。
 * @param input 隔离核验子会话中的语义输入。
 * @param messages 核验会话已收到的工具读取结果。
 * @returns 先完整读取证据，再提交不包含身份或摘要的可控工具调用。
 */
export function scriptedVerificationCall(input: {
  requirements?: readonly object[]
  sources: readonly { selected: boolean; text?: string; context_messages?: readonly string[] }[]
  task: { steps: readonly { call: { capability: string } }[] }
  evidence: readonly { evidence_position: number; total_characters: number }[]
}, messages: GenerateOptions['messages']): { name: string; args: object } {
  const file = input.evidence[0]
  if (file === undefined) throw new Error('执行器核验回放缺少证据文件')
  const reads = messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
    .filter(block => block.toolCallId === CallId('verification')).flatMap(block => block.content)
    .filter(block => block.type === 'text').map(block => JSON.parse(block.text) as {
      evidence_position?: number
      end?: number
      next_start?: number | null
    }).filter(read => read.evidence_position === file.evidence_position)
  const previous = reads.at(-1)
  if (previous?.end !== file.total_characters) return { name: 'read_task_evidence', args: {
    evidence_position: file.evidence_position, start: previous?.next_start ?? 0, length: 12_000,
  } }
  const check = { met: true, reason: '测试指定的执行器校验已通过', evidence_positions: [file.evidence_position] }
  if (input.requirements !== undefined) return { name: 'structured_output', args: { checks: input.requirements.map(() => check) } }
  const requirement = { source_quote: input.sources[0]?.context_messages?.[0] ?? input.sources[0]?.text ?? '执行器测试指定的业务产物', object: 'review',
    new_children: false, completed_content: false, repair: false, preserve_migrated_content: false, check }
  return { name: 'structured_output', args: { scope_authorized: true, scope_constraints: [], sources: input.sources.map((source, index) => ({
    relevant: source.selected, requirements: !source.selected ? [] : [{ ...requirement,
      source_quote: source.context_messages?.[0] ?? source.text ?? '' },
    ...index === 0 && (input.task.steps.some(step => step.call.capability === 'docx.export')
        || input.sources[0]?.text === '更正要求并导出 Word。')
      ? [{ ...requirement, object: 'export' }] : []],
  })) } }
}

/** 可控验收只验证既有执行器，任务规划反例单独提供错误或结构结论。 */
export const executorTestVerifier: BidTaskVerifier = async (input) => {
  const requirements = input.requirements ?? [...[input.source.message.message_id,
    ...input.source.issues.map(issue => issue.issue_id)].map(source_id => ({
    source_id, source_quote: source_id === input.source.message.message_id ? input.source.message.text
      : input.source.issues.find(issue => issue.issue_id === source_id)!.instruction,
    description: source_id === input.source.message.message_id ? input.source.message.text
      : input.source.issues.find(issue => issue.issue_id === source_id)!.instruction, object: 'review' as const,
    section_ids: [], new_children: false, completed_content: false, repair: false, preserve_migrated_content: false,
  })), ...input.task.steps.some(step => step.call.capability === 'docx.export') ? [{
    source_id: input.source.message.message_id, source_quote: input.source.message.text,
    description: input.source.message.text, object: 'export' as const,
    section_ids: [], new_children: false, completed_content: false, repair: false, preserve_migrated_content: false,
  }] : []]
  return { scope_authorized: true, relevant_issue_ids: input.source.issues.map(issue => issue.issue_id),
    requirements: [...requirements], checks: requirements.map((_, requirement_index) => ({
      requirement_index, met: true, reason: '测试指定的执行器校验已通过',
      evidence: input.evidence.slice(0, 1).map(({ path, sha256 }) => ({ path, sha256 })),
    })) }
}

/**
 * 保留生产执行、范围守卫及发布，只显式替换非此测试对象的语义核验。
 * @param args 原执行器调用参数。
 * @returns 原执行器结果。
 */
export function executeTestCapabilityTask(...args: Parameters<typeof executeProductionCapabilityTask>) {
  const [canonical, run, dispatcher, agent, session, recovery] = args
  return executeProductionCapabilityTask(canonical, run,
    { ...dispatcher, verifyTask: dispatcher.verifyTask ?? executorTestVerifier }, agent, session, recovery)
}
