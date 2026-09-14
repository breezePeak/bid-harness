/** Bid 项目控制只属于 Main Session，不随继承的 Subagent preset 下放。 */
export function isBidMainSessionSummary(
  summary: { readonly agentPreset?: string; readonly origin?: string } | undefined,
): boolean {
  return summary?.agentPreset === 'bid' && summary.origin !== 'subagent'
}
