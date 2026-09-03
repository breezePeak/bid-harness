import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BidWorkspace,
  buildBidStageTask,
  executeTenderAnalysis,
  renderTenderAnalysisRepairTask,
  renderTenderAnalysisTask,
} from '@deepseek-ai/dsh-bid'

describe('tender-analysis Agent executor', () => {
  it('stops before issuing stage work when the Host operation is cancelled', async () => {
    const controller = new AbortController()
    const followup = vi.fn()
    const agent = {
      id: 'session',
      whenIdle: vi.fn(async () => { controller.abort() }),
      followup,
    } as unknown as Agent
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-cancel-')))

    await expect(executeTenderAnalysis(
      agent,
      workspace,
      buildBidStageTask('tender_analysis'),
      { maxRepairAttempts: 1, signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('delivers the StageTask through followup, waits for idle, and restricts tools', async () => {
    const liftRestriction = vi.fn()
    const liftGuard = vi.fn()
    const restrict = vi.fn(() => liftRestriction)
    let policy: (exec: { name: string; arguments?: unknown }) => string | undefined = () => undefined
    const guard = vi.fn((next: typeof policy) => {
      policy = next
      return liftGuard
    })
    const resolve = vi.fn(async (path: string) => ({ targetKey: path, displayPath: path }))
    const emit = vi.fn()
    const followup = vi.fn()
    const whenIdle = vi.fn(async () => {})
    const services = { tools: { guard, restrict }, fs: { resolve } }
    const agent = {
      id: 'session',
      ctx: { get: (name: keyof typeof services) => services[name], emit },
      followup,
      whenIdle,
    } as unknown as Agent
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-executor-')))
    const task = buildBidStageTask('tender_analysis')

    const result = await executeTenderAnalysis(agent, workspace, task, { maxRepairAttempts: 1 })

    expect(whenIdle).toHaveBeenCalledTimes(3)
    expect(restrict).toHaveBeenCalledWith({ allow: ['grep', 'read', 'write'] })
    expect(guard).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledTimes(4)
    expect(emit).toHaveBeenCalledTimes(4)
    expect(emit).toHaveBeenCalledWith(
      'fs/observed',
      expect.objectContaining({ displayPath: expect.stringContaining(join('analysis', 'project.json')) }),
      { kind: 'absent' },
      { agent },
    )
    expect(policy({ name: 'read' })).toBeUndefined()
    expect(policy({ name: 'bash' })).toContain('allows only grep, read, write')
    expect(policy({ name: 'write', arguments: { file_path: join(workspace.projectRoot, 'analysis/scoring.json') } })).toBeUndefined()
    expect(policy({ name: 'write', arguments: { file_path: join(workspace.projectRoot, 'analysis/unrelated.json') } })).toContain('may write only its current Artifact paths')
    expect(liftGuard).toHaveBeenCalledOnce()
    expect(liftRestriction).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledTimes(2)
    const message = followup.mock.calls[0]?.[0] as { content: Array<{ type: string; text: string }>; source: unknown }
    const repair = followup.mock.calls[1]?.[0] as { content: Array<{ type: string; text: string }>; source: unknown }
    expect(message.source).toEqual({ kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' })
    expect(message.content[0]?.text).toContain('首先读取：.bid-harness/manifest.json')
    expect(message.content[0]?.text).toContain('只把 manifest 中 role=tender')
    expect(message.content[0]?.text).toContain('当前只分析技术标')
    expect(message.content[0]?.text).toContain('投标报价、价格评分')
    expect(message.content[0]?.text).toContain('project_background')
    expect(message.content[0]?.text).toContain('评分响应点留给 S3 分析')
    expect(message.content[0]?.text).toContain('允许提取、压缩、去冗余和原子化')
    expect(message.content[0]?.text).toContain('不得改变原文的关键数字、单位')
    expect(message.content[0]?.text).toContain('评分区域锚点')
    expect(message.content[0]?.text).toContain('prev_chunk、next_chunk 和 heading_path')
    expect(message.content[0]?.text).toContain('远离当前区域的技术评分锚点')
    expect(message.content[0]?.text).toContain('must_answer 必须是 boolean')
    expect(repair.content[0]?.text).toContain('Artifact Repair')
    expect(repair.content[0]?.text).toContain('TENDER_ANALYSIS_TENDER_MISSING')
    expect(repair.content[0]?.text).toContain('只允许调用：grep, read, write')
    expect(repair.content[0]?.text).toContain('不得伪造引用')
    expect(repair.content[0]?.text).toContain('不要求逐字复制')
    expect(result.map(artifact => artifact.path)).toEqual(task.requiredArtifacts)
  })

  it('stops after the initial extraction when all S2 Artifacts pass validation', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-one-pass-')))
    const [tender] = await workspace.import([{
      name: 'technical-scoring.md',
      role: 'tender',
      bytes: new TextEncoder().encode([
        '# 技术要求',
        '系统功能要求：应支持审计日志。',
        '# 技术评分',
        '技术评分标准：方案完整性满分 10 分。',
      ].join('\n\n')),
    }])
    if (tender === undefined || tender.chunksPath === null || tender.absoluteChunkIndexPath === null) throw new Error('test corpus was not chunked')
    const chunk = (JSON.parse(await readFile(tender.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }).chunks[0]?.path
    if (chunk === undefined) throw new Error('test corpus has no chunks')
    const sourcePath = join(workspace.projectRoot, tender.chunksPath, chunk)
    const source = { file_id: tender.id, chunk: `${tender.chunksPath}/${chunk}`, line_start: 1, line_end: (await readFile(sourcePath, 'utf8')).split('\n').length }
    const output = {
      project: { schema_version: 1, project_name: '项目', tender_name: null, purchaser: null, owner: null, project_background: ['背景'], project_objectives: ['目标'], project_scope: ['范围'], technical_scope: ['技术'], delivery_scope: ['交付'], implementation_constraints: ['约束'], key_technical_points: ['评分'], source_refs: [source], analyzed_tender_files: [tender.id] },
      requirements: { schema_version: 1, requirements: [{ id: 'REQ-1', category: '技术', raw_text: '系统功能要求：应支持审计日志。', normalized_requirement: '支持审计日志。', mandatory: true, source_refs: [source] }] },
      scoring: { schema_version: 1, scoring_items: [{ id: 'SCORE-1', parent: null, group: '技术', title: '技术评分', raw_text: '技术评分标准：方案完整性满分 10 分。', criterion: '方案完整性', score: 10, score_range: null, must_answer: true, source_refs: [source] }] },
      compliance: { schema_version: 1, compliance_items: [{ id: 'COMP-1', type: 'technical', raw_text: '系统功能要求：应支持审计日志。', normalized_rule: '支持审计日志。', severity: 'mandatory', source_refs: [source] }] },
    }
    let idleCount = 0
    const whenIdle = vi.fn(async () => {
      idleCount++
      if (idleCount !== 2) return
      await Promise.all([
        writeFile(join(workspace.projectRoot, 'analysis/project.json'), `${JSON.stringify(output.project)}\n`),
        writeFile(join(workspace.projectRoot, 'analysis/requirements.json'), `${JSON.stringify(output.requirements)}\n`),
        writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), `${JSON.stringify(output.scoring)}\n`),
        writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), `${JSON.stringify(output.compliance)}\n`),
      ])
    })
    const liftRestriction = vi.fn()
    const liftGuard = vi.fn()
    const services = {
      tools: { guard: vi.fn(() => liftGuard), restrict: vi.fn(() => liftRestriction) },
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
    }
    const agent = {
      id: 'session',
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn() },
      followup: vi.fn(),
      whenIdle,
    } as unknown as Agent

    await executeTenderAnalysis(agent, workspace, buildBidStageTask('tender_analysis'), { maxRepairAttempts: 1 })

    expect(whenIdle).toHaveBeenCalledTimes(2)
    expect(agent.followup).toHaveBeenCalledOnce()
  })

  it('limits a scoring repair to scoring.json', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-scoring-repair-')))
    const [tender] = await workspace.import([{
      name: 'technical-scoring.md',
      role: 'tender',
      bytes: new TextEncoder().encode('技术要求：应支持审计日志。\n\n技术评分：方案完整性满分 10 分。'),
    }])
    if (tender === undefined || tender.chunksPath === null || tender.absoluteChunkIndexPath === null) throw new Error('test corpus was not chunked')
    const chunk = (JSON.parse(await readFile(tender.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }).chunks[0]?.path
    if (chunk === undefined) throw new Error('test corpus has no chunks')
    const source = { file_id: tender.id, chunk: `${tender.chunksPath}/${chunk}`, line_start: 1, line_end: 1 }
    const project = { schema_version: 1, project_name: '项目', tender_name: null, purchaser: null, owner: null, project_background: ['背景'], project_objectives: ['目标'], project_scope: ['范围'], technical_scope: ['技术'], delivery_scope: ['交付'], implementation_constraints: ['约束'], key_technical_points: ['评分'], source_refs: [source], analyzed_tender_files: [tender.id] }
    const requirements = { schema_version: 1, requirements: [{ id: 'REQ-1', category: '技术', raw_text: '技术要求：应支持审计日志。', normalized_requirement: '支持审计日志。', mandatory: true, source_refs: [source] }] }
    const scoring = { schema_version: 1, scoring_items: [{ id: 'SCORE-1', parent: null, group: '技术', title: '技术评分', raw_text: '技术评分：方案完整性满分 10 分。', criterion: '方案完整性', score: 10, score_range: null, must_answer: ['错误类型'], source_refs: [source] }] }
    const compliance = { schema_version: 1, compliance_items: [{ id: 'COMP-1', type: 'technical', raw_text: '技术要求：应支持审计日志。', normalized_rule: '支持审计日志。', severity: 'mandatory', source_refs: [source] }] }
    const whenIdle = vi.fn(async () => {
      if (whenIdle.mock.calls.length !== 2) return
      await Promise.all([
        writeFile(join(workspace.projectRoot, 'analysis/project.json'), `${JSON.stringify(project)}\n`),
        writeFile(join(workspace.projectRoot, 'analysis/requirements.json'), `${JSON.stringify(requirements)}\n`),
        writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), `${JSON.stringify(scoring)}\n`),
        writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), `${JSON.stringify(compliance)}\n`),
      ])
    })
    let policy: (exec: { name: string; arguments?: unknown }) => string | undefined = () => undefined
    const agent = {
      id: 'session',
      ctx: {
        get: (name: 'tools' | 'fs') => name === 'tools'
          ? { restrict: vi.fn(() => vi.fn()), guard: vi.fn((next: typeof policy) => { policy = next; return vi.fn() }) }
          : { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
        emit: vi.fn(),
      },
      followup: vi.fn(),
      whenIdle,
    } as unknown as Agent

    await executeTenderAnalysis(agent, workspace, buildBidStageTask('tender_analysis'), { maxRepairAttempts: 1 })

    expect(agent.followup).toHaveBeenCalledTimes(2)
    expect(policy({ name: 'write', arguments: { file_path: join(workspace.projectRoot, 'analysis/scoring.json') } })).toBeUndefined()
    expect(policy({ name: 'write', arguments: { file_path: join(workspace.projectRoot, 'analysis/requirements.json') } })).toContain('may write only its current Artifact paths')
  })

  it('renders only browser-safe issue fields in the repair assignment', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-repair-task-')))
    const text = renderTenderAnalysisRepairTask(
      { id: 'session' } as Agent,
      workspace,
      buildBidStageTask('tender_analysis'),
      [{
        code: 'TENDER_ANALYSIS_SCHEMA_INVALID',
        artifact: 'analysis/scoring.json',
        path: 'scoring_items[2].criterion',
        message: '至少需要一项技术响应重点。',
      }],
    )
    expect(text).toContain('scoring_items[2].criterion')
    expect(text).toContain('不得创建 final、fixed、new 或 v2 文件')
    expect(text).toContain('must_answer 必须为 true 或 false')
    expect(text).toContain('analysis/scoring.json')
    expect(text).not.toContain(`${workspace.projectRoot.replaceAll('\\', '/')}/analysis/project.json`)
  })

  it('renders dynamic paths without embedding document bodies', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-task-')))
    const agent = { id: 'session' } as Agent
    const text = renderTenderAnalysisTask(agent, workspace, buildBidStageTask('tender_analysis'))
    expect(text).toContain('chunks/index.json')
    expect(text).not.toContain('必须按期交付，技术方案得 10 分')
  })
})
