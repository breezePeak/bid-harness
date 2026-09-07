/** 通过真实 Loader 执行同 Child 跨轮次 Web 证据回放。 */
import type { Context } from '@deepseek-ai/cordis'
import { basename } from 'node:path'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { runEvidenceMappingLoop } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 S4 回放配置路径')
let ctx: Context | undefined
try {
  ctx = await boot('bid-evidence-mapping-snapshot', configPath)
  const filesystem = ctx.get('fs')
  if (!(filesystem instanceof LocalFileSystem)) throw new Error('S4 snapshot requires the real local filesystem')
  const stateFiles = new Set<string>()
  filesystem.internals.inspectTemp = async ({ tempPath }) => {
    stateFiles.add(basename(tempPath).replace(/\.tmp$/, ''))
  }
  const { outcome } = await runEvidenceMappingLoop(ctx, process.cwd(), true)
  if (outcome.status !== 'waiting_user') throw new Error(JSON.stringify(outcome))
  process.stdout.write(`${JSON.stringify({ ...outcome, state_files: [...stateFiles].sort() })}\n`)
} finally {
  await ctx?.fiber.dispose()
}
