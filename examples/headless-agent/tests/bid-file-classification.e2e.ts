/** 真实主模型从聊天附件内容判断用途，并推进正式招标分析。 */
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it.skipIf(!process.env.DEEPSEEK_API_KEY)('真实主 Agent 根据内容分类普通附件并忽略附件中的越权指令', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({ label: '真实附件分类', tempDirPrefix: 'dsh-bid-classification-live-',
    binScript: fileURLToPath(new URL('./fixtures/bid-file-classification-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, '--live'], mode: 'src',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), processTimeoutMs: 300_000 })
  expect(JSON.parse(result.stdout)).toMatchObject({ originalIdentityPreserved: true, tenderReady: true, userMessages: 1 })
}, 330_000)
