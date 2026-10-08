/** 真实源码 Loader 的项目恢复、DOCX 导出及 S1 文件接入失败回放。 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BID_INITIAL_TASK_STATE, reduceBidTaskState } from '@deepseek-ai/dsh-bid'
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
          "filePathMatches": true,
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

it('源码 Loader 将损坏 DOCX 上传结算为 S1 失败并接受下一批上传', async () => {
  const result = await runLoaderSmoke({
    label: 'S1 损坏 DOCX 接入', tempDirPrefix: 'dsh-bid-file-intake-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-file-intake-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-project-session.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const state: unknown = JSON.parse(await readFile(join(cwd, '.bid-harness/project-state.json'), 'utf8'))
      expect(state).toMatchObject({ stage: 'file_intake', status: 'failed', run: null,
        failure: { code: 'BID_STAGE_VALIDATION_FAILED', issues: [{ code: 'FILE_INTAKE_NO_SUCCESSFUL_TENDER' }] } })
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(path => readFile(join(store, path), 'utf8')))
      const log = logs.find(value => (JSON.parse(value.split('\n')[0]!) as SessionHeader).id === 's1-parse-failure')!
      const events = log.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
      expect(events.filter(event => event.type === 'bid.run.started')).toHaveLength(2)
      expect(events.filter(event => event.type === 'bid.task.changed' && event.data.state.status === 'failed')).toHaveLength(2)
      expect(events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)).toMatchObject({
        stage: 'file_intake', status: 'failed', run: null,
      })
      expect(await readFile(join(cwd, '.bid-harness/input/broken.docx'), 'utf8')).toBe('not a zip archive')
      expect(await readFile(join(cwd, '.bid-harness/input/retry.docx'), 'utf8')).toBe('not a zip archive')
    },
  })
  expect(JSON.parse(result.stdout)).toMatchObject({ locksReleased: [true, true], runs: { count: 2, distinct: true } })
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "actions": [
        [
          "upload_files",
          "send_message",
        ],
        [
          "upload_files",
          "send_message",
        ],
      ],
      "durableTask": {
        "run": null,
        "stage": "file_intake",
        "status": "failed",
      },
      "failures": [
        {
          "failure": {
            "code": "BID_STAGE_VALIDATION_FAILED",
            "issues": [
              {
                "code": "FILE_INTAKE_NO_SUCCESSFUL_TENDER",
                "message": "No tender file was parsed successfully.",
              },
            ],
            "message": "当前阶段结果未通过校验。",
          },
          "run": null,
          "stage": "file_intake",
          "status": "failed",
        },
        {
          "failure": {
            "code": "BID_STAGE_VALIDATION_FAILED",
            "issues": [
              {
                "code": "FILE_INTAKE_NO_SUCCESSFUL_TENDER",
                "message": "No tender file was parsed successfully.",
              },
            ],
            "message": "当前阶段结果未通过校验。",
          },
          "run": null,
          "stage": "file_intake",
          "status": "failed",
        },
      ],
      "files": [
        {
          "chunkIndexPath": null,
          "documentPath": null,
          "inputPath": "input/broken.docx",
          "name": "broken.docx",
          "parseError": "DOCX_PARSE_FAILED: The DOCX source could not be parsed.",
          "parseStatus": "failed",
          "role": "tender",
        },
        {
          "chunkIndexPath": null,
          "documentPath": null,
          "inputPath": "input/retry.docx",
          "name": "retry.docx",
          "parseError": "DOCX_PARSE_FAILED: The DOCX source could not be parsed.",
          "parseStatus": "failed",
          "role": "tender",
        },
      ],
      "locksReleased": [
        true,
        true,
      ],
      "notices": [
        {
          "kind": "interrupted",
          "message": "BID_STAGE_VALIDATION_FAILED；当前阶段结果未通过校验。；FILE_INTAKE_NO_SUCCESSFUL_TENDER: No tender file was parsed successfully.",
          "severity": "error",
          "stage": "file_intake",
        },
        {
          "kind": "interrupted",
          "message": "BID_STAGE_VALIDATION_FAILED；当前阶段结果未通过校验。；FILE_INTAKE_NO_SUCCESSFUL_TENDER: No tender file was parsed successfully.",
          "severity": "error",
          "stage": "file_intake",
        },
      ],
      "outcomes": [
        {
          "error": {
            "code": "BID_FILE_INTAKE_FAILED",
            "files": [
              {
                "error": {
                  "code": "BID_FILE_PARSE_FAILED",
                  "message": "DOCX_PARSE_FAILED: The DOCX source could not be parsed.",
                },
                "name": "broken.docx",
                "role": "tender",
                "status": "failed",
              },
            ],
            "message": "当前阶段结果未通过校验。",
          },
          "ok": false,
        },
        {
          "error": {
            "code": "BID_FILE_INTAKE_FAILED",
            "files": [
              {
                "error": {
                  "code": "BID_FILE_PARSE_FAILED",
                  "message": "DOCX_PARSE_FAILED: The DOCX source could not be parsed.",
                },
                "name": "retry.docx",
                "role": "tender",
                "status": "failed",
              },
            ],
            "message": "当前阶段结果未通过校验。",
          },
          "ok": false,
        },
      ],
      "replies": [
        "DOCX 解析失败，请重新上传可正常打开的招标文件。",
        "DOCX 解析失败，请重新上传可正常打开的招标文件。",
      ],
      "runs": {
        "count": 2,
        "distinct": true,
        "kinds": [
          "file_intake",
          "file_intake",
        ],
        "stages": [
          "file_intake",
          "file_intake",
        ],
      },
      "task": {
        "failure": {
          "code": "BID_STAGE_VALIDATION_FAILED",
          "issues": [
            {
              "code": "FILE_INTAKE_NO_SUCCESSFUL_TENDER",
              "message": "No tender file was parsed successfully.",
            },
          ],
          "message": "当前阶段结果未通过校验。",
        },
        "run": null,
        "stage": "file_intake",
        "status": "failed",
      },
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
