/** S4 网络退避及结构失败通过真实 Loader、Main 工具和磁盘检查点完成恢复。 */
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { BidWorkspace, readEvidenceMappingProgress } from '@deepseek-ai/dsh-bid'
import { expect, it } from 'vitest'

it('S4 目录复审剩余问题在同一 Run 内自动完成多轮修复', async () => {
  const fixtureDir = fileURLToPath(new URL('./bid-evidence-recovery-snapshots/structure-automatic/', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'S4 连续内容修复', tempDirPrefix: 'dsh-s4-automatic-repair-',
    binScript: fileURLToPath(new URL('./fixtures/bid-evidence-mapping-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { DSH_S4_RECOVERY_SCENARIO: 'structure-automatic' },
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const main = logs.find(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id === 's3-real-loop')!
      const events = main.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
      expect(events.filter(event => event.type === 'bid.run.started')).toHaveLength(1)
      expect(events.some(event => event.type === 'bid.stage.failed' || event.type === 'bid.recovery.requested')).toBe(false)
      const log = JSON.parse(await readFile(join(cwd, '.bid-harness/analysis/evidence-mapping-log.json'), 'utf8')) as {
        tasks: Array<{ task_id: string; status: string }>
        outline_reviews: Array<{ blocking_issues: unknown[] }>
      }
      expect(log.outline_reviews.map(review => review.blocking_issues.length)).toEqual([1, 1, 0])
      expect(log.tasks.filter(task => task.task_id.startsWith('MAP-INIT-'))).toHaveLength(1)
      expect(log.tasks.filter(task => task.task_id.startsWith('MAP-REPAIR-')).map(task => task.task_id))
        .toEqual(['MAP-REPAIR-1-SEC-SECURITY', 'MAP-REPAIR-2-SEC-SECURITY'])
      expect(log.tasks.every(task => task.status === 'completed')).toBe(true)
      const sessionIds = logs.map(content => (JSON.parse(content.split('\n')[0]!) as SessionHeader).id)
      const selected = { main, repair: logs.find(content => content.includes('repair-2-task'))! }
      if (process.env.DSH_SNAPSHOT === 'refresh') await mkdir(fixtureDir, { recursive: true })
      for (const [name, content] of Object.entries(selected)) {
        const normalized = normalizeSessionSnapshot(content, { sessionIds, cwd })
        const path = join(fixtureDir, `${name}.expected.jsonl`)
        if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(path, normalized)
        expect(normalized).toBe(await readFile(path, 'utf8'))
      }
    },
  })
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'waiting_user' })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.each(['web_search', 'web_fetch', 'url_failure'] as const)('S4 %s 通过源码 Loader 保留联网失败并继续同一任务', async (scenario) => {
  const tool = scenario === 'url_failure' ? 'web_fetch' : scenario
  const fixtureDir = fileURLToPath(new URL(scenario === 'url_failure' ? './bid-evidence-recovery-snapshots/url-failure/' : tool === 'web_fetch'
    ? './bid-evidence-recovery-snapshots/fetch/' : './bid-evidence-recovery-snapshots/', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'S4 网络退避恢复', tempDirPrefix: 'dsh-s4-backoff-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-evidence-mapping-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { DSH_S4_RECOVERY_SCENARIO: scenario === 'url_failure' ? 'fetch-url' : tool === 'web_fetch' ? 'fetch-backoff' : 'backoff' },
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const childLogs = logs.filter(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).parentSession !== undefined)
      const failed = childLogs.find(log => log.includes(tool === 'web_fetch' ? 'fault-fetch-0' : 'fault-search-0'))
      const recovered = childLogs.find(log => log.includes('finish-initial-mapping'))
      if (failed === undefined || recovered === undefined) throw new Error('缺少网络失败及恢复的真实 Child 日志')
      if (scenario === 'url_failure') {
        expect(failed).toBe(recovered)
        expect(failed).toContain('WEB_FETCH_FAILED')
        expect(failed).not.toContain('evidence-mapping-web-provider-backoff')
        expect(failed).not.toContain('"kind":"aborted"')
      } else {
        expect(failed).toContain('WEB_PROVIDER_RATE_LIMITED')
        expect(failed).toContain('evidence-mapping-web-provider-backoff')
        expect(failed).toContain('"kind":"aborted"')
      }
      const headers = [JSON.parse(failed.split('\n')[0]!) as SessionHeader, JSON.parse(recovered.split('\n')[0]!) as SessionHeader]
      const sessionIds = [...headers.map(header => header.parentSession).filter((id): id is NonNullable<typeof id> => id !== undefined),
        ...headers.map(header => header.id)]
      const executionLog = JSON.parse(await readFile(join(cwd, '.bid-harness/analysis/evidence-mapping-log.json'), 'utf8')) as {
        tasks: Array<{ attempts: Array<{ accepted: boolean; infrastructure_provider?: string; issues: Array<{ code: string }> }>
          research_observations: Array<{ error_info?: { code: string; statusCode?: number; retryAfter?: string } }>
          research_diagnostics: { searches: number; fetched: number; read: number; adopted: number; bound: number; displayed: number } }>
      }
      if (scenario === 'url_failure') {
        expect(executionLog.tasks[0]?.attempts.map(attempt => attempt.accepted)).toEqual([true])
        expect(executionLog.tasks[0]?.research_observations[0]?.error_info).toMatchObject({ code: 'WEB_FETCH_FAILED' })
      } else {
        expect(executionLog.tasks[0]?.attempts.map(attempt => attempt.accepted)).toEqual([false, true])
        expect(executionLog.tasks[0]?.attempts[0]?.issues[0]?.code).toBe('WEB_PROVIDER_RATE_LIMITED')
        expect(executionLog.tasks[0]?.attempts[0]?.infrastructure_provider).toBe(tool)
        expect(executionLog.tasks[0]?.research_observations[0]?.error_info).toMatchObject({ code: 'WEB_PROVIDER_RATE_LIMITED', statusCode: 429, retryAfter: '0' })
      }
      expect(executionLog.tasks[0]?.research_diagnostics).toMatchObject({ searches: tool === 'web_search' ? 3 : 2, fetched: 2, adopted: 2, bound: 2, displayed: 0 })
      expect((await readEvidenceMappingProgress(new BidWorkspace(cwd)))?.tasks[0]?.research_diagnostics)
        .toMatchObject({ status: 'bound', bound: 2, displayed: 2 })
      const expected = scenario === 'url_failure' ? {
        'child.expected.jsonl': normalizeSessionSnapshot(recovered, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] }),
      } : {
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

it.each(['structure', 'legacy', 'legacy-output', 'server', 'server-takeover', 'transport-takeover'])('S4 完整研究后 Main 恢复原 Work 再复核：%s', async (scenario) => {
  const takeover = scenario === 'server-takeover' || scenario === 'transport-takeover'
  const structure = scenario === 'structure' || takeover
  const fixtureDir = fileURLToPath(new URL(`./bid-evidence-recovery-snapshots/${scenario}/`, import.meta.url))
  const result = await runLoaderSmoke({
    label: 'S4 结构失败定向恢复', tempDirPrefix: 'dsh-s4-structure-recovery-',
    processTimeoutMs: 90_000,
    binScript: fileURLToPath(new URL('./fixtures/bid-evidence-mapping-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { DSH_S4_RECOVERY_SCENARIO: scenario },
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const main = logs.find(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id === 's3-real-loop')
      const repair = logs.find(log => log.includes('repair-2-task'))
      const reviewer = logs.find(log => log.includes(structure ? 'review-actual-repair' : 'review-large-original')
        && (structure || log.includes('本轮复核共享职责索引的所有章节关系')))
      const outputFailure = scenario === 'legacy-output' ? logs.find(log => log.includes('"kind":"max-tokens"')) : undefined
      if (main === undefined || structure && repair === undefined || reviewer === undefined) {
        throw new Error('缺少 Main 恢复及后续复核日志')
      }
      expect(main).toContain(takeover ? 'bid_run_task' : 'bid_recover_task')
      expect(main).toContain('bid.recovery.requested')
      expect(main).not.toContain('INVALID_TOOL_OUTPUT')
      if (scenario === 'structure') expect(main).toContain('\\"continuation\\":null')
      const mainEvents = main.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
      const runs = mainEvents.filter(event => event.type === 'bid.run.started')
      expect(runs).toHaveLength(2)
      for (let index = 1; index < runs.length; index++) {
        if (takeover) {
          expect(runs[index]!.data.run.work.workId).not.toBe(runs[0]!.data.run.work.workId)
          expect(runs[index]!.data.run.resumeOf).toBeUndefined()
        } else {
          expect(runs[index]!.data.run.work.workId).toBe(runs[0]!.data.run.work.workId)
          expect(runs[index]!.data.run.resumeOf?.runId).toBe(runs[index - 1]!.data.run.runId)
        }
      }
      if (structure) {
        const instruction = '保留已研究资料，明确授权岗位核验与审计岗位追溯责任，只补修失败章节后重新复核。'
        expect(repair).toContain(instruction)
        expect(reviewer).toContain(instruction)
        expect(reviewer).toContain('由授权岗位核验权限生效，审计岗位对照操作记录完成追溯并保存核验结果。')
      } else {
        expect(main).toContain(scenario === 'server' ? 'PI_AI_ERROR' : 'CONTEXT_WINDOW_EXCEEDED')
        expect(main).toContain('\\"research_completed\\":1')
        expect(main).toContain('bid.user_confirmation.required')
        expect(logs.filter(log => log.includes('Mapping Task：{\\"task_id\\":\\"MAP-INIT-'))).toHaveLength(1)
        const inspections = mainEvents.filter(event => event.type === 'tool/result'
          && event.data.message.source.callId === 'inspect-structure-recovery')
        expect(inspections).toHaveLength(1)
        for (const event of inspections) {
          if (event.type !== 'tool/result') throw new Error('缺少状态结果')
          const text = event.data.message.content.flatMap(block => block.type === 'tool-result' ? block.content : [])
            .find(block => block.type === 'text')!
          if (text.type !== 'text') throw new Error('缺少恢复 JSON')
          expect(Buffer.byteLength(text.text)).toBeLessThan(50_000)
          expect(JSON.parse(text.text)).toMatchObject({ eligible: true, mapping_progress: { final_check_completed: 0 } })
        }
      }
      const reviews = logs.filter(log => log.includes('review-large-original') || log.includes('review-actual-repair'))
        .sort((left, right) => {
          const prompt = (log: string) => log.split('\n').find(line => line.includes('agent/inbox/spliced')) ?? ''
          const text = (log: string) => JSON.parse(prompt(log)) as { data: { inserted: Array<{ content: unknown }> } }
          return JSON.stringify(text(left).data.inserted[0]?.content).localeCompare(JSON.stringify(text(right).data.inserted[0]?.content))
        })
      expect(reviews.join('\n')).toContain('需要访问控制与安全审计方案。')
      if (scenario === 'legacy-output') {
        expect(outputFailure).toContain('"maxTokens":2048')
        expect(mainEvents.filter(event => event.type === 'bid.recovery.requested')).toHaveLength(1)
        const reviewEvents = reviewer.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
        expect(reviewEvents.find(event => event.type === 'request/header')?.data.header.config.maxTokens).toBe(2_048)
        const failureEvents = outputFailure!.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
        const prompt = (events: SessionEvent[]) => events.filter(event => event.type === 'user/message')
          .map(event => event.data.content).flat()
        expect(prompt(reviewEvents)).not.toEqual(prompt(failureEvents))
      }
      const checkpoint = JSON.parse(await readFile(join(cwd, '.bid-harness/analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
        tasks: Array<{ task_id: string; completed: boolean }>
      }
      expect(checkpoint.tasks.filter(task => task.task_id.startsWith('MAP-INIT-'))).toHaveLength(1)
      const repairs = checkpoint.tasks.filter(task => task.task_id.startsWith('MAP-REPAIR-'))
      expect(repairs).toHaveLength(structure ? 2 : 0)
      expect(new Set(repairs.map(task => task.task_id)).size).toBe(repairs.length)
      expect(repairs.every(task => task.completed)).toBe(true)
      const headers = logs.map(log => JSON.parse(log.split('\n')[0]!) as SessionHeader)
      const sessionIds = headers.map(header => header.id)
      const canonicalCwd = await realpath(cwd)
      const cwdSpellings = [...new Set(headers.map((header) => {
        if (header.cwd === undefined) throw new Error(`结构恢复会话 ${header.id} 缺少工作目录`)
        return header.cwd
      }))]
      for (const spelling of cwdSpellings) {
        const resolved = await realpath(spelling)
        expect(process.platform === 'win32' ? resolved.toLowerCase() : resolved)
          .toBe(process.platform === 'win32' ? canonicalCwd.toLowerCase() : canonicalCwd)
      }
      const cwdAliases = [...cwdSpellings, ...cwdSpellings.map(spelling => spelling.replaceAll('\\', '/'))]
      const expected = {
        'main.expected.jsonl': normalizeSessionSnapshot(main, { sessionIds, cwd, cwdAliases }),
        ...(repair === undefined ? {} : { 'repair.expected.jsonl': normalizeSessionSnapshot(repair, { sessionIds, cwd, cwdAliases }) }),
        ...(outputFailure === undefined ? {} : { 'output-failure.expected.jsonl': normalizeSessionSnapshot(outputFailure, { sessionIds, cwd, cwdAliases }) }),
        'review.expected.jsonl': normalizeSessionSnapshot(reviewer, { sessionIds, cwd, cwdAliases }),
        ...scenario !== 'legacy-output' ? {} : Object.fromEntries(reviews.map((review, index) => [
          `review-part-${index + 1}.expected.jsonl`, normalizeSessionSnapshot(review, { sessionIds, cwd, cwdAliases }),
        ])),
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
