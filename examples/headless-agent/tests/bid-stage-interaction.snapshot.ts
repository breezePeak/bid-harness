/** 固定源码 Loader 中的 Main Agent 交互工具、阶段事件与修改结果。 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

it('S4 waiting_user 通过源码 Loader 执行受控对话修改', async () => {
  const result = await runLoaderSmoke({
    label: 'S4 阶段交互源码装配', tempDirPrefix: 'dsh-bid-interaction-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(path => readFile(join(store, path), 'utf8')))
      const parent = logs.find(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id === 's3-real-loop')!
      const events = parent.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
      expect(events.filter(event => event.type === 'bid.stage.started' || event.type === 'bid.user_confirmation.required').slice(-6).map(event => [event.type, event.data.stage])).toEqual([
        ['bid.stage.started', 'evidence_mapping'], ['bid.user_confirmation.required', 'evidence_mapping'],
        ['bid.stage.started', 'evidence_mapping'], ['bid.user_confirmation.required', 'evidence_mapping'],
        ['bid.stage.started', 'evidence_mapping'], ['bid.user_confirmation.required', 'evidence_mapping'],
      ])
      expect(parent).toContain('编号不是 Section ID')
      expect(parent).not.toContain('bid.user_confirmation.received')
    },
  })
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "calls": [
        "bid_stage_inspect",
        "bid_stage_inspect",
        "bid_stage_inspect",
        "bid_stage_inspect",
        "write",
        "bid_outline_apply_operations",
        "bid_outline_regenerate_scope",
        "bid_evidence_remap",
      ],
      "concurrent": [
        "BID_OPERATION_IN_PROGRESS",
        "BID_OPERATION_IN_PROGRESS",
        "BID_OPERATION_IN_PROGRESS",
      ],
      "confirmations": 0,
      "disposed": null,
      "failures": 1,
      "rawWriteBlocked": true,
      "revision": 4,
      "state": {
        "stage": "evidence_mapping",
        "status": "waiting_user",
      },
      "target": {
        "local_materials": [],
        "missing_topics": [
          "缺少当前章节专用资料",
        ],
        "section_id": "SEC-001",
        "web_materials": [],
        "writing_dimensions": [
          "资源核查",
        ],
      },
      "titles": [
        "访问控制与安全审计",
        "实施准备与资源核查",
        "实施过程",
        "验收移交",
      ],
      "turns": [
        {
          "admitted": true,
          "input": "现在是什么情况？",
        },
        {
          "admitted": true,
          "input": "这样可以吗？",
        },
        {
          "admitted": true,
          "input": "可以",
        },
        {
          "admitted": true,
          "input": "没问题",
        },
        {
          "admitted": true,
          "input": "更新目录",
        },
        {
          "admitted": true,
          "input": "第一章拆成实施准备、实施过程、验收移交",
        },
        {
          "admitted": true,
          "input": "实施准备这一节重新规划一下",
        },
        {
          "admitted": true,
          "input": "这一节资料不对，重新找",
        },
      ],
      "untouchedEvidencePreserved": true,
      "visibleTools": [
        "bid_stage_inspect",
        "bid_outline_apply_operations",
        "bid_outline_regenerate_scope",
        "bid_evidence_remap",
      ],
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
