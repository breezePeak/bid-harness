/** 源码 Loader 装配中的 S4 交互回放入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { join } from 'node:path'
import { runMainTaskPlanningLoop } from '../../../../packages/bid/bid/tests/fixtures/main-task-planning-loop.ts'
import { runCapabilityReplanLoop, runCapabilitySupersedeLoop,
  runStageInteractionLoop } from '../../../../packages/bid/bid/tests/fixtures/stage-interaction-loop.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少阶段交互回放配置')
let ctx: Context | undefined
try {
  ctx = await boot('bid-stage-interaction-snapshot', configPath)
  if (process.argv[3] === 'task-planning') await ctx.plugin(AttachmentLocal, { dshHome: join(process.cwd(), '.dsh') })
  const run = process.argv[3] === 'replan' ? runCapabilityReplanLoop
    : process.argv[3] === 'supersede' ? runCapabilitySupersedeLoop
      : process.argv[3] === 'task-planning' ? runMainTaskPlanningLoop : runStageInteractionLoop
  process.stdout.write(`${JSON.stringify(await run(ctx, process.cwd()))}\n`)
} finally { await ctx?.fiber.dispose() }
