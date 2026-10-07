/** 无 Goal 的 S4 网络退避通过真实 Loader、Agent 取消和磁盘检查点完成恢复。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./bid-evidence-recovery-snapshots/', import.meta.url))
it('S4 内部退避通过源码 Loader 保留 aborted 根因并继续同一任务', async () => {
  const result = await runLoaderSmoke({
    label: 'S4 网络退避恢复', tempDirPrefix: 'dsh-s4-backoff-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-evidence-mapping-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { DSH_S4_RECOVERY_SCENARIO: 'backoff' },
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const childLogs = logs.filter(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).parentSession !== undefined)
      const failed = childLogs.find(log => log.includes('fault-search-0'))
      const recovered = childLogs.find(log => log.includes('finish-initial-mapping'))
      if (failed === undefined || recovered === undefined) throw new Error('缺少网络失败及恢复的真实 Child 日志')
      expect(failed).toContain('WEB_PROVIDER_RATE_LIMITED')
      expect(failed).toContain('evidence-mapping-web-provider-backoff')
      expect(failed).toContain('"kind":"aborted"')
      const headers = [JSON.parse(failed.split('\n')[0]!) as SessionHeader, JSON.parse(recovered.split('\n')[0]!) as SessionHeader]
      const sessionIds = [...headers.map(header => header.parentSession).filter((id): id is NonNullable<typeof id> => id !== undefined),
        ...headers.map(header => header.id)]
      const executionLog = JSON.parse(await readFile(join(cwd, '.bid-harness/analysis/evidence-mapping-log.json'), 'utf8')) as {
        tasks: Array<{ attempts: Array<{ accepted: boolean; issues: Array<{ code: string }> }> }>
      }
      expect(executionLog.tasks[0]?.attempts.map(attempt => attempt.accepted)).toEqual([false, true])
      expect(executionLog.tasks[0]?.attempts[0]?.issues[0]?.code).toBe('WEB_PROVIDER_RATE_LIMITED')
      const expected = {
        'failed.expected.jsonl': normalizeSessionSnapshot(failed, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] }),
        'recovered.expected.jsonl': normalizeSessionSnapshot(recovered, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] }),
      }
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        for (const [name, content] of Object.entries(expected)) await writeFile(join(fixtureDir, name), content)
      }
      for (const [name, content] of Object.entries(expected)) expect(content).toBe(await readFile(join(fixtureDir, name), 'utf8'))
    },
  })
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'waiting_user' })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
