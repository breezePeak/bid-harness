/** 执行器回归显式注入的语义替身；不用于证明真实 Main 或模型理解。 */
import { executeCapabilityTask as executeProductionCapabilityTask } from '../../src/bid-capability-task.ts'
import type { BidTaskVerifier } from '../../src/bid-task-verification.ts'

/**
 * 应用回放的语义替身，只输出模型协议允许的判断。
 * @param input 隔离核验子会话中的语义输入。
 * @returns 不包含身份、编号或证据摘要的可控模型回复。
 */
export function scriptedVerificationReply(input: {
  requirements?: readonly object[]
  sources: readonly { selected: boolean }[]
  task: { steps: readonly { call: { capability: string } }[] }
}): object {
  const check = { met: true, reason: '测试指定的执行器校验已通过' }
  if (input.requirements !== undefined) return { scope_authorized: true, checks: input.requirements.map(() => check) }
  const requirement = { description: '执行器测试指定的业务产物', object: 'review',
    new_children: false, completed_content: false, repair: false, preserve_migrated_content: false, check }
  return { scope_authorized: true, sources: input.sources.map((source, index) => ({
    relevant: source.selected, requirements: !source.selected ? [] : [requirement,
      ...index === 0 && input.task.steps.some(step => step.call.capability === 'docx.export')
        ? [{ ...requirement, description: '执行器测试的独立导出尾步骤', object: 'export' }] : []],
  })) }
}

/** 可控验收只验证既有执行器，任务规划反例单独提供错误或结构结论。 */
export const executorTestVerifier: BidTaskVerifier = async (input) => {
  const requirements = input.requirements ?? [...[input.source.message.message_id,
    ...input.source.issues.map(issue => issue.issue_id)].map(source_id => ({
    source_id, description: '执行器测试指定的业务产物', object: 'review' as const,
    section_ids: [], new_children: false, completed_content: false, repair: false, preserve_migrated_content: false,
  })), ...input.task.steps.some(step => step.call.capability === 'docx.export') ? [{
    source_id: input.source.message.message_id, description: '执行器测试的独立导出尾步骤', object: 'export' as const,
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
