/** 通过真实 Loader 执行 S5 当前章节的本地补搜。 */
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BidOrchestrator, getBidClientProjection, validateChapterWriting, type BidStage } from '@deepseek-ai/dsh-bid'
import { runChapterWritingLoop } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'
import { executeDocxExport } from '../../../../packages/bid/bid/src/docx-export.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseChapterExecutionLog } from '../../../../packages/bid/bid/src/chapter-writing-plan-artifacts.ts'

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
  const waiting = await orchestrator.drive()
  agent.session.append('bid.user_confirmation.received', { stage: 'chapter_writing', confirmed: true })
  const runtime = await orchestrator.runConfirmedStage()
  await executeDocxExport(workspace)
  const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
  const log = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
  for (const section of log.sections) {
    section.status = 'pending'
    section.final_writer_child_session_id = null
    section.final_reviewer_child_session_id = null
  }
  await writeFile(logPath, JSON.stringify(log))
  await executeDocxExport(workspace, undefined, 'output/saved.docx')
  process.stdout.write(`${JSON.stringify({ artifacts, evidence_unchanged: true, waiting, runtime, allowed_actions: getBidClientProjection(runtime).allowedActions })}\n`)
} finally {
  await ctx?.fiber.dispose()
}
