/** 固定真实 Loader 的 S3 输入交接、只读保护、局部续修和确认停点。 */
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

it('S3 首次启动后遗漏 RP-000011，重试只修局部并等待用户确认', async () => {
  const result = await runLoaderSmoke({
    label: 'S3 局部响应点修复', tempDirPrefix: 'dsh-s3-outline-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-outline-generation-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const log = logs.find(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id === 's3-outline-recovery')
      if (log === undefined) throw new Error('缺少 S3 持久化会话')
      expect(log).toContain('RP-000011')
      expect(log).toContain('审计留存与追溯')
      expect(log).toContain('正式响应点、确认目录与其他输入只读')
      expect(log).toContain('局部响应点修复')
      const transcript = normalizeSessionSnapshot(log, { sessionIds: ['s3-outline-recovery'], cwd, cwdAliases: [cwd.replaceAll('\\', '/')] })
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
    failed: { stage: 'outline_generation', status: 'failed' },
    outcome: { stage: 'outline_generation', status: 'waiting_user' },
    catalogUnchanged: true, untouchedUnchanged: true, confirmationEvents: 0,
  })
  expect(actual.outline.sections[0]?.scoring_response_point_ids).toHaveLength(11)
  expect(actual.outline.sections[0].scoring_response_points[10]).toEqual({ scoring_id: 'SCORE-1', response_point: '说明审计留存与追溯' })
  const report = parseOutlineQualityReport(actual.report)
  expect(report.reviewed_section_ids).toEqual(['SEC-SECURITY', 'SEC-SERVICE'])
  expect(report.checked_scoring_response_point_ids).toHaveLength(11)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
