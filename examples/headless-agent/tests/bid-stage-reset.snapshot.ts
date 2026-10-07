/** S1 重置命令通过源码 Loader 的持久化行为与用户回执。 */
import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BID_INITIAL_TASK_STATE, reduceBidTaskState } from '@deepseek-ai/dsh-bid'
import type {} from '@deepseek-ai/dsh-commands'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

it('源码 Loader 的 /bid-reset-s1 保留资料并回到等待上传状态', async () => {
  const result = await runLoaderSmoke({
    label: 'S1 命令重置', tempDirPrefix: 'dsh-bid-stage-reset-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-reset-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-stage-reset.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const project = join(cwd, '.bid-harness')
      expect(JSON.parse(await readFile(join(project, 'project-state.json'), 'utf8'))).toMatchObject({
        schema_version: 4, stage: 'file_intake', status: 'waiting_user', run: null,
      })
      expect(await readFile(join(project, 'input/tender.md'), 'utf8')).toBe('技术要求：必须按期交付，技术方案得 10 分。')
      expect((JSON.parse(await readFile(join(project, 'manifest.json'), 'utf8')) as { files: unknown[] }).files).toHaveLength(1)
      for (const path of ['analysis', 'outline', 'chapters', 'flowcharts', 'output']) {
        await expect(access(join(project, path))).rejects.toMatchObject({ code: 'ENOENT' })
      }
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(path => readFile(join(store, path), 'utf8')))
      const log = logs.find(value => (JSON.parse(value.split('\n')[0]!) as SessionHeader).id === 'bid-reset-s1')!
      const events = log.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
      expect(events.reduce(reduceBidTaskState, BID_INITIAL_TASK_STATE)).toEqual({ stage: 'file_intake', status: 'waiting_user', run: null })
      const commands = events.filter(event => event.type === 'command/run' || event.type === 'command/done')
      expect(commands.map(event => event.type)).toEqual(['command/run', 'command/done'])
      expect(commands[0]).toMatchObject({ data: { name: 'bid-reset-s1', args: '' } })
      expect(commands[1]).toMatchObject({ data: { kind: 'success' } })
      expect(commands[0]?.data.commandId).toBe(commands[1]?.data.commandId)
    },
  })
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "allowedActions": [
        "upload_files",
        "send_message",
      ],
      "commandLifecycle": {
        "events": [
          "command/run",
          "command/done",
        ],
        "sameId": true,
      },
      "durableTask": {
        "run": null,
        "stage": "file_intake",
        "status": "waiting_user",
      },
      "executionAgents": 0,
      "listed": {
        "description": "回退资料上传阶段（S1）并等待重新上传，保留已上传资料",
        "name": "bid-reset-s1",
      },
      "locksReleased": true,
      "modelMessages": [
        {
          "content": [
            {
              "text": "阶段 file_intake 已重置。此前该阶段及后续阶段的上下文已清除；仅依据当前工作区文件和后续阶段指令重新执行。",
              "type": "text",
            },
          ],
          "source": {
            "form": "notice",
            "kind": "plugin",
            "plugin": "@deepseek-ai/dsh-bid",
            "summary": "已清除 file_intake 及后续阶段上下文。",
          },
        },
      ],
      "modelRequests": 0,
      "preserved": {
        "corpus": true,
        "inputs": true,
        "manifest": true,
      },
      "removed": [
        {
          "path": "analysis",
          "removed": true,
        },
        {
          "path": "outline",
          "removed": true,
        },
        {
          "path": "chapters",
          "removed": true,
        },
        {
          "path": "flowcharts",
          "removed": true,
        },
        {
          "path": "output",
          "removed": true,
        },
      ],
      "restoredModelMessages": [],
      "restoredTask": {
        "run": null,
        "stage": "file_intake",
        "status": "waiting_user",
      },
      "result": {
        "kind": "success",
        "text": "资料上传阶段重置已应用。当前状态：file_intake / waiting_user。",
      },
      "runs": 0,
      "task": {
        "run": null,
        "stage": "file_intake",
        "status": "waiting_user",
      },
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
