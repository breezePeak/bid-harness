/** S4 网络退避及结构失败通过真实 Loader、Main 工具和磁盘检查点完成恢复。 */
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { BidWorkspace, readEvidenceMappingProgress } from '@deepseek-ai/dsh-bid'
import { expect, it } from 'vitest'

it.each(['web_search', 'web_fetch'] as const)('S4 %s 内部退避通过源码 Loader 保留 aborted 根因并继续同一任务', async (tool) => {
  const fixtureDir = fileURLToPath(new URL(tool === 'web_fetch'
    ? './bid-evidence-recovery-snapshots/fetch/' : './bid-evidence-recovery-snapshots/', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'S4 网络退避恢复', tempDirPrefix: 'dsh-s4-backoff-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-evidence-mapping-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { DSH_S4_RECOVERY_SCENARIO: tool === 'web_fetch' ? 'fetch-backoff' : 'backoff' },
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const childLogs = logs.filter(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).parentSession !== undefined)
      const failed = childLogs.find(log => log.includes(tool === 'web_fetch' ? 'fault-fetch-0' : 'fault-search-0'))
      const recovered = childLogs.find(log => log.includes('finish-initial-mapping'))
      if (failed === undefined || recovered === undefined) throw new Error('缺少网络失败及恢复的真实 Child 日志')
      expect(failed).toContain('WEB_PROVIDER_RATE_LIMITED')
      expect(failed).toContain('evidence-mapping-web-provider-backoff')
      expect(failed).toContain('"kind":"aborted"')
      const headers = [JSON.parse(failed.split('\n')[0]!) as SessionHeader, JSON.parse(recovered.split('\n')[0]!) as SessionHeader]
      const sessionIds = [...headers.map(header => header.parentSession).filter((id): id is NonNullable<typeof id> => id !== undefined),
        ...headers.map(header => header.id)]
      const executionLog = JSON.parse(await readFile(join(cwd, '.bid-harness/analysis/evidence-mapping-log.json'), 'utf8')) as {
        tasks: Array<{ attempts: Array<{ accepted: boolean; infrastructure_provider?: string; issues: Array<{ code: string }> }>
          research_observations: Array<{ error_info?: { code: string; statusCode?: number; retryAfter?: string } }>
          research_diagnostics: { searches: number; fetched: number; read: number; adopted: number; bound: number; displayed: number } }>
      }
      expect(executionLog.tasks[0]?.attempts.map(attempt => attempt.accepted)).toEqual([false, true])
      expect(executionLog.tasks[0]?.attempts[0]?.issues[0]?.code).toBe('WEB_PROVIDER_RATE_LIMITED')
      expect(executionLog.tasks[0]?.attempts[0]?.infrastructure_provider).toBe(tool)
      expect(executionLog.tasks[0]?.research_observations[0]?.error_info).toMatchObject({ code: 'WEB_PROVIDER_RATE_LIMITED', statusCode: 429, retryAfter: '0' })
      expect(executionLog.tasks[0]?.research_diagnostics).toMatchObject({ searches: tool === 'web_search' ? 3 : 2, fetched: 2, adopted: 2, bound: 2, displayed: 0 })
      expect((await readEvidenceMappingProgress(new BidWorkspace(cwd)))?.tasks[0]?.research_diagnostics)
        .toMatchObject({ status: 'bound', bound: 2, displayed: 2 })
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

it('S4 完整研究及首代结构修复后，Main 恢复工具实际补修原 Work 再复核', async () => {
  const fixtureDir = fileURLToPath(new URL('./bid-evidence-recovery-snapshots/structure/', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'S4 结构失败定向恢复', tempDirPrefix: 'dsh-s4-structure-recovery-',
    processTimeoutMs: 90_000,
    binScript: fileURLToPath(new URL('./fixtures/bid-evidence-mapping-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { DSH_S4_RECOVERY_SCENARIO: 'structure' },
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const main = logs.find(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id === 's3-real-loop')
      const repair = logs.find(log => log.includes('repair-2-task'))
      const reviewer = logs.find(log => log.includes('review-actual-repair'))
      if (main === undefined || repair === undefined || reviewer === undefined) throw new Error('缺少 Main 恢复、实际补修及后续复核日志')
      const instruction = '保留已研究资料，明确授权岗位核验与审计岗位追溯责任，只补修失败章节后重新复核。'
      expect(main).toContain('bid_recover_task')
      expect(main).toContain('bid.recovery.requested')
      expect(main).not.toContain('INVALID_TOOL_OUTPUT')
      expect(main).toContain('\\"continuation\\":null')
      const mainEvents = main.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
      const runs = mainEvents.filter(event => event.type === 'bid.run.started')
      expect(runs).toHaveLength(2)
      expect(runs[1]!.data.run.work.workId).toBe(runs[0]!.data.run.work.workId)
      expect(runs[1]!.data.run.resumeOf?.runId).toBe(runs[0]!.data.run.runId)
      expect(repair).toContain(instruction)
      expect(reviewer).toContain(instruction)
      expect(reviewer).toContain('由授权岗位核验权限生效，审计岗位对照操作记录完成追溯并保存核验结果。')
      expect(reviewer).toContain('需要访问控制与安全审计方案。')
      const checkpoint = JSON.parse(await readFile(join(cwd, '.bid-harness/analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
        tasks: Array<{ task_id: string; completed: boolean }>
      }
      expect(checkpoint.tasks.filter(task => task.task_id.startsWith('MAP-INIT-'))).toHaveLength(1)
      const repairs = checkpoint.tasks.filter(task => task.task_id.startsWith('MAP-REPAIR-'))
      expect(repairs).toHaveLength(2)
      expect(new Set(repairs.map(task => task.task_id)).size).toBe(2)
      expect(repairs.every(task => task.completed)).toBe(true)
      const headers = logs.map(log => JSON.parse(log.split('\n')[0]!) as SessionHeader)
      const sessionIds = headers.map(header => header.id)
      const canonicalCwd = await realpath(cwd)
      const cwdSpellings = [...new Set(headers.map(header => header.cwd))]
      for (const spelling of cwdSpellings) {
        const resolved = await realpath(spelling)
        expect(process.platform === 'win32' ? resolved.toLowerCase() : resolved)
          .toBe(process.platform === 'win32' ? canonicalCwd.toLowerCase() : canonicalCwd)
      }
      const cwdAliases = [...cwdSpellings, ...cwdSpellings.map(spelling => spelling.replaceAll('\\', '/'))]
      const expected = {
        'main.expected.jsonl': normalizeSessionSnapshot(main, { sessionIds, cwd, cwdAliases }),
        'repair.expected.jsonl': normalizeSessionSnapshot(repair, { sessionIds, cwd, cwdAliases }),
        'review.expected.jsonl': normalizeSessionSnapshot(reviewer, { sessionIds, cwd, cwdAliases }),
      }
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        for (const [name, content] of Object.entries(expected)) await writeFile(join(fixtureDir, name), content)
      }
      for (const [name, content] of Object.entries(expected)) expect(content).toBe(await readFile(join(fixtureDir, name), 'utf8'))
    },
  })
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'waiting_user' })
}, 100_000)
