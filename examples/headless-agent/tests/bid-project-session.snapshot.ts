/** 固定源码 Loader 创建 fresh Session 后的空聊天和项目恢复事件。 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

it('同 Workspace fresh Session 通过源码 Loader 仅恢复 Bid 项目状态', async () => {
  const result = await runLoaderSmoke({
    label: 'Bid 项目接管源码装配', tempDirPrefix: 'dsh-bid-project-session-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-project-session-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(path => readFile(join(store, path), 'utf8')))
      const log = logs.find(value => (JSON.parse(value.split('\n')[0]!) as SessionHeader).id === 'project-session-b')!
      const records = log.trimEnd().split('\n')
      const header = JSON.parse(records[0]!) as SessionHeader
      const events = records.slice(1).map(line => JSON.parse(line) as SessionEvent)
      expect(header.parentSession).toBeUndefined()
      expect(header.seedLength).toBeUndefined()
      expect(events.length).toBeGreaterThan(0)
      expect(events.every(event => event.type === 'bid.project.resumed')).toBe(true)
      expect(events.map(event => ({ type: event.type, data: event.data }))).toMatchInlineSnapshot(`
        [
          {
            "data": {
              "revision": 1,
              "runtime": {
                "stage": "evidence_mapping",
                "status": "waiting_user",
              },
            },
            "type": "bid.project.resumed",
          },
          {
            "data": {
              "revision": 1,
              "runtime": {
                "stage": "evidence_mapping",
                "status": "waiting_user",
              },
            },
            "type": "bid.project.resumed",
          },
        ]
      `)
      expect(JSON.parse(await readFile(join(cwd, '.bid-harness/project-state.json'), 'utf8'))).toMatchObject({
        schema_version: 1, revision: 1, runtime: { stage: 'evidence_mapping', status: 'waiting_user' },
      })
      const exported = join(cwd, 'export-project/.bid-harness')
      expect(JSON.parse(await readFile(join(exported, 'project-state.json'), 'utf8'))).toMatchObject({
        runtime: { stage: 'docx_export', status: 'completed' },
      })
      expect((await readFile(join(exported, 'output/bid.docx'))).subarray(0, 2).toString()).toBe('PK')
    },
  })
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "export": {
        "checkpointUnchanged": true,
        "docxAvailable": true,
        "executions": 1,
        "messages": [],
        "nextRuntime": {
          "stage": "docx_export",
          "status": "completed",
        },
        "runtime": {
          "stage": "docx_export",
          "status": "completed",
        },
        "unchanged": true,
      },
      "fileCount": 1,
      "messages": [],
      "nodes": [],
      "outlineTitles": [
        "技术方案",
      ],
      "parentSession": null,
      "previousMessageCount": 3,
      "runtime": {
        "stage": "evidence_mapping",
        "status": "waiting_user",
      },
      "seedLength": null,
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
