/** 真实模型在 S4 失败态自主生成普通 Word，外部读取 OOXML 验证结果。 */
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it.skipIf(!process.env.DEEPSEEK_API_KEY)('S4 失败不妨碍真实模型使用通用工具生成 Word', async () => {
  const configPath = fileURLToPath(new URL('../bid-general-tools.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'Bid 真实模型通用文件', tempDirPrefix: 'dsh-bid-general-live-',
    binScript: fileURLToPath(new URL('./fixtures/bid-general-tools-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'live'], mode: 'src',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), processTimeoutMs: 240_000,
  })
  expect(JSON.parse(result.stdout)).toMatchObject({ docxVerified: true, businessStatePreserved: true, webDenied: true })
}, 270_000)
