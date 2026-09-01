import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  BidWorkspace,
  buildBidStageTask,
  buildEvidenceMappingWebSnapshots,
  createScoringResponsePointCatalog,
  executeEvidenceMapping,
  getBidStagePolicy,
  mergeEvidenceMappingPartialResults,
  parseWebEvidenceSourcesArtifact,
  readEvidenceMappingProgress,
  renderEvidenceMappingTask,
  type EvidenceMappingWebObservation,
} from '@deepseek-ai/dsh-bid'

function observation(
  input: Pick<EvidenceMappingWebObservation, 'callId' | 'name' | 'arguments' | 'callSeq' | 'resultSeq'>
  & { value?: unknown; content?: string; isError?: boolean; statusMeta?: unknown },
): EvidenceMappingWebObservation {
  const isError = input.isError ?? false
  return {
    ...input,
    resultTime: 1_788_134_400_000,
    result: isError
      ? { isError: true, error: { message: 'failed' }, content: [{ type: 'text', text: 'failed' }] }
      : {
        isError: false,
        value: input.value as never,
        content: [{ type: 'text', text: input.content ?? 'ok' }],
        ...(input.statusMeta === undefined ? {} : { meta: input.statusMeta as never }),
      },
  }
}

function promptText(request: SubagentStartRequest): string {
  return request.prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function writeInputs(workspace: BidWorkspace) {
  const [tender, reference] = await workspace.import([
    { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('要求一。要求二。评分一。评分二。') },
    { name: 'reference.md', role: 'reference', bytes: new TextEncoder().encode('可复用的统一技术资料。') },
  ])
  if (tender === undefined || reference === undefined
    || tender.absoluteChunkIndexPath === null || tender.chunksPath === null
    || reference.absoluteChunkIndexPath === null || reference.chunksPath === null) {
    throw new Error('executor fixture missing')
  }
  const index = JSON.parse(await readFile(reference.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ id: string; path: string }> }
  const tenderIndex = JSON.parse(await readFile(tender.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ id: string; path: string }> }
  const chunk = `${reference.chunksPath}/${index.chunks[0]!.path}`
  const tenderChunk = `${tender.chunksPath}/${tenderIndex.chunks[0]!.path}`
  const source = [{ file_id: tender.id, chunk: 'x', line_start: 1, line_end: 1 }]
  const scoring = { schema_version: 1 as const, scoring_items: [1, 2].map(value => ({ id: `S-${value}`, parent: null, group: '技术', title: `评分${value}`, raw_text: `评分${value}`, criterion: `响应评分${value}`, score: 1, score_range: null, must_answer: true, response_points: [`响应点${value}`], source_refs: source })) }
  await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
  await Promise.all([
    writeFile(join(workspace.sessionRoot, 'analysis/project.json'), JSON.stringify({ schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null, project_background: ['背景'], project_objectives: ['目标'], project_scope: ['范围'], technical_scope: ['技术'], delivery_scope: ['交付'], implementation_constraints: [], key_technical_points: ['架构'], source_refs: source, analyzed_tender_files: [tender.id] })),
    writeFile(join(workspace.sessionRoot, 'analysis/requirements.json'), JSON.stringify({ schema_version: 1, requirements: [1, 2].map(value => ({ id: `R-${value}`, category: '技术', raw_text: `要求${value}`, normalized_requirement: `响应要求${value}`, mandatory: true, source_refs: source })) })),
    writeFile(join(workspace.sessionRoot, 'analysis/scoring.json'), JSON.stringify(scoring)),
    writeFile(join(workspace.sessionRoot, 'analysis/scoring-response-points.json'), JSON.stringify(createScoringResponsePointCatalog(scoring))),
    writeFile(join(workspace.sessionRoot, 'analysis/compliance.json'), JSON.stringify({ schema_version: 1, compliance_items: [] })),
  ])
  return { chunk, fileId: reference.id, tender: { chunk: tenderChunk, fileId: tender.id } }
}

function mappingFixture(workspace: BidWorkspace, material: { chunk: string; fileId: string }, repairFirst = false) {
  let pendingMain = ''
  let active = 0
  let maxActive = 0
  let sequence = 0
  const starts: Array<{ request: SubagentStartRequest; resolve(): void }> = []
  const taskAttempts = new Map<string, number>()
  const disposed: string[] = []
  const plan = {
    schema_version: 1, global_analysis: ['按业务响应拆分。'], source_strategy_notes: ['普通资料供各任务交叉检索。'],
    tasks: [
      { task_id: 'TASK-1', title: '主题一', objective: '处理第一组', requirement_ids: ['R-1'], scoring_ids: ['S-1'], response_point_ids: ['RP-000001'], compliance_ids: [], source_focus: ['统一资料'], research_topics: [] },
      { task_id: 'TASK-2', title: '主题二', objective: '处理第二组', requirement_ids: ['R-1', 'R-2'], scoring_ids: ['S-2'], response_point_ids: ['RP-000002'], compliance_ids: [], source_focus: ['统一资料'], research_topics: [] },
    ],
  }
  const partial = (request: SubagentStartRequest) => {
    const line = promptText(request).split('\n').find(value => value.startsWith('Mapping Task：'))
    if (line === undefined) throw new Error('mapping task missing')
    const task = JSON.parse(line.slice('Mapping Task：'.length)) as typeof plan.tasks[number]
    const attempt = (taskAttempts.get(task.task_id) ?? 0) + 1
    taskAttempts.set(task.task_id, attempt)
    const local = { file_id: material.fileId, chunk: task.task_id === 'TASK-1' ? material.chunk : `alternate\\prefix\\${material.chunk.split('/').at(-1)}`, line_start: 1, line_end: 1, usage: 'reference' as const, summary: '统一资料。' }
    return {
      task_id: task.task_id,
      requirement_mappings: task.requirement_ids.flatMap((requirement_id, index) =>
        repairFirst && task.task_id === 'TASK-1' && attempt === 1 && index === 0
          ? []
          : [{ requirement_id, materials: [local], external_materials: [], missing_topics: [], writing_dimensions: ['技术响应'] }]),
      scoring_mappings: task.scoring_ids.map(scoring_id => ({
        scoring_id, materials: [local], external_materials: [], missing_topics: [],
      })),
      response_point_mappings: task.response_point_ids.map((response_point_id) => {
        const value = Number(response_point_id.slice(-1))
        return {
          response_point_id, scoring_id: `S-${value}`, response_point: `响应点${value}`,
          materials: [local], external_materials: [], missing_topics: [], writing_dimensions: ['技术响应'],
        }
      }),
      research_topics: [], framework_mappings: [], reference_bid_mappings: [], findings: [`${task.task_id} 结论`], missing_topics: [],
    }
  }
  const spawnProvider = {
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
  }
  const subagents = {
    getProvider: vi.fn(() => spawnProvider),
    start: vi.fn(async (_provider: string, request: SubagentStartRequest): Promise<SubagentRun> => {
      active++
      maxActive = Math.max(maxActive, active)
      const id = SessionId(`child-${++sequence}`)
      let settle!: () => void
      const result = new Promise<Awaited<SubagentRun['result']>>((resolve) => {
        settle = () => { active--; resolve({ stopReason: 'completed', output: [], structured: partial(request) }) }
      })
      const localAgent = { id, session: { id, header: { cwd: workspace.root, parentSession: 'session', origin: 'subagent' }, events: [
        { type: 'tool/call', data: { name: 'grep' } }, { type: 'tool/call', data: { name: 'read' } },
      ] } } as unknown as Agent
      const run = { id, localAgent, result, dispose: async () => { disposed.push(String(id)) } }
      starts.push({ request, resolve: settle })
      if (repairFirst) queueMicrotask(settle)
      return run
    }),
  }
  const guards: Array<(execution: Readonly<ToolExecution>) => string | undefined> = []
  const tools = {
    schemas: vi.fn(() => ['read', 'write', 'grep', 'web_search', 'web_fetch'].map(name => ({ name }))),
    restrict: vi.fn(() => () => {}),
    guard: vi.fn((guard: (execution: Readonly<ToolExecution>) => string | undefined) => { guards.push(guard); return () => {} }),
  }
  const followup = vi.fn((message: unknown) => { pendingMain = JSON.stringify(message) })
  const whenIdle = vi.fn(async () => {
    if (pendingMain.includes('Main-Agent Planning')) {
      await writeFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-plan.json'), JSON.stringify(plan))
    } else if (pendingMain.includes('Main-Agent Merge')) {
      const text = JSON.parse(pendingMain) as { content: Array<{ text?: string }> }
      const prompt = text.content[0]?.text ?? pendingMain
      const line = prompt.split('\n').find(value => value.startsWith('Host 按稳定 ID 去重后的 Child 结论：'))
      if (line === undefined) throw new Error('merged result missing')
      const merged = JSON.parse(line.slice('Host 按稳定 ID 去重后的 Child 结论：'.length)) as ReturnType<
        typeof mergeEvidenceMappingPartialResults
      >
      await writeFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({
        schema_version: 5,
        source_strategy: { mode: 'generated_from_scratch', framework_file_id: null, reference_bid_files: [] },
        framework_mappings: merged.framework_mappings,
        reference_bid_mappings: merged.reference_bid_mappings,
        research_topics: merged.research_topics,
        requirement_mappings: merged.requirement_mappings,
        scoring_mappings: merged.scoring_mappings,
        response_point_mappings: merged.response_point_mappings,
      }))
    }
    pendingMain = ''
  })
  const agent = { id: 'session', session: { header: { cwd: workspace.root }, events: [] }, ctx: { get: (name: string) => ({ fs: { resolve: async (path: string) => path }, tools, subagents } as Record<string, unknown>)[name], emit: vi.fn(), on: vi.fn(() => () => {}) }, followup, whenIdle } as unknown as Agent
  return {
    agent, starts, subagents, followup, whenIdle, currentPrompt: () => pendingMain,
    guards, disposed, maxActive: () => maxActive, taskAttempts,
  }
}

describe('evidence-mapping Agent executor', () => {
  it('keeps the Main Agent on global planning and delegates bounded local research to Child Sessions', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-executor-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1, maxConcurrency: 2 })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    expect(fixture.maxActive()).toBe(2)
    await expect(readEvidenceMappingProgress(workspace)).resolves.toEqual({
      total: 2,
      completed: 0,
      running: 2,
      not_started: 0,
      failed: 0,
    })
    expect(promptText(fixture.starts[0]!.request)).toContain('相关 Requirements：[{"id":"R-1"')
    expect(promptText(fixture.starts[0]!.request)).not.toContain('"id":"R-2"')
    expect(promptText(fixture.starts[0]!.request)).toContain('招标文件只用于当前 S2 摘要中的需求理解')
    expect(promptText(fixture.starts[0]!.request)).toContain('提交前在当前子任务中逐项检查')
    expect(promptText(fixture.starts[0]!.request)).not.toContain(material.tender.fileId)
    expect(promptText(fixture.starts[0]!.request)).not.toContain(material.tender.chunk)
    for (const start of fixture.starts) {
      expect(start.request).toMatchObject({ maxDepth: 1, toolFilter: { allow: ['grep', 'read', 'web_search', 'web_fetch'] } })
      expect(start.request.outputSchema).toBeDefined()
    }
    const childReadGuard = fixture.guards.at(-1)
    expect(childReadGuard?.({
      name: 'read', arguments: { file_path: join(workspace.sessionRoot, material.tender.chunk) },
      agent: { session: { header: { origin: 'subagent', parentSession: 'session', cwd: workspace.root } } },
    } as unknown as ToolExecution)).toBe('S3 Mapping Child 不可读取招标文件或未入库资料的分块。')
    fixture.starts.forEach((start) => { start.resolve() })
    await expect(execution).resolves.toHaveLength(2)
    await expect(readEvidenceMappingProgress(workspace)).resolves.toEqual({
      total: 2,
      completed: 2,
      running: 0,
      not_started: 0,
      failed: 0,
    })

    const map = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-map.json'), 'utf8')) as { requirement_mappings: Array<{ requirement_id: string; materials: unknown[] }> }
    expect(map.requirement_mappings.find(item => item.requirement_id === 'R-1')?.materials).toHaveLength(1)
    const log = JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-log.json'), 'utf8')) as { observed_max_concurrency: number; tasks: Array<{ final_child_session_id: string | null }> }
    expect(log.observed_max_concurrency).toBe(2)
    expect(log.tasks.every(item => item.final_child_session_id !== null)).toBe(true)
    expect(parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(workspace.sessionRoot, 'analysis/web-evidence-sources.json'), 'utf8'))).sources).toEqual([])
    expect(fixture.followup).toHaveBeenCalledTimes(2)
    expect(fixture.disposed).toHaveLength(2)
  })

  it('repairs only the failed Mapping Child without rerunning an accepted sibling', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-repair-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material, true)

    await executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1, maxConcurrency: 2 })

    expect(fixture.taskAttempts.get('TASK-1')).toBe(2)
    expect(fixture.taskAttempts.get('TASK-2')).toBe(1)
    expect(fixture.subagents.start).toHaveBeenCalledTimes(3)
    expect(promptText(fixture.subagents.start.mock.calls[2]![1])).toContain('EVIDENCE_MAPPING_PARTIAL_MISSING')
    expect(fixture.subagents.start.mock.calls[2]![1]).toMatchObject({ label: 'S3 · 主题一' })
  })

  it('reports tender materials separately from invalid chunk references', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-tender-material-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material.tender)
    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0,
      maxConcurrency: 2,
    })

    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await expect(execution).rejects.toThrow('EVIDENCE_MAPPING_PARTIAL_TENDER_EVIDENCE_FORBIDDEN')
    await expect(readFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-log.json'), 'utf8'))
      .resolves.toContain('招标文件不得作为本地 Evidence')
  })

  it('limits the Main Agent policy to plan and merge tools', () => {
    const policy = getBidStagePolicy('evidence_mapping')
    expect(policy.allowedTools).toEqual(['read', 'write'])
    const prompt = renderEvidenceMappingTask({ id: 'session' } as Agent, new BidWorkspace('C:/workspace', 'session'), buildBidStageTask('evidence_mapping'))
    expect(prompt).toContain('不要 grep、不要读取 corpus chunk、不要联网')
    expect(prompt).toContain('不得按文件角色拆任务')
    expect(prompt).toContain('不得包含 Markdown code fence、解释文字或任何其他前后缀')
    expect(prompt).toContain('每个 task 严格只允许 task_id、title、objective')
  })

  it.each([
    {
      name: 'reports a missing plan separately',
      content: undefined,
      code: 'EVIDENCE_MAPPING_PLAN_MISSING',
      detail: 'evidence-mapping-plan.json 未生成。',
    },
    {
      name: 'reports the JSON parse reason separately',
      content: '{"schema_version":',
      code: 'EVIDENCE_MAPPING_PLAN_JSON_INVALID',
      detail: 'evidence-mapping-plan.json JSON 解析失败：',
    },
    {
      name: 'reports strict plan schema paths separately',
      content: JSON.stringify({
        schema_version: 1,
        global_analysis: ['按业务主题拆分。'],
        source_strategy_notes: [],
        tasks: [{
          task_id: 'TASK-1',
          title: '缺少目标',
          requirement_ids: ['R-1'],
          scoring_ids: [],
          response_point_ids: [],
          compliance_ids: [],
          source_focus: [],
          research_topics: [],
        }],
      }),
      code: 'EVIDENCE_MAPPING_PLAN_SCHEMA_INVALID',
      detail: 'tasks[0].objective:',
    },
  ])('$name', async ({ content, code, detail }) => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-plan-invalid-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    fixture.whenIdle.mockImplementation(async () => {
      if (!fixture.currentPrompt().includes('Main-Agent Planning') || content === undefined) return
      await writeFile(join(workspace.sessionRoot, 'analysis/evidence-mapping-plan.json'), content)
    })

    await expect(executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxRepairAttempts: 0,
      maxConcurrency: 2,
    })).rejects.toMatchObject({
      name: 'BidStageExecutionError',
      message: expect.stringContaining(`${code} ${detail}`),
      issues: expect.arrayContaining([expect.objectContaining({ code })]),
    })
  })

  it('removes the rejected plan before asking the Main Agent to repair it', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-plan-repair-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    let planAttempt = 0
    let removedBeforeRepair = false
    fixture.whenIdle.mockImplementation(async () => {
      if (!fixture.currentPrompt().includes('Main-Agent Planning')) return
      const planPath = join(workspace.sessionRoot, 'analysis/evidence-mapping-plan.json')
      if (planAttempt++ === 0) {
        await writeFile(planPath, '{"schema_version":')
        return
      }
      await expect(readFile(planPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      removedBeforeRepair = true
      await writeFile(planPath, JSON.stringify({
        schema_version: 1,
        global_analysis: ['按业务主题拆分。'],
        source_strategy_notes: [],
        tasks: [{
          task_id: 'TASK-1', title: '主题一', objective: '处理第一组', requirement_ids: ['R-1'], scoring_ids: ['S-1'],
          response_point_ids: ['RP-000001'], compliance_ids: [], source_focus: [], research_topics: [],
        }, {
          task_id: 'TASK-2', title: '主题二', objective: '处理第二组', requirement_ids: ['R-2'], scoring_ids: ['S-2'],
          response_point_ids: ['RP-000002'], compliance_ids: [], source_focus: [], research_topics: [],
        }],
      }))
    })

    const execution = executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'), { maxRepairAttempts: 1, maxConcurrency: 2 })
    await vi.waitFor(() => { expect(fixture.starts).toHaveLength(2) })
    fixture.starts.forEach(start => start.resolve())
    await expect(execution).resolves.toHaveLength(2)
    expect(removedBeforeRepair).toBe(true)
  })

  it('fails before planning when spawn cannot enforce an independent structured Child', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-provider-')), 'session')
    const material = await writeInputs(workspace)
    const fixture = mappingFixture(workspace, material)
    fixture.subagents.getProvider.mockReturnValue({
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: true,
    })
    await expect(executeEvidenceMapping(fixture.agent, workspace, buildBidStageTask('evidence_mapping'))).rejects.toThrow('fresh-context spawn subagent provider')
    expect(fixture.followup).not.toHaveBeenCalled()
  })
})

describe('evidence-mapping Web source reduction', () => {
  const url = 'https://official.example/standard#section'
  const search = observation({
    callId: 'search-1', name: 'web_search', arguments: { queries: ['访问控制官方标准'] }, callSeq: 1, resultSeq: 2,
    value: { sources: [{ url }], truncated: false },
  })
  const fetch = observation({
    callId: 'fetch-1', name: 'web_fetch', arguments: { url: 'https://official.example/standard' }, callSeq: 3, resultSeq: 4,
    value: { url: 'https://official.example/standard', statusCode: 200, body: { kind: 'text', content: '正文' }, truncated: false },
    content: 'Fetched https://official.example/standard (HTTP 200)\n\n正文',
    statusMeta: { truncated: false },
  })

  it('creates a source only from an ordered successful search-to-fetch chain', () => {
    const snapshots = buildEvidenceMappingWebSnapshots([search, fetch])
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.source).toMatchObject({
      search_call_id: 'search-1', fetch_call_id: 'fetch-1', status_code: 200,
      discovered_url: url, requested_url: 'https://official.example/standard',
    })
    expect(snapshots[0]?.content).toContain('正文')
  })

  it.each([
    ['search only', [search]],
    ['fetch only', [fetch]],
    ['fetch before search', [{ ...fetch, callSeq: 1, resultSeq: 2 }, { ...search, callSeq: 3, resultSeq: 4 }]],
    ['URL mismatch', [search, { ...fetch, arguments: { url: 'https://other.example/page' } }]],
    ['fetch failure', [search, observation({ callId: 'fetch-1', name: 'web_fetch', arguments: fetch.arguments, callSeq: 3, resultSeq: 4, isError: true })]],
    ['non-2xx fetch', [search, observation({ callId: 'fetch-1', name: 'web_fetch', arguments: fetch.arguments, callSeq: 3, resultSeq: 4, value: { url: 'https://official.example/standard', statusCode: 404, body: { kind: 'text', content: 'missing' }, truncated: false } })]],
  ])('does not verify %s', (_name, observations) => {
    expect(buildEvidenceMappingWebSnapshots(observations)).toEqual([])
  })
})
