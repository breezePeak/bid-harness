/** 源码 Loader 装配中的 S4 交互回放入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import { join } from 'node:path'
import { runMainTaskPlanningLoop } from '../../../../packages/bid/bid/tests/fixtures/main-task-planning-loop.ts'
import { runTaskExportLoop } from '../../../../packages/bid/bid/tests/fixtures/task-export-loop.ts'
import { runCapabilityReplanLoop, runCapabilitySupersedeLoop,
  runStageInteractionLoop } from '../../../../packages/bid/bid/tests/fixtures/stage-interaction-loop.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少阶段交互回放配置')
let ctx: Context | undefined
try {
  ctx = await boot('bid-stage-interaction-snapshot', configPath)
  if (['task-planning', 'task-adding', 'selected-route'].includes(process.argv[3] ?? '')) {
    await ctx.plugin(AttachmentLocal, { dshHome: join(process.cwd(), '.dsh') })
  }
  const run = process.argv[3] === 'replan' ? runCapabilityReplanLoop
    : process.argv[3] === 'supersede' ? runCapabilitySupersedeLoop
      : process.argv[3] === 'task-planning' ? runMainTaskPlanningLoop : runStageInteractionLoop
  const result = process.argv[3] === 'task-export' ? await runTaskExportLoop(ctx, process.cwd())
    : process.argv[3] === 'selected-route'
      ? await runMainTaskPlanningLoop(ctx, process.cwd(), 'after_migration', 'split', true)
      : process.argv[3] === 'task-adding'
        ? await runMainTaskPlanningLoop(ctx, process.cwd(), undefined, 'add')
        : process.argv[3] === 'failed-supersede' ? await runCapabilitySupersedeLoop(ctx, process.cwd(), true)
          : await run(ctx, process.cwd())
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally { await ctx?.fiber.dispose() }
