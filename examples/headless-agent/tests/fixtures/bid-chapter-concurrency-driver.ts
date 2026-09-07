/** 通过真实 Loader 验证三章并发与同一 Writer 连续两轮修复。 */
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BidWorkspace, buildBidStageTask, executeChapterWriting, validateChapterWriting } from '@deepseek-ai/dsh-bid'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ChapterAdapter } from '../../../../packages/bid/bid/tests/fixtures/chapter-writing-adapter.ts'
import { writeInputs } from '../../../../packages/bid/bid/tests/fixtures/chapter-writing-inputs.ts'
import { registerIntegrationTools } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 S5 回放配置路径')
let ctx: Context | undefined
try {
  ctx = await boot('bid-chapter-concurrency-snapshot', configPath)
  const workspace = new BidWorkspace(process.cwd())
  await writeInputs(workspace)
  const adapter = new ChapterAdapter()
  adapter.repairReviews = 2
  ctx.effect(() => ctx!.llm.registerAdapter(['mock'], adapter))
  registerIntegrationTools(ctx, process.cwd(), [])
  const agent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: process.cwd() })
  const artifacts = await executeChapterWriting(agent, workspace, buildBidStageTask('chapter_writing'), { maxRepairAttempts: 3, maxConcurrency: 3 })
  const validation = await validateChapterWriting(workspace, 'chapter_writing', artifacts)
  process.stdout.write(`${JSON.stringify(validation)}\n`)
} finally {
  await ctx?.fiber.dispose()
}
