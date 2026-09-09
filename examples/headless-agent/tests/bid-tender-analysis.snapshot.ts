/** 固定源码 Loader 中 S2 staged 工具与 Host 生成的正式 Artifact。 */
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('S2 通过真实 staged 工具生成并校验四个正式 Artifact', async () => {
  const result = await runLoaderSmoke({
    label: 'S2 staged submission 源码装配', tempDirPrefix: 'dsh-bid-s2-submission-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-tender-analysis-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-tender-analysis.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "artifacts": [
        "analysis/project.json",
        "analysis/requirements.json",
        "analysis/scoring.json",
        "analysis/compliance.json",
      ],
      "calls": [
        "submit_project_fact",
        "submit_requirement",
        "submit_scoring_item",
        "submit_compliance_item",
        "finish_tender_analysis",
        "finish_tender_analysis",
      ],
      "compliance": [
        {
          "id": "COM-001",
          "severity": "mandatory",
        },
      ],
      "project": {
        "name": "智慧审计平台建设项目",
        "source_lines": [
          [
            9,
            9,
          ],
        ],
        "tender_files": 1,
      },
      "requirements": [
        {
          "id": "REQ-001",
          "mandatory": true,
        },
      ],
      "scoring": [
        {
          "id": "SC-001",
          "parent": null,
          "score": 10,
        },
      ],
      "validation": {
        "ok": true,
      },
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
