/** 固定真实 Loader 的 S3 单次响应点分析、目录生成、质量复核和确认停点。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOutlineQualityReport } from '@deepseek-ai/dsh-bid'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { runOutlineGenerationLoop } from '../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./bid-outline-generation-snapshots/', import.meta.url))

it('S3 一次生成响应点和目录、一次质量复核后等待用户确认', async () => {
  const result = await runLoaderSmoke({
    label: 'S3 有界目录生成', tempDirPrefix: 'dsh-s3-outline-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-outline-generation-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const log = logs.find(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id === 's3-outline-recovery')
      if (log === undefined) throw new Error('缺少 S3 持久化会话')
      const childLogs = logs.filter(content =>
        (JSON.parse(content.split('\n')[0]!) as SessionHeader).parentSession === 's3-outline-recovery')
      expect(childLogs).toHaveLength(1)
      for (const childLog of childLogs) {
        const toolNames = childLog.trimEnd().split('\n').flatMap((line) => {
          const record = JSON.parse(line) as { type?: string; data?: { name?: unknown } }
          return record.type === 'tool/call' && typeof record.data?.name === 'string' ? [record.data.name] : []
        })
        expect(toolNames).toEqual(['structured_output'])
      }
      const workspaceFiles = await readdir(join(cwd, '.bid-harness'), { recursive: true })
      const candidatePath = workspaceFiles.find(path => path.replaceAll('\\', '/').endsWith(
        '/scratch/outline-generation/analysis/scoring-response-points.candidate.json'))
      expect(candidatePath).toBeDefined()
      expect(JSON.parse(await readFile(join(cwd, '.bid-harness', candidatePath!), 'utf8'))).toMatchObject({ schema_version: 1 })
      expect(JSON.parse(await readFile(join(cwd, '.bid-harness/analysis/scoring-response-points.json'), 'utf8'))).toMatchObject({
        schema_version: 1, next_sequence: 12,
      })
      expect(log).toContain('RP-000011')
      expect(log).toContain('审计留存与追溯')
      expect(log).toContain('这是 S3 唯一一次完整 Blueprint Quality Review')
      const reviewTurns = log.trimEnd().split('\n').filter((line) => {
        const record = JSON.parse(line) as { type?: string; data?: { content?: Array<{ text?: unknown }> } }
        return record.type === 'user/message' && record.data?.content?.some(block =>
          typeof block.text === 'string' && block.text.includes('当前阶段：outline_generation / Blueprint Quality Review\n'))
      })
      expect(reviewTurns).toHaveLength(1)
      expect(log).not.toContain('评分响应点语义复核')
      expect(log).not.toContain('OUTLINE_GENERATION_REVIEW_INCOMPLETE')
      const transcript = normalizeSessionSnapshot(log, { sessionIds: ['s3-outline-recovery'], cwd, cwdAliases: [cwd.replaceAll('\\', '/')] })
        .trimEnd().split('\n').map((line) => {
          const record = JSON.parse(line) as { data?: {
            progress?: { updatedAt?: number }
            run?: { startedAt?: number; updatedAt?: number; progress?: { updatedAt?: number } }
          } }
          if (record.data?.progress !== undefined) record.data.progress.updatedAt = 0
          if (record.data?.run !== undefined) {
            record.data.run.startedAt = 0
            record.data.run.updatedAt = 0
            if (record.data.run.progress !== undefined) record.data.run.progress.updatedAt = 0
          }
          return JSON.stringify(record)
        }).join('\n') + '\n'
      const file = join(fixtureDir, 'session.expected.jsonl')
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        await writeFile(file, transcript)
      }
      expect(transcript).toBe(await readFile(file, 'utf8'))
      await expect(readFile(join(cwd, '.bid-harness/outline/initial-confirmed-outline.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  })
  const actual = JSON.parse(result.stdout) as Awaited<ReturnType<typeof runOutlineGenerationLoop>>
  expect(actual).toMatchObject({
    outcome: { stage: 'outline_generation', status: 'waiting_user' },
    untouchedUnchanged: true, confirmationEvents: 0,
  })
  expect(actual.outline.sections[0]?.scoring_response_point_ids).toHaveLength(11)
  expect(actual.outline.sections[0]?.scoring_response_points[10]).toEqual({ scoring_id: 'SCORE-1', response_point: '说明审计留存与追溯' })
  const report = parseOutlineQualityReport(actual.report)
  expect(report.reviewed_section_ids).toEqual(['SEC-SECURITY', 'SEC-SERVICE'])
  expect(report.checked_scoring_response_point_ids).toHaveLength(11)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
