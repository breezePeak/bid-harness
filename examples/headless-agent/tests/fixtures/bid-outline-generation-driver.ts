/** 通过真实 Loader 运行 S3 初稿遗漏和局部续修。 */
import { boot } from '@deepseek-ai/dsh-app-boot'
import { runOutlineGenerationLoop } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少 S3 回放配置路径')
const ctx = await boot('bid-outline-generation-snapshot', configPath)
try {
  const result = await runOutlineGenerationLoop(ctx, process.cwd())
  process.stdout.write(JSON.stringify(result) + '\n')
} finally { await ctx.fiber.dispose() }
