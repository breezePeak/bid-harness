/** 清理期限只产生诊断；旧写入实际排空之前不得释放项目。 */

/**
 * 观察清理等待而不以超时替代静止证明。
 * @param pending 必须实际结束的资源清理。
 * @param timeoutMs 单个资源的诊断期限。
 * @param blocked 到期时发布具体资源的安全诊断。
 * @returns 原清理结果或原拒绝；总是移除 timer。
 */
export async function observeBidCleanup<T>(pending: Promise<T>, timeoutMs: number, blocked: () => void): Promise<T> {
  const timer = setTimeout(blocked, timeoutMs)
  try { return await pending } finally { clearTimeout(timer) }
}
