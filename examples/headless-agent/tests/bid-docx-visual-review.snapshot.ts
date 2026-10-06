/** 固定目标表定位和正常跨页语义进入真实会话的模型输入。 */
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('S6 表格视觉审核定位真实页面并记录正常跨页约束', async () => {
  const configPath = fileURLToPath(new URL('../bid-word-format.cordis.e2e.yml', import.meta.url))
  const result = await runLoaderSmoke({ label: 'S6 表格最终页面审核', tempDirPrefix: 'bid-docx-visual-snapshot-',
    configPath, binScript: fileURLToPath(new URL('./fixtures/bid-docx-visual-review-driver.ts', import.meta.url)),
    binArgs: [configPath], mode: 'src',
    processTimeoutMs: 45_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "anchor": [
        "复核关闭",
        "首接与分",
        "响应处理",
        "项目内容",
        "一般协调",
        "驻场登记",
        "升级路径",
        "内容",
      ],
      "decision": {
        "status": "pass",
      },
      "imageCount": 3,
      "kind": "table",
      "loggedRequest": true,
      "pageCount": 5,
      "pages": [
        3,
        4,
        5,
      ],
      "prompt": "只检查最终 Word 页面中的 table 块 table_d225bb3fe5ee_01 是否超界、裁切、重叠、变形或严重不可读。
    程序边界检查：within-page。
    允许调整：{"fontScale":0.6..1}。
    目标表定位片段：复核关闭、首接与分、响应处理、项目内容、一般协调、驻场登记、升级路径、内容。表格允许正常跨页延续和重复表头；分页边缘的行在相邻页继续不属于裁切。只检查目标表，不因相邻页的其他图表要求调整。
    只返回 JSON：通过时 {"status":"pass"}；需调整时 {"status":"adjust","reason":"简短原因","adjustment":{...}}。",
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS + 15_000)
