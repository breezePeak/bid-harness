import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it.skipIf(!process.env.DEEPSEEK_API_KEY)('真实模型只从模板正文解释格式规则，正文及 resolved 不变', async () => {
  const result = await runLoaderSmoke({
    label: 'Word 格式建议真实模型', tempDirPrefix: 'bid-word-format-e2e-',
    binScript: fileURLToPath(new URL('./fixtures/bid-word-format-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-word-format.cordis.e2e.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), mode: 'src', processTimeoutMs: 150000,
  })
  expect(JSON.parse(result.stdout)).toMatchObject({
    suggestion: { values: { 'body.font': '宋体', 'body.size': 15, 'body.lineRule': 'exact', 'body.line': 20 } },
    extractedText: ['正文使用宋体，字号15磅，行距固定20磅；其余不变。', '普通模板示例正文。'],
    configuredSize: 12, chapterUnchanged: true, loggedRequest: true,
  })
}, 165000)
