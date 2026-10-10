/** Bid preset 的真实模型目录、Shell 执行及 OOXML 文件回归。 */
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('Bid 全阶段公开回合保留通用工具并实际生成独立文件', async () => {
  const result = await runLoaderSmoke({
    label: 'Bid 通用工具', tempDirPrefix: 'dsh-bid-general-',
    binScript: fileURLToPath(new URL('./fixtures/bid-general-tools-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-general-tools.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    processTimeoutMs: 120_000,
  })
  const report = JSON.parse(result.stdout) as { outcomes: object[] }
  expect(report).toMatchObject({ schemasChecked: true, webDenied: true, outsideWriteDenied: true,
    formalDirectoryWritable: true, businessStatePreserved: true, docxVerified: true, resumed: true })
  expect(report.outcomes).toMatchInlineSnapshot(`
    [
      {
        "fileCreated": true,
        "stage": "evidence_mapping",
        "status": "failed",
      },
      {
        "fileCreated": true,
        "stage": "outline_generation",
        "status": "waiting_user",
      },
      {
        "fileCreated": true,
        "stage": "evidence_mapping",
        "status": "waiting_user",
      },
      {
        "fileCreated": true,
        "stage": "chapter_writing",
        "status": "running",
      },
      {
        "fileCreated": true,
        "stage": "evidence_mapping",
        "status": "suspended",
      },
    ]
  `)
}, 150_000)
