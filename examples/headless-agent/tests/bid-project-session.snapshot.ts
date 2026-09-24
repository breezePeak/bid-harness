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
    configPath: fileURLToPath(new URL('../bid-project-session.cordis.snapshot.yml', import.meta.url)),
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
      expect(events.map(event => event.type)).toEqual(['bid.project.resumed', 'bid.writing_entry.changed'])
      expect(events.filter(event => event.type === 'bid.project.resumed').map(event => ({ type: event.type, data: event.data }))).toMatchInlineSnapshot(`
        [
          {
            "data": {
              "revision": 1,
              "state": {
                "run": null,
                "stage": "evidence_mapping",
                "status": "waiting_user",
              },
            },
            "type": "bid.project.resumed",
          },
        ]
      `)
      expect(JSON.parse(await readFile(join(cwd, '.bid-harness/project-state.json'), 'utf8'))).toMatchObject({
        schema_version: 4,
        revision: 1,
        stage: 'evidence_mapping',
        status: 'waiting_user',
        run: null,
      })
      const exported = join(cwd, 'export-project/.bid-harness')
      expect(JSON.parse(await readFile(join(exported, 'project-state.json'), 'utf8'))).toMatchObject({
        schema_version: 4,
        stage: 'docx_export',
        status: 'ready',
        run: null,
      })
      const format = JSON.parse(await readFile(join(exported, 'word-export/default.config.json'), 'utf8')) as { lastExport: { path: string } }
      expect((await readFile(join(exported, format.lastExport.path))).subarray(0, 2).toString()).toBe('PK')
    },
  })
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "details": {
        "body": true,
        "outline": [
          "技术方案",
        ],
        "tender": "项目 A",
      },
      "export": {
        "automaticExport": false,
        "beforeGenerate": false,
        "checkpointUnchanged": true,
        "details": {
          "body": true,
          "outline": [
            "技术方案",
          ],
          "tender": "项目 A",
        },
        "docxAvailable": true,
        "executions": 0,
        "formatRestored": true,
        "headingNumbering": {
          "lists": 1,
          "paragraphs": 1,
          "styles": [
            "Heading1",
            "Heading2",
            "Heading3",
            "Heading4",
            "Heading5",
            "Heading6",
          ],
        },
        "messages": [],
        "nextTask": {
          "run": null,
          "stage": "docx_export",
          "status": "ready",
        },
        "operation": {
          "oneId": true,
          "projectionStatus": "completed",
          "resultMatches": true,
          "steps": [
            "running:collecting",
            "running:exporting",
            "running:finalizing",
            "completed:finalizing",
          ],
        },
        "previewIsFixedSample": true,
        "task": {
          "run": null,
          "stage": "docx_export",
          "status": "ready",
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
      "seedLength": null,
      "task": {
        "run": null,
        "stage": "evidence_mapping",
        "status": "waiting_user",
      },
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
