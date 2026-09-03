/** 源码 Loader 装配中的 S4 交互回放入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { runStageInteractionLoop } from '../../../../packages/bid/bid/tests/fixtures/stage-interaction-loop.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少阶段交互回放配置')
let ctx: Context | undefined
try {
  ctx = await boot('bid-stage-interaction-snapshot', configPath)
  process.stdout.write(`${JSON.stringify(await runStageInteractionLoop(ctx, process.cwd()))}\n`)
} finally { await ctx?.fiber.dispose() }
