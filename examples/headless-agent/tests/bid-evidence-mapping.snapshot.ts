/** 固定真实 Child 的修复对话、工具执行与 Host 最终来源绑定。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { parseEvidenceMapArtifact, parseOutlineArtifact, parseWebEvidenceSourcesArtifact } from '@deepseek-ai/dsh-bid'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./bid-evidence-mapping-snapshots/', import.meta.url))
const configPath = fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/bid-evidence-mapping-driver.ts', import.meta.url))

it('repairs S4 Web evidence across Child turns through the headless Loader', async () => {
  const result = await runLoaderSmoke({
    label: 'S4 同 Child Web 证据修复',
    tempDirPrefix: 'dsh-s4-web-snapshot-',
    binScript,
    configPath,
    mode: 'src',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const childLogs = logs.filter(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).parentSession !== undefined)
      expect(childLogs).toHaveLength(2)
      const childLog = childLogs.find(log => !log.includes('MAP-FINAL-CHECK'))
      if (childLog === undefined) throw new Error('缺少持久化 Child 日志')
      const [headerLine, ...eventLines] = childLog.trimEnd().split('\n')
      const header = JSON.parse(headerLine!) as SessionHeader
      const events = eventLines.map(line => JSON.parse(line) as SessionEvent)
      const calls = events.filter(event => event.type === 'tool/call')
        .filter(event => event.data.name === 'web_search' || event.data.name === 'web_fetch')
      expect(calls.map(event => [event.data.name, event.data.turn])).toEqual([['web_search', 1], ['web_fetch', 2]])
      expect(childLog).toContain('EVIDENCE_MAPPING_PARTIAL_WEB_EVIDENCE_INVALID')
      expect(childLog).toContain('SEARCH_INVALID_PATTERN')
      expect(childLog).toContain('SEARCH_RAW_OUTPUT_OVERFLOW')
      expect(childLog).toContain('submit_evidence_mapping')
      expect(childLog).toContain('reference_bid')
      expect(childLog).toContain('INVALID_ARGS')
      expect(events.find(event => event.type === 'tool/result')).toMatchObject({ data: { message: { content: [{ isError: true }] } } })
      expect(childLog).toContain('S4 Mapping Child 只允许 grep 资料分块目录或文件，read 资料索引或已登记分块文件。')
      expect(childLog).not.toContain('需要访问控制与安全审计方案。')
      expect(childLog).toContain('本地资料只有实施流程。')
      expect(childLog).not.toContain('EISDIR')
      const finalCheckLog = childLogs.find(log => log.includes('MAP-FINAL-CHECK'))
      if (finalCheckLog === undefined) throw new Error('缺少持久化 Final Check 日志')
      const [finalHeaderLine, ...finalEventLines] = finalCheckLog.trimEnd().split('\n')
      const finalHeader = JSON.parse(finalHeaderLine!) as SessionHeader
      const finalEvents = finalEventLines.map(line => JSON.parse(line) as SessionEvent)
      expect(finalEvents.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['submit_evidence_mapping'])
      expect(finalCheckLog).toContain('https://official.example/standard')

      const projectRoot = join(cwd, '.bid-harness')
      const outline = parseOutlineArtifact(JSON.parse(await readFile(join(projectRoot, 'outline/outline.json'), 'utf8')))
      expect(outline.sections[0]).toMatchObject({
        purpose: '为访问控制项目说明权限控制与安全审计措施，响应安全技术评分。',
        writing_notes: ['分别说明身份鉴别、权限授予和审计记录的执行方法。'],
        suggested_tables: ['角色权限与审计记录对照表'],
      })
      const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(projectRoot, 'analysis/evidence-map.json'), 'utf8')))
      const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(projectRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
      expect(ledger.sources).toHaveLength(1)
      expect(map.section_mappings[0]!.web_materials[0]).toMatchObject({
        source_id: ledger.sources[0]!.source_id, snapshot_path: ledger.sources[0]!.snapshot_path,
      })
      const snapshots = await Promise.all(ledger.sources.map(source => readFile(join(projectRoot, source.snapshot_path), 'utf8')))
      const artifacts = JSON.stringify({
        outline, map, ledger: { ...ledger, sources: ledger.sources.map(source => ({ ...source, fetched_at: '<TIME>' })) }, snapshots,
      }, null, 2) + '\n'
      const sessionIds = [header.parentSession!, header.id, finalHeader.id]
      const transcript = normalizeSessionSnapshot(childLog, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] })
      const finalCheck = normalizeSessionSnapshot(finalCheckLog, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] })
      const parentLog = logs.find(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id === header.parentSession)
      if (parentLog === undefined) throw new Error('缺少持久化父 Agent 日志')
      expect(parentLog).toContain('OUTLINE_REFINEMENT_SCHEMA_INVALID')
      const refinement = normalizeSessionSnapshot(parentLog, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] })
      const expected = { 'child.expected.jsonl': transcript, 'refinement.expected.jsonl': refinement, 'final-check.expected.jsonl': finalCheck, 'artifacts.expected.json': artifacts }
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        for (const [name, content] of Object.entries(expected)) await writeFile(join(fixtureDir, name), content)
      }
      for (const [name, content] of Object.entries(expected)) expect(content).toBe(await readFile(join(fixtureDir, name), 'utf8'))
    },
  })
  expect(JSON.parse(result.stdout)).toEqual({ stage: 'evidence_mapping', status: 'waiting_user' })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
