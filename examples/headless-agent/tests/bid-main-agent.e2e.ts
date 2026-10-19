/** 真实主模型自行选图位、规划，真实核验模型审查原 Word 配图结果。 */
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it.skipIf(!process.env.DSH_BID_EVAL_PROVIDER)('真实主 Agent 从上传原 Word 到配图下载', { timeout: 1_860_000, retry: 0 }, async () => {
  const configPath = fileURLToPath(new URL('../bid-general-tools.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '真实主 Agent 原 Word 配图', tempDirPrefix: 'dsh-bid-main-live-',
    binScript: fileURLToPath(new URL('./fixtures/bid-main-agent-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath], mode: 'src', processTimeoutMs: 1_830_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toMatchObject({ realMain: true, realVerifier: true,
    nativeWord: true, actualPages: true, httpDownload: true, resumed: true })
})
