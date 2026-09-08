import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it.skipIf(!process.env.DEEPSEEK_API_KEY)('真实模型将格式描述转为待确认配置，正文及生效值不变', async () => {
  const result = await runLoaderSmoke({
    label: 'Word 格式建议真实模型', tempDirPrefix: 'bid-word-format-e2e-',
    binScript: fileURLToPath(new URL('./fixtures/bid-word-format-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-word-format.cordis.e2e.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), mode: 'src', processTimeoutMs: 150000,
  })
  expect(JSON.parse(result.stdout)).toMatchObject({
    suggestion: { overrides: { 'body.font': '宋体', 'body.size': 15, 'body.lineRule': 'exact', 'body.line': 20 } },
    configuredSize: 12, chapterUnchanged: true, loggedRequest: true,
  })
}, 165000)
