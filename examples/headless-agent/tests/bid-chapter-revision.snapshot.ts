/** 固定章节原 Writer 的修订会话、越界提交拒绝和最终正文。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { parseChapterExecutionLog, parseChapterMetadata } from '@deepseek-ai/dsh-bid'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./bid-chapter-revision-snapshots/', import.meta.url))
const configPath = fileURLToPath(new URL('../bid-chapter-revision.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/bid-chapter-revision-driver.ts', import.meta.url))

it('章节重写和相邻段落修改续用原 Writer 上下文，越界提交不能落盘', async () => {
  const result = await runLoaderSmoke({
    label: 'S5 原 Writer 定向修订', tempDirPrefix: 'dsh-s5-revision-snapshot-', binScript, configPath, mode: 'src',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const projectRoot = join(cwd, '.bid-harness')
      const execution = parseChapterExecutionLog(JSON.parse(await readFile(join(projectRoot, 'chapters/execution-log.json'), 'utf8')))
      const writerId = execution.sections[0]!.final_writer_child_session_id
      const writerLogs = logs.filter(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id === writerId)
      expect(writerLogs).toHaveLength(1)
      const writerLog = writerLogs[0]!
      const events = writerLog.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
      expect(events.filter(event => event.type === 'turn/start')).toHaveLength(4)
      const calls = events.filter(event => event.type === 'tool/call')
      expect(calls.filter(event => event.data.name === 'submit_chapter')).toHaveLength(10)
      const outsideCall = calls.find(event => event.data.callId === 'reject-outside-selection')
      expect(outsideCall).toBeDefined()
      expect(events.find(event => event.type === 'tool/result' && event.data.message.source.callId === outsideCall?.data.callId))
        .toMatchObject({ data: { message: { content: [{ isError: true }] } } })
      const writerAttempts = execution.sections[0]!.attempts.filter(attempt => attempt.role === 'writer')
      expect(writerAttempts).toHaveLength(4)
      expect(writerAttempts.every(attempt => attempt.accepted && attempt.child_session_id === writerId)).toBe(true)
      const sessionIds = logs.map(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id)
      const expected = {
        'writer.expected.jsonl': normalizeSessionSnapshot(writerLog, {
          sessionIds, cwd,
          cwdAliases: [cwd.replaceAll('\\', '/'), cwd.toLowerCase().replaceAll('\\', '/')],
        }),
        'artifacts.expected.json': JSON.stringify({
          markdown: await readFile(join(projectRoot, 'chapters/sections/0001.md'), 'utf8'),
          metadata: parseChapterMetadata(JSON.parse(await readFile(join(projectRoot, 'chapters/meta/0001.json'), 'utf8'))),
        }, null, 2) + '\n',
      }
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        for (const [name, content] of Object.entries(expected)) await writeFile(join(fixtureDir, name), content)
      }
      for (const [name, content] of Object.entries(expected)) expect(content).toBe(await readFile(join(fixtureDir, name), 'utf8'))
    },
  })
  expect(JSON.parse(result.stdout)).toEqual({
    writer_session_reused: true, original_context_retained: true, main_agent_completion_reviewed: true,
    paragraphs_outside_selection_unchanged: true, evidence_unchanged: true,
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
