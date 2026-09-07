/** 在真实源码 Loader 上回放 S2 staged submission。 */
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { runTenderAnalysisLoop } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 S2 staged submission 回放配置')
let ctx: Context | undefined
try {
  ctx = await boot('bid-tender-analysis-snapshot', configPath)
  process.stdout.write(`${JSON.stringify(await runTenderAnalysisLoop(ctx, process.cwd()))}\n`)
} finally { await ctx?.fiber.dispose() }
