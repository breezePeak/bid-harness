/** 固定真实 Loader 的 S3 单次响应点分析、目录生成、质量复核和确认停点。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOutlineQualityReport } from '@deepseek-ai/dsh-bid'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { runOutlineGenerationLoop } from '../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'
import type { runFullOutlineRegenerationLoop } from '../../../packages/bid/bid/tests/fixtures/stage-interaction-loop.ts'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./bid-outline-generation-snapshots/', import.meta.url))

it('S3 叶节响应点缺项通过专用修复协议补齐并等待确认', async () => {
  const configPath = fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'S3 响应点局部修复', tempDirPrefix: 'dsh-s3-response-repair-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-outline-generation-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'missing-response-point'], mode: 'src',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const repairLog = logs.find(content => content.includes('"id":"repair-outline-response-point"'))
      if (repairLog === undefined) throw new Error('缺少响应点修复 Child 日志')
      expect(repairLog).toContain('局部响应点修复')
      expect(repairLog).toContain('业务关联只提交 response_point_positions')
      expect(repairLog).not.toContain('按问题选择 requirement_positions')
      const header = JSON.parse(repairLog.split('\n')[0]!) as SessionHeader
      const transcript = normalizeSessionSnapshot(repairLog, {
        sessionIds: [header.parentSession!, header.id], cwd, cwdAliases: [cwd.replaceAll('\\', '/')],
      })
      const path = join(fixtureDir, 'response-point-repair-child.expected.jsonl')
      if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(path, transcript)
      expect(transcript).toBe(await readFile(path, 'utf8'))
    },
  })
  const actual = JSON.parse(result.stdout) as Awaited<ReturnType<typeof runOutlineGenerationLoop>>
  expect(actual.outcome).toMatchObject({ stage: 'outline_generation', status: 'waiting_user' })
  expect(actual.untouchedUnchanged).toBe(true)
  expect(actual.outline.sections.find(section => section.id === 'SEC-001')).toMatchObject({
    scoring_response_point_ids: Array.from({ length: 11 }, (_, index) => 'RP-' + String(index + 1).padStart(6, '0')),
    writing_notes: ['明确审计留存期限与追溯责任。'],
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('S3 一次生成响应点和目录、质量复核修改后等待用户确认', async () => {
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
      const phases = log.trimEnd().split('\n').flatMap((line) => {
        const record = JSON.parse(line) as { type?: string; data?: { progress?: { phase: string } } }
        return record.type === 'bid.run.progress' ? [record.data?.progress?.phase] : []
      })
      expect(phases).toEqual(['starting', 'analyzing', 'analyzing', 'generating', 'validating', 'reviewing', 'finalizing'])
      const childLogs = logs.filter(content =>
        (JSON.parse(content.split('\n')[0]!) as SessionHeader).parentSession === 's3-outline-recovery')
      expect(childLogs).toHaveLength(4)
      for (const childLog of childLogs) {
        const toolNames = childLog.trimEnd().split('\n').flatMap((line) => {
          const record = JSON.parse(line) as { type?: string; data?: { name?: unknown } }
          return record.type === 'tool/call' && typeof record.data?.name === 'string' ? [record.data.name] : []
        })
        expect(toolNames).toEqual(['structured_output'])
      }
      const orderedChildren = ['response-points-analysis', 'response-points-review', 'initial-outline', 'quality-review']
        .map(callId => childLogs.find(content => content.includes(`"id":"${callId}"`))!)
      expect(orderedChildren.every(content => content !== undefined)).toBe(true)
      const sessionIds = ['s3-outline-recovery', ...orderedChildren.map(content => (JSON.parse(content.split('\n')[0]!) as SessionHeader).id)]
      const semanticSnapshots = {
        'initial-child.expected.jsonl': normalizeSessionSnapshot(orderedChildren[2]!, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] }),
        'quality-child.expected.jsonl': normalizeSessionSnapshot(orderedChildren[3]!, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] }),
      }
      for (const [name, content] of Object.entries(semanticSnapshots)) {
        const path = join(fixtureDir, name)
        if (process.env.DSH_SNAPSHOT === 'refresh') {
          await mkdir(fixtureDir, { recursive: true })
          await writeFile(path, content)
        }
        expect(content).toBe(await readFile(path, 'utf8'))
      }
      const workspaceFiles = await readdir(join(cwd, '.bid-harness'), { recursive: true })
      expect(workspaceFiles.some(path => path.replaceAll('\\', '/').endsWith('scoring-response-points.candidate.json'))).toBe(false)
      expect(JSON.parse(await readFile(join(cwd, '.bid-harness/analysis/scoring-response-points.json'), 'utf8'))).toMatchObject({
        schema_version: 1, next_sequence: 12,
        points: expect.arrayContaining([expect.objectContaining({ id: 'RP-000011', text: '说明审计留存与追溯' })]) as unknown,
      })
      expect(log).not.toContain('submit_outline_quality_review')
      expect(log).not.toContain('"name":"write"')
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
  expect(actual.outline.sections[0]).toMatchObject({
    id: 'dsh-technical-deviation-table', title: '技术偏离表', parent_id: null, order: 1, level: 1, writable: true,
    requirement_ids: [], scoring_ids: [], scoring_response_point_ids: [], scoring_response_points: [],
    suggested_tables: ['技术偏离表'],
  })
  expect(actual.outline.sections.filter(section => section.id === 'dsh-technical-deviation-table')).toHaveLength(1)
  const security = actual.outline.sections.find(section => section.id === 'SEC-001')
  expect(security?.title).toBe('访问控制、安全审计与追溯')
  expect(security?.scoring_response_point_ids).toHaveLength(11)
  expect(security?.scoring_response_points[10]).toEqual({ scoring_id: 'SCORE-1', response_point: '说明审计留存与追溯' })
  const report = parseOutlineQualityReport(actual.report)
  expect(report.issues).toEqual([{ code: 'OUTLINE_QUALITY_ADVISORY', severity: 'advisory', message: '请确认安全审计与追溯安排。' }])
  expect(report.reviewed_section_ids).toEqual(['dsh-technical-deviation-table', 'SEC-001', 'SEC-002'])
  expect(report.checked_scoring_response_point_ids).toHaveLength(11)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('S3 整本重生成通过嵌套语义树保留已有身份，Host 保存 Draft 和变更清单后等待确认', async () => {
  const configPath = fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'S3 嵌套树整本重生成', tempDirPrefix: 'dsh-s3-full-regeneration-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-outline-generation-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'full-regeneration'], mode: 'src',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const childLog = logs.find(content => content.includes('唯一目录基线：'))
      if (childLog === undefined) throw new Error('缺少整本重生成 Child 日志')
      const header = JSON.parse(childLog.split('\n')[0]!) as SessionHeader
      if (header.cwd === undefined) throw new Error('整本重生成 Child 缺少工作目录')
      const calls = childLog.trimEnd().split('\n').map(line => JSON.parse(line) as {
        type?: string
        data?: { name?: string; arguments?: string }
      }).filter(record => record.type === 'tool/call')
      expect(calls.map(record => record.data?.name)).toEqual(['structured_output'])
      const reply = JSON.parse(calls[0]!.data!.arguments!) as { sections: Array<Record<string, unknown>> }
      expect(reply.sections).toHaveLength(1)
      expect(reply.sections[0]?.source_position).toBeTypeOf('number')
      expect(reply.sections[0]?.children).toEqual([])
      expect(calls[0]!.data!.arguments).not.toMatch(/"(?:id|parent_id|parent_position|order|level|writable)"\s*:/u)
      const transcript = normalizeSessionSnapshot(childLog, {
        sessionIds: [header.parentSession!, header.id], cwd, cwdAliases: [cwd.replaceAll('\\', '/'), header.cwd],
      })
      const path = join(fixtureDir, 'full-regeneration-child.expected.jsonl')
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        await writeFile(path, transcript)
      }
      expect(transcript).toBe(await readFile(path, 'utf8'))
    },
  })
  const actual = JSON.parse(result.stdout) as Awaited<ReturnType<typeof runFullOutlineRegenerationLoop>>
  expect(actual).toMatchObject({ result: { ok: true }, draft: { revision: 2 },
    canonicalPreserved: true, state: { stage: 'evidence_mapping', status: 'waiting_user' } })
  expect(actual.draft.outline.sections.find(section => section.id === 'SEC-SECURITY')?.title).toBe('访问控制与安全审计方案')
  expect(actual.transitions).toContain('bid.run.started')
  expect(actual.transitions).toContain('bid.run.completed')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('S3 父章局部修复失败后恢复原 Work，由新叶节承接响应点并等待用户确认', async () => {
  const configPath = fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'S3 父章响应点迁移', tempDirPrefix: 'dsh-s3-parent-repair-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-outline-generation-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'structural-parent'],
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const log = logs.find(content => (JSON.parse(content.split('\n')[0]!) as SessionHeader).id === 's3-outline-recovery')
      if (log === undefined) throw new Error('缺少 S3 持久化会话')
      const records = log.trimEnd().split('\n').map(line => JSON.parse(line) as {
        type: string
        data: {
          progress?: { phase: string; summary: string; details?: string[] }
          name?: string
          arguments?: string
          state?: { status: string }
        }
      })
      const progress = records.flatMap(record => record.type === 'bid.run.progress' ? [record.data.progress!] : [])
      expect(progress.find(item => item.phase === 'repairing')?.details).toEqual(expect.arrayContaining([
        expect.stringContaining('OUTLINE_SHARED_RESPONSE_POINT_MISSING'),
      ]))
      expect(progress.flatMap(item => item.details ?? []).some(detail => detail.startsWith('OUTLINE_SHARED_WRITABLE_NOT_LEAF'))).toBe(false)
      expect(progress.map(({ phase, summary }) => ({ phase, summary }))).toMatchInlineSnapshot(`
        [
          {
            "phase": "starting",
            "summary": "正在开始 outline_generation 阶段",
          },
          {
            "phase": "analyzing",
            "summary": "正在拆解评分响应点",
          },
          {
            "phase": "analyzing",
            "summary": "正在复核评分响应点",
          },
          {
            "phase": "generating",
            "summary": "正在生成初步技术标目录",
          },
          {
            "phase": "validating",
            "summary": "正在校验目录结构与响应覆盖",
          },
          {
            "phase": "repairing",
            "summary": "正在修正目录确定性问题",
          },
          {
            "phase": "starting",
            "summary": "正在开始 outline_generation 阶段",
          },
          {
            "phase": "analyzing",
            "summary": "已恢复正式评分响应点清单",
          },
          {
            "phase": "validating",
            "summary": "已恢复 S3，目录候选已保存，继续进行确定性校验",
          },
          {
            "phase": "repairing",
            "summary": "正在修正目录确定性问题",
          },
          {
            "phase": "reviewing",
            "summary": "已恢复目录候选，继续质量复核",
          },
          {
            "phase": "finalizing",
            "summary": "正在执行最终目录校验",
          },
        ]
      `)
      expect(records.filter(record => record.type === 'tool/call')).toEqual([])
      expect(records.filter(record => record.type === 'bid.user_confirmation.required')).toHaveLength(1)
      expect(records.filter(record => record.type === 'bid.task.changed' && record.data.state?.status === 'failed')).toHaveLength(1)
      expect(records.filter(record => record.type === 'bid.run.started')).toHaveLength(2)
      expect(records.filter(record => record.type === 'bid.run.notice')).toHaveLength(1)
      expect(records.some(record => record.type === 'bid.run.suspended')).toBe(false)
      const childRecords = logs.filter(content => (JSON.parse(content.split('\n')[0]!) as SessionHeader)
        .parentSession === 's3-outline-recovery').flatMap(log => log.trimEnd().split('\n').map(line => JSON.parse(line) as {
        type: string
        data: { name?: string; arguments?: string }
      }))
      expect(childRecords.filter(record => record.type === 'tool/call').every(record => record.data.name === 'structured_output')).toBe(true)
      for (const call of childRecords.filter(record => record.type === 'tool/call')) {
        expect(call.data.arguments).not.toMatch(/"(?:writable|order|section_id|parent_id|scoring_ids)"\s*:/u)
      }
      const operations = childRecords.filter(record => record.type === 'tool/call').flatMap((record) => {
        const output = JSON.parse(record.data.arguments ?? '{}') as { operations?: Array<{ type: string }> }
        return output.operations?.some(operation => operation.type === 'add_section') ? [output.operations] : []
      }).at(-1)
      expect(operations).toEqual([
        expect.objectContaining({ type: 'add_section', parent_position: 1,
          response_point_positions: Array.from({ length: 11 }, (_, index) => index) }),
      ])
      await expect(readFile(join(cwd, '.bid-harness/outline/initial-confirmed-outline.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  })
  const actual = JSON.parse(result.stdout) as Awaited<ReturnType<typeof runOutlineGenerationLoop>>
  expect(actual.outcome).toMatchObject({ stage: 'outline_generation', status: 'waiting_user' })
  expect(actual.untouchedUnchanged).toBe(true)
  expect(actual.confirmationEvents).toBe(0)
  expect(actual.recovery).toEqual({ failed: true, matched_notice: true, same_work: true, resumed_original_run: true })
  const parent = actual.outline.sections.find(section => section.id === 'SEC-001')
  expect(parent).toMatchObject({ writable: false, must_answer: [], scoring_response_point_ids: [], scoring_response_points: [] })
  const leaf = actual.outline.sections.find(section => section.id === 'SEC-004')
  expect(leaf?.scoring_response_point_ids).toEqual(Array.from({ length: 11 }, (_, index) => 'RP-' + String(index + 1).padStart(6, '0')))
  expect(leaf?.scoring_response_points).toHaveLength(11)
  const report = parseOutlineQualityReport(actual.report)
  expect(report.checked_scoring_response_point_ids).toEqual(leaf?.scoring_response_point_ids)
  expect({ sections: actual.outline.sections.map(section => ({ id: section.id, parent_id: section.parent_id,
    writable: section.writable, response_points: section.scoring_response_point_ids?.length ?? 0 })),
  report }).toMatchInlineSnapshot(`
    {
      "report": {
        "checked_requirement_ids": [
          "REQ-1",
        ],
        "checked_scoring_ids": [
          "SCORE-1",
        ],
        "checked_scoring_response_point_ids": [
          "RP-000001",
          "RP-000002",
          "RP-000003",
          "RP-000004",
          "RP-000005",
          "RP-000006",
          "RP-000007",
          "RP-000008",
          "RP-000009",
          "RP-000010",
          "RP-000011",
        ],
        "issues": [
          {
            "code": "OUTLINE_QUALITY_ADVISORY",
            "message": "请确认安全审计与追溯安排。",
            "severity": "advisory",
          },
        ],
        "reviewed_section_ids": [
          "dsh-technical-deviation-table",
          "SEC-001",
          "SEC-002",
          "SEC-003",
          "SEC-004",
        ],
        "schema_version": 4,
        "scope": "technical_bid",
      },
      "sections": [
        {
          "id": "dsh-technical-deviation-table",
          "parent_id": null,
          "response_points": 0,
          "writable": true,
        },
        {
          "id": "SEC-001",
          "parent_id": null,
          "response_points": 0,
          "writable": false,
        },
        {
          "id": "SEC-002",
          "parent_id": "SEC-001",
          "response_points": 0,
          "writable": true,
        },
        {
          "id": "SEC-003",
          "parent_id": null,
          "response_points": 0,
          "writable": true,
        },
        {
          "id": "SEC-004",
          "parent_id": "SEC-001",
          "response_points": 11,
          "writable": true,
        },
      ],
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
