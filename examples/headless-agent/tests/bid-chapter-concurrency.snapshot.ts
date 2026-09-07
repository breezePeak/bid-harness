/** 固定真实 Loader 下三章并发、同一 Writer 多轮修复与独立审查的会话日志。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { parseChapterExecutionLog, parseChapterReviewArtifact } from '@deepseek-ai/dsh-bid'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./bid-chapter-concurrency-snapshots/', import.meta.url))

it('S5 真实 Loader 三章并发，同一 Writer 两轮修复后通过', async () => {
  const result = await runLoaderSmoke({
    label: 'S5 并发与多轮修复', tempDirPrefix: 'dsh-s5-concurrency-snapshot-', mode: 'src',
    binScript: fileURLToPath(new URL('./fixtures/bid-chapter-concurrency-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const projectRoot = join(cwd, '.bid-harness')
      const log = parseChapterExecutionLog(JSON.parse(await readFile(join(projectRoot, 'chapters/execution-log.json'), 'utf8')))
      expect(log.observed_max_concurrency).toBe(3)
      expect(log.sections.every(section => section.status === 'completed')).toBe(true)
      expect(log.sections.map(section => new Set(section.attempts.filter(attempt => attempt.role === 'writer').map(attempt => attempt.child_session_id)).size)).toEqual([1, 1, 1])
      expect(log.sections.map(section => section.attempts.filter(attempt => attempt.role === 'writer').length)).toEqual([3, 1, 1])
      const first = log.sections[0]!
      const reviewers = first.attempts.filter(attempt => attempt.role === 'reviewer')
      expect(new Set(reviewers.map(attempt => attempt.child_session_id)).size).toBe(3)
      expect(reviewers.slice(0, 2).every(attempt => attempt.issues.some(issue => issue.code === 'CHAPTER_REVIEWER_REPAIR_REQUIRED'))).toBe(true)
      expect(reviewers[2]!.issues).toEqual([])
      const review = parseChapterReviewArtifact(JSON.parse(await readFile(join(projectRoot, 'chapters/reviews/0001.json'), 'utf8')))
      expect(review.verdict).toBe('pass')
      expect(review.writer_child_session_id).toBe(first.attempts[0]!.child_session_id)

      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const byId = new Map<string, string>(logs.map(text => [(JSON.parse(text.split('\n')[0]!) as SessionHeader).id, text]))
      const sessionIds = [...byId.keys()]
      const normalize = (text: string) => normalizeSessionSnapshot(text, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] })
      const snapshots: Record<string, string> = { 'planning.expected.jsonl': normalize(byId.get('parent')!) }
      for (const [index, section] of log.sections.entries()) {
        const writerId = section.final_writer_child_session_id!
        snapshots[`writer-${index + 1}.expected.jsonl`] = normalize(byId.get(writerId)!)
        for (const attempt of section.attempts.filter(attempt => attempt.role === 'reviewer')) {
          snapshots[`reviewer-${index + 1}-${attempt.attempt}.expected.jsonl`] = normalize(byId.get(attempt.child_session_id)!)
        }
      }
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        for (const [name, content] of Object.entries(snapshots)) await writeFile(join(fixtureDir, name), content)
      }
      for (const [name, content] of Object.entries(snapshots)) expect(content).toBe(await readFile(join(fixtureDir, name), 'utf8'))
    },
  })
  expect(JSON.parse(result.stdout)).toEqual({ ok: true })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
