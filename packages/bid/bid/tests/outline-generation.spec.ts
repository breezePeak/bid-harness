import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolGuard, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ensureTechnicalDeviationSection, normalizeOutlineCandidate } from '../src/outline-generation-normalization.ts'
import { applyOutlineRepair } from '../src/outline-generation-repair.ts'
import { missingOutlineResponsePoints } from '../src/outline-shared-validator.ts'
import { outlineArtifactSha256 } from '../src/outline-confirmation-artifacts.ts'
import { buildWritableSectionWorklist, sectionVisibleRequirements } from '../src/section-evidence-context.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BidWorkspace,
  buildBidStageTask,
  executeOutlineGeneration as executeOutlineGenerationImplementation,
  parseOutlineQualityReport,
  parseTenderScoringArtifact,
  parseTenderRequirementsArtifact,
  parseScoringResponsePointCatalog,
  renderOutlineGenerationTask,
  scoringArtifactSha256,
  validateConfirmedOutline,
  validateOutlineGenerationQuality,
  validateOutlineGeneration,
  type OutlineArtifact,
  type OutlineQualityIssue,
  type StageArtifact,
  type StageValidationIssue,
} from '@deepseek-ai/dsh-bid'
import type { BidRunProgressInput } from '../src/control-plane-contract.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'

const executeOutlineGeneration = (
  agent: Agent,
  workspace: BidWorkspace,
  task: ReturnType<typeof buildBidStageTask>,
  options: Record<string, unknown> = {},
) => {
  const { signal, run, ...stageOptions } = options
  return executeOutlineGenerationImplementation(agent, workspace, task, {
    maxRepairAttempts: 3,
    ...stageOptions,
    run: run ?? createTestBidRunContext(signal instanceof AbortSignal ? { signal } : {}),
  } as Parameters<typeof executeOutlineGenerationImplementation>[3])
}

const artifacts: StageArtifact[] = [
  { stage: 'outline_generation', type: 'scoring_response_points', path: 'analysis/scoring-response-points.json' },
  { stage: 'outline_generation', type: 'outline', path: 'outline/outline.json' },
  { stage: 'outline_generation', type: 'outline_quality_report', path: 'outline/quality-report.json' },
]
const source = { file_id: 'tender', chunk: 'corpus/tender/chunks/0001.md', line_start: 1, line_end: 1 }

function subagentPrompt(request: Record<string, unknown>): string {
  const prompt = request.prompt
  if (!Array.isArray(prompt)) throw new Error('subagent request has no prompt')
  const first = prompt[0]
  if (typeof first !== 'object' || first === null || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('subagent prompt has no text')
  }
  return first.text
}

const requirements = {
  schema_version: 1,
  requirements: [
    { id: 'REQ-ORG', category: 'implementation', raw_text: '建立项目组织。', normalized_requirement: '建立项目组织。', mandatory: true, source_refs: [source] },
    { id: 'REQ-SCHEDULE', category: 'implementation', raw_text: '制定实施进度。', normalized_requirement: '制定实施进度。', mandatory: true, source_refs: [source] },
  ],
}

const scoring = {
  schema_version: 1,
  scoring_items: [{
    id: 'SCORE-SCHEDULE', parent: null, group: '技术', title: '实施进度', raw_text: '实施进度合理得分。',
    criterion: '实施阶段和进度安排合理。', score: 10, score_range: null, must_answer: true,
    source_refs: [source],
  }],
}
const scoringArtifact = parseTenderScoringArtifact(scoring)

const compliance = {
  schema_version: 1,
  compliance_items: [{
    id: 'COMP-DELIVERY', type: 'mandatory_response', raw_text: '必须按期交付。', normalized_rule: '按期交付。', severity: 'mandatory', source_refs: [source],
  }],
}

const reviewedOutline: OutlineArtifact = {
  schema_version: 3,
  scope: 'technical_bid',
  document_title: '技术投标文件',
  global_compliance_ids: ['COMP-DELIVERY'],
  sections: [
    {
      id: 'SEC-IMPLEMENTATION',
      parent_id: null,
      order: 1,
      level: 1,
      title: '项目实施方案',
      purpose: '组织实施专题。',
      writable: false,
      must_answer: [],
      requirement_ids: [],
      scoring_ids: [],
      compliance_ids: [],
      origin: 'generated', scoring_response_point_ids: [], scoring_response_points: [],
      suggested_tables: [],
      suggested_figures: [],
      writing_notes: [],
    },
    {
      id: 'SEC-ORGANIZATION', parent_id: 'SEC-IMPLEMENTATION', order: 1, level: 2, title: '项目组织与职责', purpose: '说明组织安排。', writable: true,
      must_answer: ['明确项目组织、岗位职责和协同机制。'], requirement_ids: ['REQ-ORG'], scoring_ids: [], compliance_ids: [], origin: 'generated', scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
    },
    {
      id: 'SEC-SCHEDULE', parent_id: 'SEC-IMPLEMENTATION', order: 2, level: 2, title: '实施阶段与进度控制', purpose: '说明阶段安排。', writable: true,
      must_answer: ['列明实施阶段、里程碑和进度保障措施。'], requirement_ids: ['REQ-SCHEDULE'], scoring_ids: ['SCORE-SCHEDULE'], compliance_ids: [], origin: 'generated', scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'SCORE-SCHEDULE', response_point: '说明实施阶段和进度保障' }], suggested_tables: [], suggested_figures: [], writing_notes: [],
    },
  ],
}

const coarseOutline: OutlineArtifact = {
  schema_version: 3,
  scope: 'technical_bid',
  document_title: '技术投标文件',
  global_compliance_ids: ['COMP-DELIVERY'],
  sections: [{
    id: 'SEC-IMPLEMENTATION', parent_id: null, order: 1, level: 1, title: '项目实施方案', purpose: '响应项目实施要求。', writable: true,
    must_answer: ['完整响应项目技术要求。'], requirement_ids: ['REQ-ORG', 'REQ-SCHEDULE'], scoring_ids: ['SCORE-SCHEDULE'], compliance_ids: [], origin: 'generated', scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'SCORE-SCHEDULE', response_point: '说明实施阶段和进度保障' }], suggested_tables: [], suggested_figures: [], writing_notes: [],
  }],
}

const researchDrivenOutline: OutlineArtifact = {
  schema_version: 3,
  scope: 'technical_bid',
  document_title: '技术投标文件',
  global_compliance_ids: ['COMP-DELIVERY'],
  sections: [{
    id: 'SEC-SECURITY', parent_id: null, order: 1, level: 1, title: '数据安全保障体系', purpose: '响应安全技术要求。', writable: true,
    must_answer: ['说明数据分类分级、访问控制和安全审计措施。'], requirement_ids: ['REQ-ORG', 'REQ-SCHEDULE'], scoring_ids: ['SCORE-SCHEDULE'], compliance_ids: [], origin: 'generated', scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'SCORE-SCHEDULE', response_point: '说明实施阶段和进度保障' }], suggested_tables: [], suggested_figures: [], writing_notes: [],
  }],
}

async function fixture(): Promise<BidWorkspace> {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-outline-generation-')))
  await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.projectRoot, 'analysis/project.json'), JSON.stringify({
      schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null,
      project_background: ['建设背景'], project_objectives: ['建设目标'], project_scope: ['技术方案'],
      technical_scope: ['项目实施'], delivery_scope: ['按期交付'], implementation_constraints: [],
      key_technical_points: ['实施进度'], source_refs: [source], analyzed_tender_files: ['tender'],
    })),
    writeFile(join(workspace.projectRoot, 'analysis/requirements.json'), JSON.stringify(requirements)),
    writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), JSON.stringify(scoring)),
    writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), JSON.stringify(compliance)),
    writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), JSON.stringify({ schema_version: 1, scope: 'technical_bid', scoring_sha256: scoringArtifactSha256(scoringArtifact), next_sequence: 2, points: [{ id: 'RP-000001', scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] })),
    writeFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), JSON.stringify({ schema_version: 7, research_topics: [], requirement_mappings: [], scoring_mappings: [], response_point_mappings: [{ response_point_id: 'RP-000001', scoring_id: 'SCORE-SCHEDULE', response_point: '说明实施阶段和进度保障', local_materials: [], web_materials: [], missing_topics: [], writing_dimensions: ['进度控制'] }] })),
  ])
  return workspace
}

async function publishOutline(workspace: BidWorkspace, outline: OutlineArtifact, qualityIssues?: OutlineQualityIssue[]): Promise<void> {
  await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'outline/outline.json'), `${JSON.stringify(outline)}\n`)
  if (qualityIssues !== undefined) await writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), `${JSON.stringify({
    schema_version: 4,
    scope: 'technical_bid',
    checked_requirement_ids: requirements.requirements.map(item => item.id),
    checked_scoring_ids: scoring.scoring_items.map(item => item.id),
    checked_scoring_response_point_ids: ['RP-000001'],
    reviewed_section_ids: outline.sections.map(item => item.id),
    issues: qualityIssues,
  })}\n`)
}

async function publishDraft(workspace: BidWorkspace, outline: OutlineArtifact): Promise<void> {
  const hash = outlineArtifactSha256(outline)
  await writeFile(join(workspace.projectRoot, 'outline/draft.json'), `${JSON.stringify({
    schema_version: 1,
    scope: 'technical_bid',
    revision: 1,
    source_outline_sha256: hash,
    draft_outline_sha256: hash,
    outline,
  })}\n`)
}

function withTechnicalDeviation(outline: OutlineArtifact): OutlineArtifact {
  return { ...outline, sections: ensureTechnicalDeviationSection(outline.sections) }
}

function promptedOutlinePath(workspace: BidWorkspace, prompt: string): string {
  const scratch = prompt.match(/\.bid-harness\/runs\/[^/]+\/scratch\/outline-generation\/outline\/outline\.json/u)?.[0]
  if (scratch === undefined) return join(workspace.projectRoot, 'outline/outline.json')
  return join(workspace.root, scratch)
}

function modelAgent(
  workspace: BidWorkspace,
  respond: (
    prompt: string,
    submitReview: (issues?: unknown) => Promise<unknown>,
    write: (args: Record<string, unknown>) => Promise<unknown>,
    read: (args: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<undefined | 'error' | 'aborted'>,
  options: {
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
    inheritToolsFromParent?: boolean
    write?: (args: Record<string, unknown>) => Promise<unknown>
    read?: (args: Record<string, unknown>) => Promise<unknown>
    structuredOutputs?: unknown[]
  } = {},
) {
  const events: SessionEvent[] = options.sandboxMode === undefined ? [] : [{
    type: 'sandbox/mode', data: { mode: options.sandboxMode },
  } as SessionEvent]
  const definitions = new Map<string, ToolDefinition>()
  const writeTool = {
    name: 'write', description: 'write', parameters: { type: 'object' },
    output: { schema: {}, render: () => [] },
    execute: (args: unknown) => options.write?.(args as Record<string, unknown>) ?? Promise.resolve({}),
  } as ToolDefinition
  const readTool = {
    name: 'read', description: 'read', parameters: { type: 'object' },
    output: { schema: {}, render: () => [] },
    execute: (args: unknown) => options.read?.(args as Record<string, unknown>) ?? Promise.resolve({}),
  } as ToolDefinition
  let pending: string | undefined
  const followup = vi.fn((message: { content: Array<{ text: string }> }) => { pending = message.content[0]!.text })
  const guard = vi.fn((_guard: ToolGuard) => () => {})
  const register = vi.fn((definition: ToolDefinition) => {
    definitions.set(definition.name, definition)
    return () => { definitions.delete(definition.name) }
  })
  const whenIdle = vi.fn(async () => {
    if (pending === undefined) return
    const prompt = pending
    pending = undefined
    const submitReview = async (issues: unknown = []) => {
      const definition = definitions.get('submit_outline_quality_review')
      if (definition === undefined) throw new Error('quality review tool unavailable')
      return definition.execute({ issues }, { agent, signal: new AbortController().signal } as ToolRunContext)
    }
    const write = (args: Record<string, unknown>) => (definitions.get('write') ?? writeTool)
      .execute(args, { agent, signal: new AbortController().signal } as ToolRunContext)
    const read = (args: Record<string, unknown>) => (definitions.get('read') ?? readTool)
      .execute(args, { agent, signal: new AbortController().signal } as ToolRunContext)
    const reason = await respond(prompt, submitReview, write, read) ?? 'completed'
    events.push({ type: 'turn/end', data: { reason: { kind: reason, error: { message: '测试模型中断' } } } } as SessionEvent)
  })
  const parent = { id: 'parent' } as Agent
  const tools = { restrict: vi.fn(() => () => {}), guard, register,
    get: vi.fn((name: string, scope?: Agent) => {
      const visible = scope === agent && options.inheritToolsFromParent !== true
        || scope === parent && options.inheritToolsFromParent === true
      return visible ? definitions.get(name) ?? (name === 'write' ? writeTool : name === 'read' ? readTool : undefined) : undefined
    }) }
  Object.assign(parent, { ctx: { get: () => tools } })
  const defaultResponseCandidate = {
    schema_version: 1,
    points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }],
  }
  const structuredOutputs = [...(options.structuredOutputs ?? [])]
  const subagentStart = vi.fn(async (_provider: string, request: Record<string, unknown>) => {
    const result = async () => {
      if (structuredOutputs.length > 0) return { stopReason: 'completed', structured: structuredOutputs.shift() }
      if (request.label !== '初步目录生成' && request.label !== '目录质量复核') {
        return { stopReason: 'completed', structured: defaultResponseCandidate }
      }
      const prompt = (request.prompt as Array<{ text: string }>)[0]!.text
      let submitted: unknown
      const reason = await respond(prompt, async (issues: unknown = []) => {
        submitted = issues
        return { submitted: true }
      }, args => writeTool.execute(args, { agent, signal: new AbortController().signal } as ToolRunContext),
      args => readTool.execute(args, { agent, signal: new AbortController().signal } as ToolRunContext)) ?? 'completed'
      if (reason !== 'completed') return { stopReason: reason }
      if (request.label === '目录质量复核') {
        return { stopReason: 'completed', structured: submitted === undefined ? undefined : { operations: [], issues: submitted } }
      }
      const raw = await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')
      return { stopReason: 'completed', structured: JSON.parse(raw) as unknown }
    }
    return {
      id: `child-${String(subagentStart.mock.calls.length)}`,
      result: result(),
      dispose: vi.fn(async () => {}),
      request,
    }
  })
  const services = {
    tools,
    agents: { get: vi.fn((id: string) => id === 'parent' ? parent : undefined) },
    subagents: { getProvider: vi.fn(() => ({ inheritsParentContext: false })), start: subagentStart },
  }
  const agent = { id: 'session', session: { events, header: { cwd: workspace.root,
    ...(options.inheritToolsFromParent === true ? { origin: 'subagent' as const, parentSession: 'parent' } : {}) } },
  ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn(), on: vi.fn(() => vi.fn()) },
  inbox: { append: vi.fn(), prepend: vi.fn(), nextStep: [], nextTurn: [] }, followup, whenIdle } as unknown as Agent
  return { agent, followup, whenIdle, guard, register, subagentStart }
}

function failureCodes(result: Awaited<ReturnType<typeof validateOutlineGeneration>>): string[] {
  return result.ok ? [] : result.issues.map(issue => issue.code)
}

describe('S3 候选错误分流', () => {
  const defects = ['rp', 'scoring', 'required', 'json'] as const
  function broken(kind: typeof defects[number]): string {
    const outline = structuredClone(reviewedOutline)
    if (kind === 'rp') outline.sections[2]!.scoring_response_point_ids = ['RP-999999']
    if (kind === 'scoring') outline.sections[2]!.scoring_ids = ['SCORE-UNKNOWN']
    if (kind === 'required') delete (outline.sections[2] as Partial<OutlineArtifact['sections'][number]>).purpose
    const raw = JSON.stringify(outline)
    return kind === 'json' ? raw.slice(0, -1) + ',}' : raw
  }
  function fieldOperations(kind: typeof defects[number]) {
    const field = kind === 'rp' ? 'scoring_response_point_ids' : kind === 'scoring' ? 'scoring_ids' : 'purpose'
    return [{ section_index: 2, field, value: reviewedOutline.sections[2]![field] }]
  }

  it.each(defects)('初稿中的 %s 错误只进入一次候选修复并完整复核', async (kind) => {
    const workspace = await fixture()
    await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'outline/outline.json'), broken(kind))
    const formal = await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')
    let reviews = 0
    let repairs = 0
    const { agent, guard } = modelAgent(workspace, async (prompt, submitReview) => {
      if (prompt.includes('候选字段修复') || prompt.includes('JSON 格式修复')) {
        repairs++
        expect(prompt).toContain('outline/outline.json')
        expect(prompt).toContain(kind === 'json' ? '禁止调整章节' : '权威输入')
        if (kind === 'rp' || kind === 'scoring' || kind === 'required') {
          expect(prompt).toContain('SEC-SCHEDULE')
          expect(prompt).toContain('$.sections[2]')
          expect(prompt).toContain(scoring.scoring_items[0]!.raw_text)
        }
        for (const file of ['analysis/scoring-response-points.json', 'analysis/requirements.json', 'outline/outline.json']) {
          expect(guard.mock.calls[0]![0]({ name: 'write', arguments: { file_path: join(workspace.projectRoot, file) } } as ToolExecution)).toContain('只读')
        }
        await writeFile(join(workspace.projectRoot, kind === 'json' ? 'outline/format-repair.json' : 'outline/candidate-repair.json'),
          JSON.stringify(kind === 'json' ? reviewedOutline : fieldOperations(kind)))
      } else if (prompt.includes('Blueprint Quality Review\n')) {
        const scratch = promptedOutlinePath(workspace, prompt)
        await expect(readFile(scratch, 'utf8')).resolves.toContain('SEC-SCHEDULE')
        reviews++
        await submitReview()
      }
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))
    expect(repairs).toBe(1)
    expect(reviews).toBe(1)
    expect(await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')).toBe(formal)
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(withTechnicalDeviation(reviewedOutline))
    if (kind === 'json') expect(await readFile(join(workspace.projectRoot, 'outline/format-repair-source.txt'), 'utf8')).toBe(broken(kind))
    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })
  })

  it.each(['rp', 'scoring'] as const)('未知 %s 修复失败后重试再次调用受限修复，正式清单不变', async (kind) => {
    const workspace = await fixture()
    await publishOutline(workspace, reviewedOutline)
    await writeFile(join(workspace.projectRoot, 'outline/outline.json'), broken(kind))
    const formal = await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')
    const failed = modelAgent(workspace, async () => {
      await writeFile(join(workspace.projectRoot, 'outline/candidate-repair.json'), JSON.stringify([{ ...fieldOperations(kind)[0], value: [] }]))
    })
    await expect(executeOutlineGeneration(failed.agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 1 })).rejects.toThrow('不能通过清空')
    expect(failed.followup).toHaveBeenCalledTimes(1)
    expect(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')).toBe(broken(kind))
    await expect(readFile(join(workspace.projectRoot, 'outline/quality-report.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const retry = modelAgent(workspace, async (prompt, submitReview) => {
      if (prompt.includes('候选字段修复')) await writeFile(join(workspace.projectRoot, 'outline/candidate-repair.json'), JSON.stringify(fieldOperations(kind)))
      else await submitReview()
    })
    await executeOutlineGeneration(retry.agent, workspace, buildBidStageTask('outline_generation'))
    expect(retry.followup).toHaveBeenCalledTimes(1)
    expect(await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')).toBe(formal)
  })

  it('格式修复不能改写目录内容；格式失败和取消保留原始文本', async () => {
    const workspace = await fixture()
    await publishOutline(workspace, reviewedOutline)
    const raw = broken('json')
    await writeFile(join(workspace.projectRoot, 'outline/outline.json'), raw)
    const failed = modelAgent(workspace, async () => {
      await writeFile(join(workspace.projectRoot, 'outline/format-repair.json'), JSON.stringify(coarseOutline))
    })
    await expect(executeOutlineGeneration(failed.agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 2 })).rejects.toThrow('格式修复改变了内容')
    expect(failed.followup).toHaveBeenCalledTimes(1)
    expect(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')).toBe(raw)
    const controller = new AbortController()
    const cancelled = modelAgent(workspace, async () => {
      await writeFile(join(workspace.projectRoot, 'outline/format-repair.json'), JSON.stringify(reviewedOutline))
      controller.abort(new Error('取消格式修复'))
    })
    await expect(executeOutlineGeneration(cancelled.agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 2, signal: controller.signal })).rejects.toThrow('取消格式修复')
    expect(cancelled.followup).toHaveBeenCalledTimes(1)
    expect(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')).toBe(raw)
  })

  it('候选修复越过报错字段时整批拒绝，不修改其他章节', async () => {
    const workspace = await fixture()
    await publishOutline(workspace, reviewedOutline)
    await writeFile(join(workspace.projectRoot, 'outline/outline.json'), broken('rp'))
    const { agent } = modelAgent(workspace, async () => {
      await writeFile(join(workspace.projectRoot, 'outline/candidate-repair.json'), JSON.stringify([
        ...fieldOperations('rp'), { section_index: 1, field: 'title', value: '不能重写无关章节' },
      ]))
    })
    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 1 })).rejects.toThrow('超出已定位字段范围')
    expect(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')).toBe(broken('rp'))
  })

  it.each(['requirements', 'scoring', 'compliance', 'scoring-response-points'])('损坏正式 %s 输入不交给模型修复', async (input) => {
    const workspace = await fixture()
    await publishOutline(workspace, reviewedOutline)
    await writeFile(join(workspace.projectRoot, `analysis/${input}.json`), '{')
    const { agent, followup } = modelAgent(workspace, async () => {})
    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))).rejects.toThrow()
    expect(followup).not.toHaveBeenCalled()
    expect(await readFile(join(workspace.projectRoot, `analysis/${input}.json`), 'utf8')).toBe('{')
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(reviewedOutline)
  })
})

describe('S3 需求、合规、框架与结构局部修复', () => {
  it('新增与拆分章节可明确分配需求、合规、框架和评分，不扩大浏览器操作权限', async () => {
    const workspace = await fixture()
    const catalog = parseScoringResponsePointCatalog(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')))
    const references = { requirement_ids: ['REQ-ORG'], scoring_ids: ['SCORE-SCHEDULE'], compliance_ids: ['COMP-DELIVERY'], framework_refs: [{ file_id: 'FRAMEWORK', heading_path: ['组织'] }], origin: 'mixed' }
    const added = applyOutlineRepair(reviewedOutline, [{ type: 'add_section', parent_id: 'SEC-IMPLEMENTATION', order: 3,
      title: '质量核验', purpose: '说明交付核验', writable: true, must_answer: ['列出核验程序'], ...references }], catalog, scoringArtifact)
    expect(added.sections[3]).toMatchObject(references)
    expect(added.sections.slice(0, 3)).toEqual(reviewedOutline.sections)
    const split = applyOutlineRepair(reviewedOutline, [{ type: 'split_section', section_id: 'SEC-SCHEDULE', children: [
      { title: '组织分工', purpose: '说明组织', must_answer: ['说明分工'], ...references, scoring_response_point_ids: [] },
      { title: '阶段计划', purpose: '说明进度', must_answer: ['列出里程碑'], requirement_ids: ['REQ-SCHEDULE'], compliance_ids: ['COMP-DELIVERY'], scoring_response_point_ids: ['RP-000001'] },
    ] }], catalog, scoringArtifact)
    expect(split.sections[3]).toMatchObject(references)
    expect(split.sections[4]).toMatchObject({ requirement_ids: ['REQ-SCHEDULE'], compliance_ids: ['COMP-DELIVERY'], scoring_response_points: reviewedOutline.sections[2]!.scoring_response_points })
    const { parseOutlineEditOperations } = await import('../src/outline-confirmation-edits.ts')
    expect(() => parseOutlineEditOperations([{ type: 'update_section', section_id: 'SEC-SCHEDULE', purpose: '说明进度', ...references }])).toThrow()
  })

  it.each(['requirement', 'section_compliance', 'global_compliance', 'framework', 'structure'] as const)('%s 问题使用具备对应字段能力的局部操作', async (kind) => {
    const workspace = await fixture()
    const outline = structuredClone(reviewedOutline)
    let operations: unknown[]
    if (kind === 'requirement') {
      outline.sections[1]!.requirement_ids = []
      operations = [{ type: 'update_section', section_id: 'SEC-ORGANIZATION', requirement_ids: ['REQ-ORG'] }]
    } else if (kind === 'section_compliance' || kind === 'global_compliance') {
      outline.global_compliance_ids = []
      operations = kind === 'section_compliance'
        ? [{ type: 'update_section', section_id: 'SEC-SCHEDULE', compliance_ids: ['COMP-DELIVERY'] }]
        : [{ type: 'update_global_compliance', global_compliance_ids: ['COMP-DELIVERY'] }]
    } else if (kind === 'framework') {
      const [framework] = await workspace.import([{ name: 'framework.md', role: 'outline_framework', bytes: new TextEncoder().encode('# 实施计划\n') }])
      outline.sections[2]!.origin = 'mixed'
      outline.sections[2]!.framework_refs = [{ file_id: String(framework!.id), heading_path: ['错误标题'] }]
      operations = [{ type: 'update_section', section_id: 'SEC-SCHEDULE', framework_refs: [{ file_id: String(framework!.id), heading_path: ['实施计划'] }] }]
    } else {
      outline.sections[2]!.parent_id = 'MISSING'
      operations = [{ type: 'move_section', section_id: 'SEC-SCHEDULE', parent_id: 'SEC-IMPLEMENTATION', order: 2 }]
    }
    await publishOutline(workspace, outline)
    const { agent, followup } = modelAgent(workspace, async (prompt, submitReview) => {
      if (prompt.includes('局部关联与结构修复')) {
        for (const text of [requirements.requirements[0]!.raw_text, scoring.scoring_items[0]!.raw_text, compliance.compliance_items[0]!.raw_text, 'framework_refs']) expect(prompt).toContain(text)
        await writeFile(join(workspace.projectRoot, 'outline/repair-operations.json'), JSON.stringify(operations))
      } else {
        expect(prompt).toContain('Blueprint Quality Review')
        await submitReview()
      }
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))
    expect(followup).toHaveBeenCalledTimes(1)
    const repaired = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')) as OutlineArtifact
    expect(repaired.sections[0]?.id).toBe('dsh-technical-deviation-table')
    expect(repaired.sections.find(section => section.id === 'SEC-IMPLEMENTATION')).toEqual({ ...outline.sections[0], order: 2 })
    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })
  })

  it('混合遗漏只提交一次修复，非法新引用整批拒绝', async () => {
    const workspace = await fixture()
    const outline = structuredClone(reviewedOutline)
    outline.sections[1]!.requirement_ids = []
    outline.global_compliance_ids = []
    outline.sections[2]!.scoring_response_point_ids = []
    outline.sections[2]!.scoring_response_points = []
    await publishOutline(workspace, outline)
    const { agent, followup } = modelAgent(workspace, async (prompt) => {
      expect(prompt).toContain('局部关联与结构修复')
      await writeFile(join(workspace.projectRoot, 'outline/repair-operations.json'), JSON.stringify([
        { type: 'update_section', section_id: 'SEC-ORGANIZATION', requirement_ids: ['REQ-ORG'], compliance_ids: ['COMP-UNKNOWN'] },
      ]))
    })
    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation')))
      .rejects.toThrow('局部操作引入非法引用或结构')
    expect(followup).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(withTechnicalDeviation(outline))
  })
})

describe('outline-generation Blueprint Quality Review', () => {
  it('S3 响应点 Child 只返回结构化候选，由 Host 写入 Candidate', async () => {
    const workspace = await fixture()
    await rm(join(workspace.projectRoot, 'analysis/scoring-response-points.json'))
    const responseCandidate = {
      schema_version: 1,
      points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }],
    }
    const read = vi.fn(async () => ({}))
    const write = vi.fn(async () => ({}))
    const run = createTestBidRunContext()
    const { agent, subagentStart } = modelAgent(workspace, async () => {}, {
      read,
      write,
      structuredOutputs: [responseCandidate, responseCandidate, researchDrivenOutline, { operations: [], issues: [] }],
    })

    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), { run, recovery: {
      workId: run.work.workId, unit: 'analysis/scoring-response-points.candidate.json',
      instruction: '补齐遗漏的评分响应点。', issues: [{ code: 'OUTLINE_RESPONSE_POINT_CANDIDATE_INVALID',
        artifact: 'analysis/scoring-response-points.candidate.json', message: '遗漏评分项' }],
    } })).resolves.toEqual(artifacts)
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(subagentStart).toHaveBeenCalledTimes(4)
    expect(subagentPrompt(subagentStart.mock.calls[0]![1])).toContain('补齐遗漏的评分响应点。')
    expect(subagentPrompt(subagentStart.mock.calls[1]![1])).toContain('补齐遗漏的评分响应点。')
    expect(subagentPrompt(subagentStart.mock.calls[2]![1])).not.toContain('补齐遗漏的评分响应点。')
    for (const [, request] of subagentStart.mock.calls) expect(request).toMatchObject({ toolFilter: { allow: [] } })
    await expect(readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.candidate.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace.projectRoot, 'runs', run.runId, 'scratch', 'outline-generation', 'analysis/scoring-response-points.candidate.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8'))).toMatchObject({
      points: [{ id: 'RP-000001', ...responseCandidate.points[0] }],
    })
  })

  it.each([
    ['非法 scoring_id', { schema_version: 1, points: [{ scoring_id: '001', order: 1, text: '实施进度' }] }],
    ['order 不连续', { schema_version: 1, points: [
      { scoring_id: 'SCORE-SCHEDULE', order: 1, text: '实施进度' },
      { scoring_id: 'SCORE-SCHEDULE', order: 3, text: '进度保障' },
    ] }],
    ['text 为空', { schema_version: 1, points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '   ' }] }],
  ])('%s 时 Host 拒绝且不写 Candidate', async (_name, structured) => {
    const workspace = await fixture()
    await rm(join(workspace.projectRoot, 'analysis/scoring-response-points.json'))
    const run = createTestBidRunContext()
    const { agent } = modelAgent(workspace, async () => {}, { structuredOutputs: [structured] })

    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), { run }))
      .rejects.toThrow('OUTLINE_RESPONSE_POINT_CANDIDATE_INVALID')
    await expect(readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.candidate.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('遗漏评分项时 Host 拒绝 Candidate', async () => {
    const workspace = await fixture()
    await rm(join(workspace.projectRoot, 'analysis/scoring-response-points.json'))
    await writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), JSON.stringify({
      ...scoring,
      scoring_items: [
        ...scoring.scoring_items,
        { ...scoring.scoring_items[0]!, id: 'SCORE-SECOND', title: '第二项评分' },
      ],
    }))
    const candidate = { schema_version: 1, points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '实施进度' }] }
    const { agent } = modelAgent(workspace, async () => {}, { structuredOutputs: [candidate] })

    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation')))
      .rejects.toThrow('scoring-response-point-candidate-order-invalid')
  })

  it('语义复核返回非法结构时不覆盖已有合法 Candidate', async () => {
    const workspace = await fixture()
    await rm(join(workspace.projectRoot, 'analysis/scoring-response-points.json'))
    const candidatePath = join(workspace.projectRoot, 'analysis/scoring-response-points.candidate.json')
    const existing = { schema_version: 1, points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '已有合法响应点' }] }
    await writeFile(candidatePath, JSON.stringify(existing))
    const invalid = { schema_version: 1, points: [{ scoring_id: '001', order: 1, text: '错误响应点' }] }
    const { agent } = modelAgent(workspace, async () => {}, { structuredOutputs: [invalid] })

    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation')))
      .rejects.toThrow('OUTLINE_RESPONSE_POINT_CANDIDATE_INVALID')
    expect(JSON.parse(await readFile(candidatePath, 'utf8'))).toEqual(existing)
  })

  it('模型只返回建议内容，程序填写正式报告的问题类别', async () => {
    const workspace = await fixture()
    const issue = {
      severity: 'advisory',
      message: '实施章节边界可由用户最终确认。',
    }
    const { agent, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [reviewedOutline, { operations: [], issues: [issue] }],
    })

    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))

    const report = parseOutlineQualityReport(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/quality-report.json'), 'utf8')))
    expect(report).toMatchObject({ schema_version: 4, issues: [{ ...issue, code: 'OUTLINE_QUALITY_ADVISORY' }] })
    const request = subagentStart.mock.calls.find(call => call[1].label === '目录质量复核')![1]
    expect(JSON.stringify(request.outputSchema)).not.toContain('"code"')
    expect(JSON.stringify(request.prompt)).toContain('不要生成问题代码或编号')
    await expect(readFile(join(workspace.projectRoot, 'outline/quality-report.candidate.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['章节范围', 'MODEL_INVENTED_CODE'])('拒绝模型自行提交的问题代码 %s，并保留必要目录修改', async (code) => {
    const workspace = await fixture()
    const operation = { type: 'update_section', section_id: 'SEC-SCHEDULE', title: '实施进度与交付安排' }
    const issue = { severity: 'advisory', message: '确认交付安排。' }
    const { agent, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [reviewedOutline,
        { operations: [operation], issues: [{ ...issue, code }] },
        { operations: [operation], issues: [issue] }],
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 1 })
    const requests = subagentStart.mock.calls.filter(call => call[1].label === '目录质量复核')
    expect(requests).toHaveLength(2)
    for (const [, request] of requests) {
      expect(JSON.stringify(request.outputSchema)).not.toContain('"code"')
    }
    expect(JSON.stringify(requests[1]![1].prompt)).toContain('Unrecognized key')
    const report = parseOutlineQualityReport(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/quality-report.json'), 'utf8')))
    expect(report.issues).toEqual([{ ...issue, code: 'OUTLINE_QUALITY_ADVISORY' }])
    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })
  })

  it('目录质量复核使用独立预算，多轮无变化操作后稳定失败', async () => {
    const workspace = await fixture()
    const noOp = { operations: [{ type: 'update_section', section_id: 'SEC-SCHEDULE', title: '实施阶段与进度控制' }], issues: [] }
    const { agent, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [reviewedOutline, noOp, noOp],
    })
    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 1 }))
      .rejects.toThrow('OUTLINE_GENERATION_REVIEW_NOT_CONVERGED')
    expect(subagentStart.mock.calls.filter(call => call[1].label === '目录质量复核')).toHaveLength(2)
  })

  it('gives S3 stable response points and tender conclusions as structural inputs', async () => {
    const workspace = await fixture()
    const task = renderOutlineGenerationTask({ id: 'session', session: { events: [] } } as unknown as Agent, workspace, buildBidStageTask('outline_generation'))

    expect(task).toContain('稳定评分响应点目录设计技术标详细写作 Blueprint')
    expect(task).toContain('id、parent_id、order、level、title、purpose、writable、must_answer')
    expect(task).toContain('目录模式：无人工框架')
    expect(task).toContain('评分响应点和评分项为主要拆分依据')
    expect(task).toContain('投标资格、企业资质证书、行政递交或其他只需材料核验的 Compliance 放入 global_compliance_ids')
    expect(task).toContain('不得为复述或解释这类要求单独创建可写章节')
  })

  it('拒绝目录标题和总述中的系统内部编号', async () => {
    const workspace = await fixture()
    const outline = structuredClone(reviewedOutline)
    outline.document_title = 'REQ-ORG 技术标'
    outline.sections[0]!.summary = '我方按 SEC-SCHEDULE 组织实施。'
    await publishOutline(workspace, outline, [])

    const result = await validateOutlineGeneration(workspace, 'outline_generation', artifacts)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('系统内部编号未被拒绝')
    expect(result.issues.some(issue => issue.code === 'OUTLINE_GENERATION_INTERNAL_ID_VISIBLE'
      && issue.message.includes('REQ-ORG'))).toBe(true)
    expect(result.issues.some(issue => issue.code === 'OUTLINE_GENERATION_INTERNAL_ID_VISIBLE'
      && issue.message.includes('SEC-SCHEDULE'))).toBe(true)
  })

  it('injects successful outline-framework headings without S3 source mappings', async () => {
    const workspace = await fixture()
    await workspace.import([{
      name: 'primary-framework.md', role: 'outline_framework',
      bytes: new TextEncoder().encode('# 总体方案\n\n## 实施计划\n'),
    }, {
      name: 'supplementary-framework.md', role: 'outline_framework',
      bytes: new TextEncoder().encode('# 质量保障\n'),
    }])
    const { agent, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [reviewedOutline, { operations: [], issues: [] }],
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))
    const prompt = (subagentStart.mock.calls[0]![1] as { prompt: Array<{ text: string }> }).prompt[0]!.text
    expect(prompt).toContain('总体方案')
    expect(prompt).toContain('实施计划')
    expect(prompt).toContain('质量保障')
    expect(prompt).toContain('只有人工框架标题可以写入 framework_refs')
    expect(prompt).toContain('reference_bid 只能参考目录组织')
    expect(prompt).not.toContain('mapping_id')
  })

  it('只向目录 Child 注入 reference_bid 标题结构，并禁止其产生 framework_refs', async () => {
    const workspace = await fixture()
    await workspace.import([{
      name: '旧项目技术标.md', role: 'reference_bid',
      bytes: new TextEncoder().encode('# 旧项目总体方案\n\n旧项目正文不得注入。\n\n## 服务保障\n'),
    }])
    const { agent, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [reviewedOutline, { operations: [], issues: [] }],
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))
    const initial = subagentStart.mock.calls.find(call => call[1].label === '初步目录生成')![1] as { prompt: Array<{ text: string }> }
    expect(initial.prompt[0]!.text).toContain('旧项目总体方案')
    expect(initial.prompt[0]!.text).toContain('服务保障')
    expect(initial.prompt[0]!.text).not.toContain('旧项目正文不得注入')
    expect(initial.prompt[0]!.text).toContain('reference_bid 只能参考目录组织')
    expect(initial.prompt[0]!.text).toContain('不得写入 framework_refs')
  })

  it('accepts exact framework heading references and rejects unknown headings', async () => {
    const workspace = await fixture()
    const [framework] = await workspace.import([{
      name: 'framework.md', role: 'outline_framework',
      bytes: new TextEncoder().encode('# 总体方案\n\n框架正文。\n'),
    }])
    if (framework === undefined) throw new Error('framework import missing')
    const referenced: OutlineArtifact = structuredClone(reviewedOutline)
    referenced.sections[1]!.framework_refs = [{ file_id: String(framework.id), heading_path: ['总体方案'] }]
    await publishOutline(workspace, referenced, [])

    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toMatchObject({ ok: true })

    referenced.sections[1]!.framework_refs = [{ file_id: String(framework.id), heading_path: ['不存在'] }]
    await publishOutline(workspace, referenced, [])
    expect(failureCodes(await validateOutlineGeneration(workspace, 'outline_generation', artifacts))).toContain('OUTLINE_FRAMEWORK_REF_INVALID')
  })

  it('首次 S3 无正式 RP 文件也能启动，生成后把准确清单交给初稿和复核', async () => {
    const workspace = await fixture()
    await rm(join(workspace.projectRoot, 'analysis/scoring-response-points.json'))
    const task = buildBidStageTask('outline_generation')
    expect(task.inputs).not.toContain('analysis/scoring-response-points.json')
    const responseCandidate = { schema_version: 1, points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] }
    const { agent, followup, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [responseCandidate, responseCandidate, researchDrivenOutline, { operations: [], issues: [] }],
    })
    const reportProgress = vi.fn<(progress: BidRunProgressInput) => void>()
    await expect(executeOutlineGeneration(agent, workspace, task, {
      run: createTestBidRunContext({ reportProgress }),
    })).resolves.toEqual(artifacts)
    expect(reportProgress.mock.calls.map(([progress]) => progress.phase))
      .toEqual(['analyzing', 'analyzing', 'generating', 'validating', 'reviewing', 'finalizing'])
    expect(followup).not.toHaveBeenCalled()
    expect(subagentStart).toHaveBeenCalledTimes(4)
    const analysisPrompt = (subagentStart.mock.calls[0]![1] as { prompt: Array<{ text: string }> }).prompt[0]!.text
    expect(analysisPrompt).toContain('本次合法 ID：["SCORE-SCHEDULE"]')
    expect(analysisPrompt).toContain('<scoring-json>')
    expect(analysisPrompt).toContain('Host 会持久化该候选')
    expect(analysisPrompt).not.toContain('"scoring_id":"SCORE-..."')
    for (const forbidden of ['scoring-response-points.candidate.json', '调用 write', 'sandbox_permissions', 'justification']) {
      expect(analysisPrompt).not.toContain(forbidden)
    }
    expect((subagentStart.mock.calls[1]![1] as { label: string }).label).toBe('评分响应点语义复核')
    for (const index of [2, 3]) {
      const prompt = (subagentStart.mock.calls[index]![1] as { prompt: Array<{ text: string }> }).prompt[0]!.text
      expect(prompt).toContain('RP-000001')
      expect(prompt).toContain('说明实施阶段和进度保障')
    }
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(withTechnicalDeviation(researchDrivenOutline))
  })

  it('质量复核修改目录后直接接受本轮版本，再由 Host 生成全部已检查清单', async () => {
    const workspace = await fixture()
    const operation = { type: 'update_section', section_id: 'SEC-IMPLEMENTATION', title: '项目实施与进度方案' }
    const { agent, followup, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [coarseOutline, { operations: [operation], issues: [{ severity: 'advisory', message: '确认实施安排。' }] }],
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 0 })
    expect(followup).not.toHaveBeenCalled()
    expect(subagentStart.mock.calls.filter(call => call[1].label === '目录质量复核')).toHaveLength(1)
    const report = parseOutlineQualityReport(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/quality-report.json'), 'utf8')))
    expect(report.reviewed_section_ids).toEqual(['dsh-technical-deviation-table', 'SEC-IMPLEMENTATION'])
    expect(report.issues).toEqual([{ code: 'OUTLINE_QUALITY_ADVISORY', severity: 'advisory', message: '确认实施安排。' }])
    const result = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')) as OutlineArtifact
    expect(result.sections.find(section => section.id === 'SEC-IMPLEMENTATION')?.title).toBe(operation.title)
    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })
  })

  it('错误 Schema 在有限字段修复失败后保留候选，不要求模型重写整本目录', async () => {
    const workspace = await fixture()
    const invalid = {
      ...reviewedOutline,
      sections: reviewedOutline.sections.map((section, index) => (
        index === 2 ? { ...section, purpose: undefined } : section
      )),
    }
    await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
    await writeFile(join(workspace.projectRoot, 'outline/outline.json'), JSON.stringify(invalid))
    const { agent, followup } = modelAgent(workspace, async (prompt) => {
      if (prompt.includes('候选字段修复')) await writeFile(join(workspace.projectRoot, 'outline/candidate-repair.json'), '[]')
    })
    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))).rejects.toThrow()
    expect(followup).toHaveBeenCalledTimes(1)
    expect(followup.mock.calls[0]![0].content[0]!.text).toContain('候选字段修复')
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(invalid)
    await expect(readFile(join(workspace.projectRoot, 'outline/quality-report.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['writable parent', (outline: OutlineArtifact) => {
      outline.sections[0] = { ...outline.sections[0]!, writable: true, must_answer: ['统筹项目实施专题。'] }
    }, 'OUTLINE_SHARED_WRITABLE_NOT_LEAF'],
    ['duplicate sibling title', (outline: OutlineArtifact) => {
      outline.sections[2] = { ...outline.sections[2]!, title: outline.sections[1]!.title }
    }, 'OUTLINE_SHARED_SECTION_TITLE_DUPLICATE'],
    ['duplicate must-answer item', (outline: OutlineArtifact) => {
      outline.sections[1] = { ...outline.sections[1]!, must_answer: ['明确项目组织、岗位职责和协同机制。', '明确项目组织、岗位职责和协同机制'] }
    }, 'OUTLINE_SHARED_SECTION_REFERENCE_DUPLICATE'],
  ])('rejects a %s', async (_name, mutate, expectedCode) => {
    const workspace = await fixture()
    const outline = structuredClone(reviewedOutline)
    mutate(outline)
    await publishOutline(workspace, outline, [])
    expect(failureCodes(await validateOutlineGeneration(workspace, 'outline_generation', artifacts))).toContain(expectedCode)
  })

  it('requires complete quality-review identity sets but permits advisory issues', async () => {
    const workspace = await fixture()
    await publishOutline(workspace, reviewedOutline, [])
    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })

    await writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), JSON.stringify({
      schema_version: 3,
      scope: 'technical_bid',
      checked_requirement_ids: requirements.requirements.map(item => item.id),
      checked_scoring_ids: scoring.scoring_items.map(item => item.id),
      checked_scoring_response_point_ids: ['RP-000001'],
      reviewed_section_ids: reviewedOutline.sections.map(item => item.id),
      issues: [],
    }))
    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })

    await writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), JSON.stringify({
      schema_version: 4,
      scope: 'technical_bid',
      checked_requirement_ids: ['REQ-ORG'],
      checked_scoring_ids: ['SCORE-SCHEDULE'],
      checked_scoring_response_point_ids: ['RP-000001'],
      reviewed_section_ids: reviewedOutline.sections.map(item => item.id),
      issues: [],
    }))
    expect(failureCodes(await validateOutlineGeneration(workspace, 'outline_generation', artifacts)))
      .toContain('OUTLINE_GENERATION_QUALITY_REQUIREMENT_MISSING')

    await publishOutline(workspace, reviewedOutline, [{
      code: 'SECTION_TOO_COARSE',
      severity: 'advisory',
      message: '实施章节仍然过粗。',
    }])
    await expect(validateOutlineGeneration(workspace, 'outline_generation', artifacts)).resolves.toEqual({ ok: true })

    await writeFile(join(workspace.projectRoot, 'outline/quality-report.json'), '')
    expect(failureCodes(await validateOutlineGeneration(workspace, 'outline_generation', artifacts)))
      .toContain('OUTLINE_GENERATION_INPUT_INVALID')
  })

  it('applies the writable-leaf rule to S5 candidates', () => {
    const outline = structuredClone(reviewedOutline)
    outline.sections[0] = { ...outline.sections[0]!, writable: true, must_answer: ['统筹项目实施专题。'] }
    const result = validateConfirmedOutline(outline, requirements, scoring, compliance, { schema_version: 1, scope: 'technical_bid', scoring_sha256: scoringArtifactSha256(scoringArtifact), next_sequence: 2, points: [{ id: 'RP-000001', scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('S5 candidate unexpectedly passed')
    expect(result.issues.map(issue => issue.code)).toContain('OUTLINE_SHARED_WRITABLE_NOT_LEAF')
  })

  it('does not impose fixed requirement or scoring counts on a writable section', () => {
    const manyRequirements = parseTenderRequirementsArtifact({ schema_version: 1, requirements: Array.from({ length: 5 }, (_, index) => ({ ...requirements.requirements[0]!, id: `REQ-${String(index + 1)}`, raw_text: `要求${String(index + 1)}`, normalized_requirement: `要求${String(index + 1)}` })) })
    const manyScoring = parseTenderScoringArtifact({ schema_version: 1, scoring_items: Array.from({ length: 4 }, (_, index) => ({ ...scoring.scoring_items[0]!, id: `SCORE-${String(index + 1)}`, title: `评分${String(index + 1)}` })) })
    const manyCatalog = parseScoringResponsePointCatalog({ schema_version: 1, scope: 'technical_bid', scoring_sha256: scoringArtifactSha256(manyScoring), next_sequence: 5, points: manyScoring.scoring_items.map((item, index) => ({ id: `RP-${String(index + 1).padStart(6, '0')}`, scoring_id: item.id, order: 1, text: `响应点${String(index + 1)}` })) })
    const outline: OutlineArtifact = { schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: [], sections: [{ id: 'SEC-1', parent_id: null, order: 1, level: 1, title: '综合实施方案', purpose: '完整响应。', writable: true, must_answer: ['分别说明五项要求和四项评分响应。'], requirement_ids: manyRequirements.requirements.map(item => item.id), scoring_ids: manyScoring.scoring_items.map(item => item.id), compliance_ids: [], origin: 'generated', scoring_response_point_ids: manyCatalog.points.map(point => point.id), scoring_response_points: manyCatalog.points.map(point => ({ scoring_id: point.scoring_id, response_point: point.text })), suggested_tables: [], suggested_figures: [], writing_notes: [] }] }
    const qualityIssues: StageValidationIssue[] = []
    validateOutlineGenerationQuality(outline, { schema_version: 4, scope: 'technical_bid', checked_requirement_ids: outline.sections[0]!.requirement_ids, checked_scoring_ids: outline.sections[0]!.scoring_ids, checked_scoring_response_point_ids: manyCatalog.points.map(point => point.id), reviewed_section_ids: ['SEC-1'], issues: [] }, manyRequirements, manyScoring, manyCatalog, qualityIssues)
    expect(qualityIssues).toEqual([])
    const s5 = validateConfirmedOutline(
      outline,
      manyRequirements,
      manyScoring,
      { schema_version: 1, compliance_items: [] },
      manyCatalog,
    )
    expect(s5).toEqual({ ok: true })
  })

  it('keeps structural rules in the model-visible draft assignment', async () => {
    const workspace = await fixture()
    const task = renderOutlineGenerationTask({ id: 'session', session: { events: [] } } as unknown as Agent, workspace, buildBidStageTask('outline_generation'))
    expect(task).toContain('索引重复引用不能替代正文拆分')
  })

  it('allows one response point to be covered by multiple writable sections', () => {
    const catalog = parseScoringResponsePointCatalog({ schema_version: 1, scope: 'technical_bid', scoring_sha256: scoringArtifactSha256(scoringArtifact), next_sequence: 2, points: [{ id: 'RP-000001', scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] })
    const outline: OutlineArtifact = {
      schema_version: 3, scope: 'technical_bid', document_title: '技术标', global_compliance_ids: ['COMP-DELIVERY'],
      sections: ['实施进度计划', '进度保障机制'].map((title, index) => ({
        id: `SEC-${String(index + 1)}`, parent_id: null, order: index + 1, level: 1, title,
        purpose: '共同响应进度评分点。', writable: true, must_answer: [title],
        requirement_ids: requirements.requirements.map(item => item.id), scoring_ids: ['SCORE-SCHEDULE'], compliance_ids: [],
        origin: 'generated', framework_refs: [], scoring_response_point_ids: ['RP-000001'],
        scoring_response_points: [{ scoring_id: 'SCORE-SCHEDULE', response_point: '说明实施阶段和进度保障' }],
        suggested_tables: [], suggested_figures: [], writing_notes: [],
      })),
    }
    expect(validateConfirmedOutline(outline, requirements, scoring, compliance, catalog)).toEqual({ ok: true })
  })
})

describe('S3 canonical 检查点恢复', () => {
  it('RP 第一轮完成后中断会保留 Candidate，恢复只执行语义复核', async () => {
    const workspace = await fixture()
    await rm(join(workspace.projectRoot, 'analysis/scoring-response-points.json'))
    const candidate = { schema_version: 1, points: [{ scoring_id: 'SCORE-SCHEDULE', order: 1, text: '说明实施阶段和进度保障' }] }
    const invalid = modelAgent(workspace, async () => {}, {
      structuredOutputs: [candidate, { schema_version: 1, points: [{ scoring_id: 'UNKNOWN', order: 1, text: '错误' }] }],
    })
    const reportProgress = vi.fn<(progress: BidRunProgressInput) => void>()
    await expect(executeOutlineGeneration(invalid.agent, workspace, buildBidStageTask('outline_generation'), {
      run: createTestBidRunContext({ reportProgress }),
    }))
      .rejects.toThrow('OUTLINE_RESPONSE_POINT_CANDIDATE_INVALID')
    expect(reportProgress.mock.calls.map(([progress]) => progress.phase)).toEqual(['analyzing', 'analyzing'])
    expect(invalid.subagentStart.mock.calls.map(call => call[1].label)).toEqual(['评分响应点分析', '评分响应点语义复核'])
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.candidate.json'), 'utf8'))).toEqual(candidate)
    await expect(readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const valid = modelAgent(workspace, async () => {}, {
      structuredOutputs: [candidate, reviewedOutline, { operations: [], issues: [] }],
    })
    reportProgress.mockClear()
    await executeOutlineGeneration(valid.agent, workspace, buildBidStageTask('outline_generation'), {
      run: createTestBidRunContext({ reportProgress, resumeOf: { runId: 'rp-interrupted', cause: 'host_restart' } }),
    })
    expect(reportProgress.mock.calls.map(([progress]) => progress.phase))
      .toEqual(['analyzing', 'analyzing', 'generating', 'validating', 'reviewing', 'finalizing'])
    expect(valid.subagentStart.mock.calls.map(call => call[1].label)).toEqual(['评分响应点语义复核', '初步目录生成', '目录质量复核'])
    await expect(readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.candidate.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    await rm(join(workspace.projectRoot, 'outline/outline.json'))
    await rm(join(workspace.projectRoot, 'outline/quality-report.json'))
    await rm(join(workspace.projectRoot, 'outline/draft.json'))
    const resumed = modelAgent(workspace, async () => {}, { structuredOutputs: [reviewedOutline, { operations: [], issues: [] }] })
    await executeOutlineGeneration(resumed.agent, workspace, buildBidStageTask('outline_generation'))
    expect(resumed.subagentStart.mock.calls.map(call => call[1].label)).toEqual(['初步目录生成', '目录质量复核'])
  })

  it('忽略旧 Run scratch，并在没有 canonical outline 时重新生成目录', async () => {
    const workspace = await fixture()
    const oldScratch = join(workspace.projectRoot, 'runs', 'old-run', 'scratch', 'outline-generation', 'outline')
    await mkdir(oldScratch, { recursive: true })
    await writeFile(join(oldScratch, 'outline.json'), JSON.stringify(coarseOutline))
    const { agent, followup, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [reviewedOutline, { operations: [], issues: [] }],
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), {
      run: createTestBidRunContext({ resumeOf: { runId: 'old-run', cause: 'host_restart' } }),
    })
    expect(followup).not.toHaveBeenCalled()
    expect(subagentStart.mock.calls.map(call => call[1].label)).toEqual(['初步目录生成', '目录质量复核'])
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(withTechnicalDeviation(reviewedOutline))
  })

  it('canonical outline 已发布时跳过整本生成，只执行一次质量复核', async () => {
    const workspace = await fixture()
    await publishOutline(workspace, reviewedOutline)
    const { agent, followup, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [{ operations: [], issues: [] }],
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), {
      run: createTestBidRunContext({ resumeOf: { runId: 'outline-published', cause: 'host_restart' } }),
    })
    expect(subagentStart.mock.calls.map(call => call[1].label)).toEqual(['目录质量复核'])
    expect(followup).not.toHaveBeenCalled()
  })

  it('Repair 未正式应用时恢复仍有唯一一次机会', async () => {
    const workspace = await fixture()
    await catalogWithMissing(workspace)
    await publishOutline(workspace, reviewedOutline)
    const interrupted = modelAgent(workspace, async () => 'error')
    await expect(executeOutlineGeneration(interrupted.agent, workspace, buildBidStageTask('outline_generation')))
      .rejects.toThrow('未正常完成')
    await expect(readFile(join(workspace.projectRoot, 'outline/repair-operations.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const resumed = modelAgent(workspace, async (prompt, submitReview) => {
      if (prompt.includes('局部响应点修复')) await writeFile(join(workspace.projectRoot, 'outline/repair-operations.json'), JSON.stringify(repairSchedule))
      else await submitReview()
    })
    await executeOutlineGeneration(resumed.agent, workspace, buildBidStageTask('outline_generation'), {
      run: createTestBidRunContext({ resumeOf: { runId: 'repair-interrupted', cause: 'host_restart' } }),
    })
    expect(resumed.followup).toHaveBeenCalledTimes(1)
    expect(resumed.subagentStart.mock.calls.map(call => call[1].label)).toEqual(['目录质量复核'])
  })

  it('Quality Review 中断时保留 canonical 版本，恢复只重新执行一次完整 Review', async () => {
    const workspace = await fixture()
    await publishOutline(workspace, reviewedOutline)
    const interrupted = modelAgent(workspace, async () => {}, { structuredOutputs: [undefined] })
    await expect(executeOutlineGeneration(interrupted.agent, workspace, buildBidStageTask('outline_generation')))
      .rejects.toThrow('OUTLINE_GENERATION_REVIEW_NOT_CONVERGED')
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(withTechnicalDeviation(reviewedOutline))
    await expect(readFile(join(workspace.projectRoot, 'outline/quality-report.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const resumed = modelAgent(workspace, async () => {}, { structuredOutputs: [{ operations: [], issues: [] }] })
    await executeOutlineGeneration(resumed.agent, workspace, buildBidStageTask('outline_generation'), {
      run: createTestBidRunContext({ resumeOf: { runId: 'review-interrupted', cause: 'host_restart' } }),
    })
    expect(resumed.followup).not.toHaveBeenCalled()
    expect(resumed.subagentStart).toHaveBeenCalledTimes(1)
  })

  it('有 quality-report 但无匹配 Draft 时只重做质量复核', async () => {
    const workspace = await fixture()
    const outline = withTechnicalDeviation(reviewedOutline)
    await publishOutline(workspace, outline, [])
    const { agent, followup, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [{ operations: [], issues: [] }],
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), {
      run: createTestBidRunContext({
        resumeOf: { runId: 'review-durable', cause: 'host_restart' },
      }),
    })
    expect(followup).not.toHaveBeenCalled()
    expect(subagentStart.mock.calls.map(call => call[1].label)).toEqual(['目录质量复核'])
    await expect(readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8')).resolves.toContain('draft_outline_sha256')
  })

  it('完整且通过校验的 final checkpoint 恢复时零模型调用', async () => {
    const workspace = await fixture()
    const outline = withTechnicalDeviation(reviewedOutline)
    await publishOutline(workspace, outline, [])
    await publishDraft(workspace, outline)
    const resumed = modelAgent(workspace, async () => { throw new Error('不应调用模型') })
    const returned = await executeOutlineGeneration(resumed.agent, workspace, buildBidStageTask('outline_generation'))
    expect(resumed.followup).not.toHaveBeenCalled()
    expect(resumed.subagentStart).not.toHaveBeenCalled()
    await expect(validateOutlineGeneration(workspace, 'outline_generation', returned)).resolves.toEqual({ ok: true })
  })

  it('Draft 与当前目录不匹配时使旧报告失效并只重做质量复核', async () => {
    const workspace = await fixture()
    const outline = withTechnicalDeviation(reviewedOutline)
    await publishOutline(workspace, outline, [])
    await publishDraft(workspace, outline)
    const draftPath = join(workspace.projectRoot, 'outline/draft.json')
    const draft = JSON.parse(await readFile(draftPath, 'utf8')) as { outline: OutlineArtifact }
    draft.outline.sections[2]!.title = '被篡改的目录'
    await writeFile(draftPath, JSON.stringify(draft))
    const { agent, followup, subagentStart } = modelAgent(workspace, async () => {}, {
      structuredOutputs: [{ operations: [], issues: [] }],
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), {
      run: createTestBidRunContext({ resumeOf: { runId: 'draft-mismatch', cause: 'host_restart' } }),
    })
    expect(followup).not.toHaveBeenCalled()
    expect(subagentStart.mock.calls.map(call => call[1].label)).toEqual(['目录质量复核'])
  })
})

async function catalogWithMissing(workspace: BidWorkspace) {
  const path = join(workspace.projectRoot, 'analysis/scoring-response-points.json')
  const catalog = parseScoringResponsePointCatalog(JSON.parse(await readFile(path, 'utf8')))
  catalog.points.push({ id: 'RP-000011', scoring_id: 'SCORE-SCHEDULE', order: 2, text: '说明延期风险识别、预警与纠偏安排' })
  catalog.next_sequence = 12
  await writeFile(path, JSON.stringify(catalog))
  return catalog
}

const repairSchedule = [{ type: 'update_section', section_id: 'SEC-SCHEDULE',
  scoring_response_point_ids: ['RP-000001', 'RP-000011'],
  must_answer: ['列明实施阶段、里程碑和进度保障措施。', '说明延期风险识别、预警触发条件、责任人和纠偏安排。'],
}]

describe('S3 确定性规范化与局部续修', () => {
  it.each(['missing', 'misplaced'] as const)('重新生成的 %s 首章经过质量复核后仍符合 S4 输入', async (kind) => {
    const workspace = await fixture()
    const baseline = withTechnicalDeviation(reviewedOutline)
    await publishOutline(workspace, baseline)
    await publishDraft(workspace, baseline)
    const originalDraft = await readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8')
    const candidate = structuredClone(kind === 'missing' ? reviewedOutline : baseline)
    if (kind === 'misplaced') candidate.sections[0]!.order = 10
    const hash = outlineArtifactSha256(baseline)
    const { agent } = modelAgent(workspace, async (prompt) => {
      await writeFile(promptedOutlinePath(workspace, prompt), JSON.stringify(candidate))
      const changeSetPath = prompt.match(/同时写入 ([^，\r\n]+)/u)![1]!
      await writeFile(join(workspace.root, changeSetPath), JSON.stringify({
        schema_version: 1, base_revision: 1, base_draft_sha256: hash, changes: [],
      }))
    }, { structuredOutputs: [
      { operations: [
        { type: 'update_section', section_id: 'dsh-technical-deviation-table', title: '技术响应汇总' },
        { type: 'update_section', section_id: 'SEC-SCHEDULE', purpose: '明确实施里程碑与进度保障。' },
      ], issues: [] },
      { operations: [], issues: [] },
    ] })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), {
      regeneration: { feedback: '明确实施里程碑与进度保障。', revision: 1, draftSha256: hash },
    })
    const outline = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')) as OutlineArtifact
    const [first] = buildWritableSectionWorklist(outline)
    expect(first).toEqual(baseline.sections[0])
    expect(outline.sections[0]).toEqual(first)
    expect(sectionVisibleRequirements(first!, parseTenderRequirementsArtifact(requirements))).toEqual(requirements.requirements)
    expect(outline.sections.find(section => section.id === 'SEC-SCHEDULE')).toMatchObject({
      requirement_ids: ['REQ-SCHEDULE'], scoring_ids: ['SCORE-SCHEDULE'], scoring_response_point_ids: ['RP-000001'],
    })
    expect(validateConfirmedOutline(outline, requirements, scoring, compliance,
      JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')))).toEqual({ ok: true })
    expect(await readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8')).toBe(originalDraft)
  })

  it('确认边界固定技术偏离表为第一章并拒绝模型目录章节', () => {
    const sections = ensureTechnicalDeviationSection(reviewedOutline.sections)
    const roots = sections.filter(section => section.parent_id === null).sort((left, right) => left.order - right.order)
    expect(roots.map(section => [section.id, section.title])).toEqual([
      ['dsh-technical-deviation-table', '技术偏离表'],
      ['SEC-IMPLEMENTATION', '项目实施方案'],
    ])
    expect(() => ensureTechnicalDeviationSection([
      ...reviewedOutline.sections,
      { ...reviewedOutline.sections[2]!, id: 'toc', parent_id: null, order: 2, level: 1, title: '目录' },
    ])).toThrow('不得创建目录章节')
  })

  it('重建缺失、错误文字和错误顺序的快照，去重且幂等，不补入未选择的 RP', async () => {
    const workspace = await fixture()
    const catalog = await catalogWithMissing(workspace)
    const candidate = structuredClone(reviewedOutline)
    const section = candidate.sections[2]!
    section.scoring_response_point_ids = ['RP-000011', 'RP-000001', 'RP-000011']
    section.scoring_ids = []
    section.scoring_response_points = [{ scoring_id: 'SCORE-SCHEDULE', response_point: '错误文字' }]
    const normalized = normalizeOutlineCandidate(candidate, catalog, scoringArtifact)
    section.scoring_response_points[0]!.response_point = ''
    expect(normalizeOutlineCandidate(candidate, catalog, scoringArtifact)).toEqual(normalized)
    expect(normalized.sections[2]!.scoring_response_point_ids).toEqual(['RP-000011', 'RP-000001'])
    expect(normalized.sections[2]!.scoring_response_points.map(point => point.response_point))
      .toEqual([catalog.points[1]!.text, catalog.points[0]!.text])
    expect(normalized.sections[2]!.scoring_ids).toEqual(['SCORE-SCHEDULE'])
    expect(normalizeOutlineCandidate(normalized, catalog, scoringArtifact)).toEqual(normalized)
    expect(normalized.sections.slice(0, 2)).toEqual(reviewedOutline.sections.slice(0, 2))
    const sectionsWithoutSnapshots = candidate.sections.map(({ scoring_response_points: _points, ...section }) => section)
    const missingSnapshots = { ...candidate, sections: sectionsWithoutSnapshots }
    expect(normalizeOutlineCandidate(missingSnapshots, catalog, scoringArtifact)).toEqual(normalized)
    expect(normalizeOutlineCandidate(reviewedOutline, catalog, scoringArtifact).sections[2]!.scoring_response_point_ids)
      .toEqual(['RP-000001'])
  })

  it('保留合法独立评分关联，不按评分编号自动添加其全部 RP', async () => {
    const workspace = await fixture()
    const catalog = await catalogWithMissing(workspace)
    const independentScoring = parseTenderScoringArtifact({ ...scoring, scoring_items: [...scoring.scoring_items, { ...scoring.scoring_items[0]!, id: 'SCORE-INDEPENDENT' }] })
    catalog.scoring_sha256 = scoringArtifactSha256(independentScoring)
    catalog.points.push({ id: 'RP-000012', scoring_id: 'SCORE-INDEPENDENT', order: 1, text: '独立评分内容' })
    catalog.next_sequence = 13
    const outline = structuredClone(reviewedOutline)
    outline.sections[2]!.scoring_ids = ['SCORE-INDEPENDENT', 'SCORE-INDEPENDENT']
    const result = normalizeOutlineCandidate(outline, catalog, independentScoring)
    expect(result.sections[2]!.scoring_ids).toEqual(['SCORE-INDEPENDENT', 'SCORE-SCHEDULE'])
    expect(result.sections[2]!.scoring_response_point_ids).toEqual(['RP-000001'])
  })

  it.each(['rp', 'scoring', 'snapshot'])('未知 %s 编号报错，不静默删去或替换', async (kind) => {
    const workspace = await fixture()
    const catalog = await catalogWithMissing(workspace)
    const outline = structuredClone(reviewedOutline)
    if (kind === 'rp') outline.sections[2]!.scoring_response_point_ids = ['RP-999999']
    else if (kind === 'scoring') outline.sections[2]!.scoring_ids = ['SCORE-UNKNOWN']
    else outline.sections[2]!.scoring_response_points[0]!.scoring_id = 'SCORE-UNKNOWN'
    expect(() => normalizeOutlineCandidate(outline, catalog, scoringArtifact)).toThrow(/未知/)
  })

  it('RP-000011 只修相关章节；修复任务收到正式清单、原文和当前结构', async () => {
    const workspace = await fixture()
    const catalog = await catalogWithMissing(workspace)
    await publishOutline(workspace, reviewedOutline)
    const { agent, followup, guard } = modelAgent(workspace, async (prompt, submitReview) => {
      if (prompt.includes('局部响应点修复')) {
        for (const text of ['RP-000011', catalog.points[1]!.text, scoring.scoring_items[0]!.raw_text, 'SEC-ORGANIZATION', 'must_answer']) expect(prompt).toContain(text)
        const check = guard.mock.calls[0]![0]
        for (const file of ['analysis/scoring-response-points.json', 'outline/outline.json', 'outline/initial-confirmed-outline.json']) {
          expect(check({ name: 'write', arguments: { file_path: join(workspace.projectRoot, file) } } as ToolExecution)).toContain('只读')
        }
        const scratch = prompt.match(/\.bid-harness\/runs\/[^/]+\/scratch\/outline-generation\/outline\/repair-operations\.json/u)?.[0]
        expect(scratch).toBeDefined()
        const output = join(workspace.root, scratch!)
        expect(check({ name: 'write', arguments: { file_path: output } } as ToolExecution), output).toBeUndefined()
        await mkdir(join(output, '..'), { recursive: true })
        await writeFile(output, JSON.stringify(repairSchedule))
      } else {
        expect(prompt).toContain('Blueprint Quality Review')
        await submitReview()
      }
    })
    await executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))
    const result = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')) as OutlineArtifact
    expect(result.sections[0]?.id).toBe('dsh-technical-deviation-table')
    expect(result.sections.find(section => section.id === 'SEC-ORGANIZATION')).toEqual(reviewedOutline.sections[1])
    const schedule = result.sections.find(section => section.id === 'SEC-SCHEDULE')!
    expect(schedule.must_answer).toEqual(repairSchedule[0]!.must_answer)
    expect(schedule.scoring_response_points[1]!.response_point).toBe(catalog.points[1]!.text)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(validateConfirmedOutline(result, requirements, scoring, compliance, catalog)).toEqual({ ok: true })
  })

  it('同一 RP 可由多个可写叶子共同响应；结构父节点不能替代叶子覆盖', async () => {
    const workspace = await fixture()
    const catalog = await catalogWithMissing(workspace)
    const outline = applyOutlineRepair(reviewedOutline, repairSchedule, catalog, scoringArtifact)
    outline.sections[1]!.scoring_response_point_ids = ['RP-000011', 'RP-000011']
    const shared = normalizeOutlineCandidate(outline, catalog, scoringArtifact)
    expect(shared.sections[1]!.scoring_response_point_ids).toEqual(['RP-000011'])
    expect(validateConfirmedOutline(shared, requirements, scoring, compliance, catalog)).toEqual({ ok: true })
    const structural = structuredClone(reviewedOutline)
    structural.sections[0]!.scoring_response_point_ids = ['RP-000011']
    const invalid = normalizeOutlineCandidate(structural, catalog, scoringArtifact)
    expect(missingOutlineResponsePoints(invalid, catalog).map(point => point.id)).toEqual(['RP-000011'])
    const validation = validateConfirmedOutline(invalid, requirements, scoring, compliance, catalog)
    expect(validation.ok).toBe(false)
    if (!validation.ok) expect(validation.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['OUTLINE_SHARED_CONTAINER_RESPONSE_POINT_INVALID', 'OUTLINE_SHARED_RESPONSE_POINT_MISSING']))
  })

  it('确定性修复正式应用后恢复不再获得第二次修复', async () => {
    const workspace = await fixture()
    const catalog = await catalogWithMissing(workspace)
    await publishOutline(workspace, reviewedOutline)
    const failed = modelAgent(workspace, async () => { await writeFile(join(workspace.projectRoot, 'outline/repair-operations.json'), '[]') })
    await expect(executeOutlineGeneration(failed.agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 1 })).rejects.toThrow('RP-000011')
    expect(failed.followup).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8'))).toEqual(catalog)
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(withTechnicalDeviation(reviewedOutline))
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/repair-operations.json'), 'utf8'))).toEqual([])
    await expect(readFile(join(workspace.projectRoot, 'outline/quality-report.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const retry = modelAgent(workspace, async () => { throw new Error('恢复后不应再调用模型') })
    await expect(executeOutlineGeneration(retry.agent, workspace, buildBidStageTask('outline_generation'), {
      run: createTestBidRunContext({ resumeOf: { runId: 'prior-run', cause: 'host_restart' } }),
    })).rejects.toThrow('已经使用过一次确定性修复')
    expect(retry.followup).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8'))).toEqual(catalog)
  })

  it.each(['error', 'aborted'] as const)('复核 %s 即使输出报告也不能伪造完成', async (reason) => {
    const workspace = await fixture()
    await publishOutline(workspace, reviewedOutline)
    const { agent } = modelAgent(workspace, async (_prompt, submitReview) => { await submitReview(); return reason })
    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))).rejects.toThrow('OUTLINE_GENERATION_REVIEW_NOT_CONVERGED')
    await expect(readFile(join(workspace.projectRoot, 'outline/quality-report.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(withTechnicalDeviation(reviewedOutline))
  })

  it('取消局部修复保留当前目录且不发布质量报告', async () => {
    const workspace = await fixture()
    await catalogWithMissing(workspace)
    await publishOutline(workspace, reviewedOutline)
    const controller = new AbortController()
    const { agent } = modelAgent(workspace, async () => { controller.abort(new Error('用户取消')) })
    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 3, signal: controller.signal })).rejects.toThrow('用户取消')
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(withTechnicalDeviation(reviewedOutline))
    await expect(readFile(join(workspace.projectRoot, 'outline/quality-report.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('局部新增和拆分由模型选择 RP，新增章节 ID 由 Host 分配', async () => {
    const workspace = await fixture()
    const catalog = await catalogWithMissing(workspace)
    const added = applyOutlineRepair(reviewedOutline, [{ type: 'add_section', parent_id: 'SEC-IMPLEMENTATION', order: 3, writable: true,
      title: '延期风险控制', purpose: '说明延期风险防控', must_answer: ['说明预警条件与纠偏责任'], scoring_response_point_ids: ['RP-000011'] }], catalog, scoringArtifact)
    expect(added.sections.slice(0, 3)).toEqual(reviewedOutline.sections)
    expect(missingOutlineResponsePoints(added, catalog)).toEqual([])
    const split = applyOutlineRepair(reviewedOutline, [{ type: 'split_section', section_id: 'SEC-SCHEDULE', children: [
      { title: '阶段计划', purpose: '说明阶段计划', must_answer: ['明确各阶段里程碑'], scoring_response_point_ids: ['RP-000001'] },
      { title: '延期防控', purpose: '说明延期防控', must_answer: ['明确延期预警、责任人与纠偏措施'], scoring_response_point_ids: ['RP-000011'] },
    ] }], catalog, scoringArtifact)
    expect(split.sections.slice(0, 2)).toEqual(reviewedOutline.sections.slice(0, 2))
    expect(split.sections[2]!.writable).toBe(false)
    expect(missingOutlineResponsePoints(split, catalog)).toEqual([])
    expect(validateConfirmedOutline(split, requirements, scoring, compliance, catalog)).toEqual({ ok: true })
  })

  it('只补关联不提供具体写作指导的局部操作被拒绝', async () => {
    const workspace = await fixture()
    const catalog = await catalogWithMissing(workspace)
    expect(() => applyOutlineRepair(reviewedOutline, [{ type: 'update_section', section_id: 'SEC-SCHEDULE', title: '实施计划', scoring_response_point_ids: ['RP-000011'] }], catalog, scoringArtifact)).toThrow('must_answer')
  })

  it('正式输入版本变化作为输入错误拒绝续修，保留原目录和 RP 编号', async () => {
    const workspace = await fixture()
    const originalCatalog = await catalogWithMissing(workspace)
    await publishOutline(workspace, reviewedOutline)
    const fail = modelAgent(workspace, async () => {})
    await expect(executeOutlineGeneration(fail.agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 0 })).rejects.toThrow()
    const changedScoring = { ...scoring, scoring_items: [{ ...scoring.scoring_items[0]!, raw_text: '更新后的评分原文。' }] }
    await writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), JSON.stringify(changedScoring))
    const { agent, followup } = modelAgent(workspace, async () => {})
    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))).rejects.toThrow('正式输入版本已变化')
    expect(followup).not.toHaveBeenCalled()
    const catalog = parseScoringResponsePointCatalog(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), 'utf8')))
    expect(catalog).toEqual(originalCatalog)
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8'))).toEqual(withTechnicalDeviation(reviewedOutline))
  })

  it('已有 S3 用户确认版本不能被失败重试覆盖', async () => {
    const workspace = await fixture()
    await publishOutline(workspace, reviewedOutline)
    const confirmed = join(workspace.projectRoot, 'outline/initial-confirmed-outline.json')
    await writeFile(confirmed, JSON.stringify(reviewedOutline))
    const { agent, followup } = modelAgent(workspace, async () => {})
    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'))).rejects.toThrow('用户确认目录')
    expect(followup).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(confirmed, 'utf8'))).toEqual(reviewedOutline)
  })

  it('复核引入遗漏且预算耗尽时仍校验差集，保留中文缺失内容', async () => {
    const workspace = await fixture()
    const catalog = await catalogWithMissing(workspace)
    await publishOutline(workspace, applyOutlineRepair(reviewedOutline, repairSchedule, catalog, scoringArtifact))
    const { agent } = modelAgent(workspace, async () => {}, { structuredOutputs: [{
      operations: [{
        type: 'update_section', section_id: 'SEC-SCHEDULE',
        scoring_response_point_ids: ['RP-000001'],
        must_answer: reviewedOutline.sections[2]!.must_answer,
      }],
      issues: [],
    }] })
    await expect(executeOutlineGeneration(agent, workspace, buildBidStageTask('outline_generation'), { maxRepairAttempts: 0 }))
      .rejects.toThrow(catalog.points[1]!.text)
    await expect(readFile(join(workspace.projectRoot, 'outline/quality-report.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

})
