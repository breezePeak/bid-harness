/** 固定 Writer 可用资料定位、局部补搜和实际引用的持久化结果。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { parseChapterMetadata, parseChapterWritingManifest, parseEvidenceMapArtifact } from '@deepseek-ai/dsh-bid'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./bid-chapter-writing-snapshots/', import.meta.url))
const configPath = fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/bid-chapter-writing-driver.ts', import.meta.url))

it('S5 通过真实 Loader 补搜未映射资料并保留 S4 map', async () => {
  const result = await runLoaderSmoke({
    label: 'S5 当前章节本地补搜', tempDirPrefix: 'dsh-s5-local-snapshot-', binScript, configPath, mode: 'src',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const childLogs = logs.filter(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).parentSession !== undefined)
      expect(childLogs).toHaveLength(2)
      const writerLog = childLogs.find(log => log.includes('Available Local Corpus：'))
      if (writerLog === undefined) throw new Error('缺少持久化 Writer 日志')
      const [headerLine, ...eventLines] = writerLog.trimEnd().split('\n')
      const header = JSON.parse(headerLine!) as SessionHeader
      const events = eventLines.map(line => JSON.parse(line) as SessionEvent)
      const calls = events.filter(event => event.type === 'tool/call')
      expect(calls.map(event => event.data.name)).toEqual(['read', 'grep', 'read', 'structured_output'])
      expect(writerLog).toContain('Related Materials：[]')
      expect(writerLog).toContain('S5 Chapter Child 不可读取 tender 或未入库资料。')
      expect(events.find(event => event.type === 'tool/result')).toMatchObject({ data: { message: { content: [{ isError: true }] } } })
      expect(writerLog).not.toContain('需要访问控制与安全审计方案。')
      expect(writerLog).toContain('本地资料只有实施流程。')
      expect(writerLog).not.toContain('EISDIR')
      const projectRoot = join(cwd, '.bid-harness')
      const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(projectRoot, 'analysis/evidence-map.json'), 'utf8')))
      expect(map.section_mappings[0]!.local_materials).toEqual([])
      const metadata = parseChapterMetadata(JSON.parse(await readFile(join(projectRoot, 'chapters/meta/0001.json'), 'utf8')))
      expect(metadata.local_materials_used).toEqual([{
        source_kind: 'reference', file_id: expect.any(String), chunk: 'chunk_0001', usage: 'reference', summary: '支撑本章实施流程的组织与步骤安排。',
      }])
      const manifest = parseChapterWritingManifest(JSON.parse(await readFile(join(projectRoot, 'chapters/manifest.json'), 'utf8')))
      expect(manifest.chapters).toHaveLength(1)
      expect(manifest.chapters[0]!.local_materials_used).toEqual(metadata.local_materials_used)
      const markdown = await readFile(join(projectRoot, manifest.chapters[0]!.content_path), 'utf8')
      const sessionIds = [header.parentSession!, ...childLogs.map(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id)]
      const expected = {
        'writer.expected.jsonl': normalizeSessionSnapshot(writerLog, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] }),
        'artifacts.expected.json': JSON.stringify({ map, metadata, markdown }, null, 2) + '\n',
      }
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        for (const [name, content] of Object.entries(expected)) await writeFile(join(fixtureDir, name), content)
      }
      for (const [name, content] of Object.entries(expected)) expect(content).toBe(await readFile(join(fixtureDir, name), 'utf8'))
    },
  })
  expect(JSON.parse(result.stdout)).toEqual({
    evidence_unchanged: true,
    runtime: { stage: 'chapter_writing', status: 'completed' },
    allowed_actions: ['export_docx'],
    artifacts: [
      { stage: 'chapter_writing', type: 'chapter_execution_plan', path: 'chapters/execution-plan.json' },
      { stage: 'chapter_writing', type: 'chapter_execution_log', path: 'chapters/execution-log.json' },
      { stage: 'chapter_writing', type: 'chapter_manifest', path: 'chapters/manifest.json' },
    ],
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
