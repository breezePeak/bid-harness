/** 无密钥的正式应用入口及二进制交付回放。 */
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('空会话经真实附件和能力任务交付原 Word，重载后下载并显式开始完整路线', async () => {
  const result = await runLoaderSmoke({ label: 'Bid 任务入口', tempDirPrefix: 'dsh-bid-task-entry-',
    binScript: fileURLToPath(new URL('./fixtures/bid-task-entry-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-general-tools.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), processTimeoutMs: 180_000 })
  expect(JSON.parse(result.stdout)).toEqual({ chat: true, uploadOnly: true, flowchart: true, nativeWord: true,
    actualPages: true, httpDownload: true, unsafeDownloadRejected: true, resumed: true, explicitWorkflow: true, schemaCalls: true })
}, 210_000)
