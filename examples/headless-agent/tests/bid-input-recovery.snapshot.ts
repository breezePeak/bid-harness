/** 原生回答跨真实 Loader 重启后，生产恢复动作仅执行一次并保存接纳身份。 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('原生输入等待卸载不占执行预算，源码 Loader 重启继续原 Work 一次', async () => {
  const result = await runLoaderSmoke({
    label: '原生输入持久恢复', tempDirPrefix: 'dsh-input-recovery-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-input-recovery-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-project-session.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const runs = join(cwd, '.bid-harness/runs')
      const journals = (await readdir(runs, { recursive: true })).filter(path => /input-[a-f0-9]{64}\.json$/u.test(path))
      expect(journals).toHaveLength(1)
      expect(JSON.parse(await readFile(join(runs, journals[0]!), 'utf8'))).toMatchObject({ phase: 'applied', attempts: 1,
        preparation_failures: 0, decision: 'continue', application: { attempt: 1 } })
    },
  })
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "applied": {
        "acceptedBound": true,
        "applicationBound": true,
        "attempts": 1,
        "budget": 3,
        "decision": "continue",
        "phase": "applied",
      },
      "productionImport": {
        "parseError": "DOCX_PARSE_FAILED: The DOCX source could not be parsed.",
        "parseStatus": "failed",
        "preservedBytes": true,
      },
      "received": [
        "continue",
      ],
      "repeatedQuestions": 0,
      "required": [
        [
          "继续未完成任务（推荐）",
          "停止任务",
        ],
      ],
      "resumeStarts": 1,
      "resumedQuestions": 1,
      "settled": {
        "attempts": 1,
        "budget": 3,
        "phase": "applied",
      },
      "task": {
        "code": "BID_STAGE_VALIDATION_FAILED",
        "stage": "file_intake",
        "status": "failed",
      },
      "waiting": {
        "attempts": 0,
        "budget": 3,
        "phase": "asking",
      },
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
