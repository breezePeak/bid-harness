/** Bid 项目控制只属于 Main Session，不随继承的 Subagent preset 下放。
 * @param summary 会话摘要。
 * @returns 摘要是否代表 Bid 主会话。
 */
export function isBidMainSessionSummary(
  summary: { readonly agentPreset?: string; readonly origin?: string } | undefined,
): boolean {
  return summary?.agentPreset === 'bid' && summary.origin !== 'subagent'
}
