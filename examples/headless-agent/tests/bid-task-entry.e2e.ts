/** 通过正式附件、能力与发布入口验证真实作图和原 Word 页面检查。 */
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it.skipIf(!process.env.DSH_BID_EVAL_PROVIDER)('真实独立作图与原 Word 插图交付', { timeout: 660_000, retry: 0 }, async () => {
  const configPath = fileURLToPath(new URL('../bid-general-tools.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({ label: '真实 Bid 任务交付', tempDirPrefix: 'dsh-bid-task-live-',
    binScript: fileURLToPath(new URL('./fixtures/bid-task-entry-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, '--live'], mode: 'src', processTimeoutMs: 630_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) })
  expect(JSON.parse(result.stdout)).toMatchObject({ flowchart: true, nativeWord: true, actualPages: true,
    httpDownload: true, resumed: true, explicitWorkflow: true })
})
