/** 通过真实 Loader 执行同 Child 跨轮次 Web 证据回放。 */
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { runEvidenceMappingLoop } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 S4 回放配置路径')
let ctx: Context | undefined
try {
  ctx = await boot('bid-evidence-mapping-snapshot', configPath)
  const { outcome } = await runEvidenceMappingLoop(ctx, process.cwd(), true)
  if (outcome.status !== 'waiting_user') throw new Error(JSON.stringify(outcome))
  process.stdout.write(`${JSON.stringify(outcome)}\n`)
} finally {
  await ctx?.fiber.dispose()
}
