/** 通过真实 Loader 执行 S5 当前章节的本地补搜。 */
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BidOrchestrator, getBidClientProjection, validateChapterWriting, type BidStage } from '@deepseek-ai/dsh-bid'
import { runChapterWritingLoop } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 S5 回放配置路径')
let ctx: Context | undefined
try {
  ctx = await boot('bid-chapter-writing-snapshot', configPath)
  const { agent, artifacts, workspace } = await runChapterWritingLoop(ctx, process.cwd())
  const completed = (stage: BidStage): void => {
    agent.session.append('bid.stage.started', { stage, status: 'running' })
    agent.session.append('bid.stage.completed', { stage, status: 'completed', artifacts: [] })
  }
  for (const stage of ['file_intake', 'tender_analysis', 'outline_generation', 'evidence_mapping'] as const) completed(stage)
  const orchestrator = new BidOrchestrator(
    agent.session,
    { canExecute: stage => stage === 'chapter_writing', execute: async () => artifacts },
    { validate: (stage, output) => validateChapterWriting(workspace, stage, output) },
  )
  const runtime = await orchestrator.drive()
  process.stdout.write(`${JSON.stringify({ artifacts, evidence_unchanged: true, runtime, allowed_actions: getBidClientProjection(runtime).allowedActions })}\n`)
} finally {
  await ctx?.fiber.dispose()
}
