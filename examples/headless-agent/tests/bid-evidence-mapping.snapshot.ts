/** 固定真实 Child 的修复对话、工具执行与 Host 最终来源绑定。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { parseEvidenceMapArtifact, parseWebEvidenceSourcesArtifact } from '@deepseek-ai/dsh-bid'
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
      const childLog = logs.find(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).parentSession !== undefined)
      if (childLog === undefined) throw new Error('缺少持久化 Child 日志')
      const [headerLine, ...eventLines] = childLog.trimEnd().split('\n')
      const header = JSON.parse(headerLine!) as SessionHeader
      const events = eventLines.map(line => JSON.parse(line) as SessionEvent)
      const calls = events.filter(event => event.type === 'tool/call')
        .filter(event => event.data.name === 'web_search' || event.data.name === 'web_fetch')
      expect(calls.map(event => [event.data.name, event.data.turn])).toEqual([['web_search', 1], ['web_fetch', 2]])
      expect(childLog).toContain('EVIDENCE_MAPPING_PARTIAL_WEB_EVIDENCE_INVALID')

      const sessionRoot = join(cwd, '.bid-harness/sessions', header.parentSession!)
      const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(sessionRoot, 'analysis/evidence-map.json'), 'utf8')))
      const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
      expect(ledger.sources).toHaveLength(1)
      expect(map.section_mappings[0]!.web_materials[0]).toMatchObject({
        source_id: ledger.sources[0]!.source_id, snapshot_path: ledger.sources[0]!.snapshot_path,
      })
      const snapshots = await Promise.all(ledger.sources.map(source => readFile(join(sessionRoot, source.snapshot_path), 'utf8')))
      const artifacts = JSON.stringify({
        map, ledger: { ...ledger, sources: ledger.sources.map(source => ({ ...source, fetched_at: '<TIME>' })) }, snapshots,
      }, null, 2) + '\n'
      const transcript = normalizeSessionSnapshot(childLog, { sessionIds: [header.parentSession!, header.id], cwd })
      const expected = { 'child.expected.jsonl': transcript, 'artifacts.expected.json': artifacts }
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        for (const [name, content] of Object.entries(expected)) await writeFile(join(fixtureDir, name), content)
      }
      for (const [name, content] of Object.entries(expected)) expect(content).toBe(await readFile(join(fixtureDir, name), 'utf8'))
    },
  })
  expect(JSON.parse(result.stdout)).toEqual({ stage: 'evidence_mapping', status: 'waiting_user' })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
