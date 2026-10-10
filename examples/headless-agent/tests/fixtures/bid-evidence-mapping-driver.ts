/** 通过真实 Loader 执行 S4 材料映射、网络退避及结构补修回放。 */
import type { Context } from '@deepseek-ai/cordis'
import { basename } from 'node:path'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { runEvidenceMappingLoop, runEvidenceMappingRecoveryLoop } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 S4 回放配置路径')
// 原 Run 的模型回执包含业务时间戳；固定外部时钟，保留完整恢复记录供跨平台回放。
if (process.env.DSH_S4_RECOVERY_SCENARIO === 'structure' || process.env.DSH_S4_RECOVERY_SCENARIO === 'legacy') {
  Date.now = () => Date.UTC(2026, 9, 8, 10)
}
let ctx: Context | undefined
try {
  ctx = await boot('bid-evidence-mapping-snapshot', configPath)
  const filesystem = ctx.get('fs')
  if (!(filesystem instanceof LocalFileSystem)) throw new Error('S4 snapshot requires the real local filesystem')
  const stateFiles = new Set<string>()
  filesystem.internals.inspectTemp = async ({ tempPath }) => {
    stateFiles.add(basename(tempPath).replace(/\.tmp$/, ''))
  }
  const urlFailure = process.env.DSH_S4_RECOVERY_SCENARIO === 'fetch-url'
  const recovery = urlFailure || process.env.DSH_S4_RECOVERY_SCENARIO === 'backoff' || process.env.DSH_S4_RECOVERY_SCENARIO === 'fetch-backoff'
  const { outcome } = process.env.DSH_S4_RECOVERY_SCENARIO === 'structure' || process.env.DSH_S4_RECOVERY_SCENARIO === 'legacy'
    ? await runEvidenceMappingRecoveryLoop(ctx, process.cwd(), process.env.DSH_S4_RECOVERY_SCENARIO)
    : await runEvidenceMappingLoop(ctx, process.cwd(), !recovery, false,
      urlFailure ? { code: 'WEB_FETCH_FAILED', failures: 1, tool: 'web_fetch' } : recovery ? { code: 'WEB_PROVIDER_RATE_LIMITED', statusCode: 429, failures: 1,
        ...(process.env.DSH_S4_RECOVERY_SCENARIO === 'fetch-backoff' ? { tool: 'web_fetch' as const } : {}) } : undefined,
      undefined, false, process.env.DSH_S4_RECOVERY_SCENARIO === 'review-partitioned' ? 'partitioned'
        : process.env.DSH_S4_RECOVERY_SCENARIO === 'review-budget')
  if (outcome?.status !== 'waiting_user') throw new Error(JSON.stringify(outcome))
  process.stdout.write(`${JSON.stringify({ ...outcome, state_files: [...stateFiles].sort() })}\n`)
} finally {
  await ctx?.fiber.dispose()
}
