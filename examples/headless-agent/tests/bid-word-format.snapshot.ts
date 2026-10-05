/** 真实 Loader 将模板语义位置选择绑定为正式格式，保存和渲染由程序执行。 */
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('模板解释只选择位置，程序恢复字段键及样式身份', async () => {
  const configPath = fileURLToPath(new URL('../bid-word-format.cordis.e2e.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '模板格式位置绑定', tempDirPrefix: 'bid-word-format-snapshot-', configPath,
    binScript: fileURLToPath(new URL('./fixtures/bid-word-format-driver.ts', import.meta.url)),
    binArgs: [configPath, 'snapshot'], mode: 'src',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const actual = JSON.parse(result.stdout) as { suggestion: unknown
    configuredSize: number
    chapterUnchanged: boolean
    loggedRequest: boolean
    modelProtocol: { system: string
      fieldPositions: boolean
      candidatePositions: boolean
      candidateColumns: string[] } }
  expect(actual.modelProtocol.system).toContain('格式键和样式身份由程序绑定')
  expect({ ...actual, modelProtocol: { ...actual.modelProtocol, system: undefined } }).toMatchInlineSnapshot(`
    {
      "chapterUnchanged": true,
      "configuredSize": 12,
      "extractedText": [
        "正文使用宋体，字号15磅，行距固定20磅；其余不变。",
        "普通模板示例正文。",
      ],
      "loggedRequest": true,
      "modelProtocol": {
        "candidateColumns": [
          "position",
          "name",
          "roles",
          "samples",
        ],
        "candidatePositions": true,
        "fieldPositions": true,
        "system": undefined,
      },
      "suggestion": {
        "evidence": [
          {
            "key": "body.font",
            "source": "template_instruction",
            "text": "正文使用宋体，字号15磅，行距固定20磅",
            "value": "宋体",
          },
          {
            "key": "body.size",
            "source": "template_instruction",
            "text": "正文使用宋体，字号15磅，行距固定20磅",
            "value": 15,
          },
          {
            "key": "body.lineRule",
            "source": "template_instruction",
            "text": "正文使用宋体，字号15磅，行距固定20磅",
            "value": "exact",
          },
          {
            "key": "body.line",
            "source": "template_instruction",
            "text": "正文使用宋体，字号15磅，行距固定20磅",
            "value": 20,
          },
        ],
        "mapping": {
          "body": "Normal",
        },
        "values": {
          "body.font": "宋体",
          "body.line": 20,
          "body.lineRule": "exact",
          "body.size": 15,
        },
      },
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
