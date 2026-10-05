import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { bidCapabilityInputSchema, type BidCapabilityExecutionContext } from '../src/bid-capability-contract.ts'
import { analyzeChangedScoringResponsePoints, executeTenderUpdateCapability, validateTenderUpdateCapability } from '../src/bid-tender-update-capability.ts'
import { parseScoringResponsePointCatalog } from '../src/scoring-response-point-artifacts.ts'
import { parseTenderScoringArtifact } from '../src/tender-analysis-artifacts.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { seedCapabilityProject } from './capability-fixture.ts'

function context(workspace: BidWorkspace): BidCapabilityExecutionContext {
  return { canonical: workspace, working: workspace, agent: {} as BidCapabilityExecutionContext['agent'],
    run: createTestBidRunContext(), sectionIds: null, stepDirectory: workspace.root,
    inputSources: new Map(), baselineHashes: new Map(), allowedWrites: new Set(),
    stepId: 'step-1', rootWorkId: 'work-1', inputSha256: 'hash',
    authorization: { session_id: 'user-session', message_id: 'message-1' } }
}

async function json(workspace: BidWorkspace, path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(workspace.projectRoot, path), 'utf8')) as unknown
}

async function scoringAnalysisFixture(structured: unknown) {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-update-child-')))
  await seedCapabilityProject(workspace, 'complete')
  const input = parseTenderScoringArtifact(await json(workspace, 'analysis/scoring.json'))
  const scoring = { ...input, scoring_items: input.scoring_items.filter((_, index) => index === 1 || index === 3) }
  const dispose = vi.fn(async () => {})
  const start = vi.fn(async (_provider: string, _request: SubagentStartRequest) => ({
    result: Promise.resolve({ stopReason: 'completed', structured, output: [] }), dispose,
  }))
  const agent = { ctx: { get: () => ({ getProvider: () => ({ inheritsParentContext: false }), start }) } } as unknown as BidCapabilityExecutionContext['agent']
  return { context: { ...context(workspace), agent }, scoring, start, dispose }
}

it('局部评分 Child 选择冻结位置，程序绑定非连续评分身份与同项顺序', async () => {
  const fixture = await scoringAnalysisFixture({ points: [
    { scoring_position: 1, text: '交付核验' },
    { scoring_position: 0, text: '设计方案' },
    { scoring_position: 0, text: '实施安排' },
  ] })
  await expect(analyzeChangedScoringResponsePoints(fixture.context, fixture.scoring)).resolves.toEqual({
    schema_version: 1, points: [
      { scoring_id: 'SCORE-4', order: 1, text: '交付核验' },
      { scoring_id: 'SCORE-2', order: 1, text: '设计方案' },
      { scoring_id: 'SCORE-2', order: 2, text: '实施安排' },
    ],
  })
  expect(fixture.start).toHaveBeenCalledOnce()
  const request = fixture.start.mock.calls[0]![1]
  assertSupportedJsonSchema(request.outputSchema)
  expect(request.outputSchema).toEqual({ type: 'object', properties: {
    points: { type: 'array', items: { type: 'object', properties: {
      scoring_position: { type: 'integer' }, text: { type: 'string' },
    }, required: ['scoring_position', 'text'], additionalProperties: false } },
  }, required: ['points'], additionalProperties: false })
  const prompt = request.prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(prompt).toContain('"scoring_position":0')
  expect(prompt).toContain('"scoring_position":1')
  expect(prompt).not.toContain('SCORE-2')
  expect(prompt).not.toContain('SCORE-4')
  expect(fixture.dispose).toHaveBeenCalledOnce()
})

it.each([
  { name: '原始评分 ID', value: { points: [{ scoring_position: 0, scoring_id: 'SCORE-2', text: '设计' }] }, error: 'Unrecognized key' },
  { name: '模型指定顺序', value: { points: [{ scoring_position: 0, order: 1, text: '设计' }] }, error: 'Unrecognized key' },
  { name: '模型指定版本', value: { schema_version: 1, points: [{ scoring_position: 0, text: '设计' }] }, error: 'Unrecognized key' },
  { name: '越界评分位置', value: { points: [{ scoring_position: 2, text: '设计' }] }, error: 'scoring-response-point-candidate-position-invalid' },
])('局部评分 Child 拒绝 $name 并释放会话', async ({ value, error }) => {
  const fixture = await scoringAnalysisFixture(value)
  await expect(analyzeChangedScoringResponsePoints(fixture.context, fixture.scoring)).rejects.toThrow(error)
  expect(fixture.dispose).toHaveBeenCalledOnce()
})

it('完成写作后修改一条规范化要求，来源与正文保持原值并标记对应章节', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-update-requirement-')))
  await seedCapabilityProject(workspace, 'complete')
  const before = await json(workspace, 'analysis/requirements.json') as { requirements: Array<Record<string, unknown>> }
  const body = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
  const call = bidCapabilityInputSchema.parse({ capability: 'tender.update', input: { operations: [{
    type: 'update_requirement', requirement_id: 'REQ-1',
    fields: { normalized_requirement: '明确总体方案的实施边界' },
  }] } })
  if (call.capability !== 'tender.update') throw new Error('test call mismatch')
  const execution = await executeTenderUpdateCapability(call, context(workspace))
  expect(execution.result.target_section_ids).toEqual(['SEC-1'])
  const after = await json(workspace, 'analysis/requirements.json') as { requirements: Array<Record<string, unknown>> }
  expect(after.requirements[0]).toMatchObject({ id: 'REQ-1', raw_text: before.requirements[0]?.raw_text,
    source_refs: before.requirements[0]?.source_refs,
    normalized_requirement: '明确总体方案的实施边界' })
  expect(after.requirements.slice(1)).toEqual(before.requirements.slice(1))
  expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(body)
  expect(await json(workspace, 'analysis/tender-update-impact.json')).toMatchObject({
    affected_section_ids: ['SEC-1'], changed_requirement_ids: ['REQ-1'],
  })
  await expect(validateTenderUpdateCapability({ working: workspace })).resolves.toBeUndefined()
})

it('取消评分选择保留来源事实与其他 RP 身份', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-update-selection-')))
  await seedCapabilityProject(workspace, 'complete')
  const origin = await json(workspace, 'analysis/scoring-origin.json')
  const previous = parseScoringResponsePointCatalog(await json(workspace, 'analysis/scoring-response-points.json'))
  const call = bidCapabilityInputSchema.parse({ capability: 'tender.update', input: {
    operations: [], selected_scoring_ids: ['SCORE-1', 'SCORE-2', 'SCORE-4', 'SCORE-5'],
  } })
  if (call.capability !== 'tender.update') throw new Error('test call mismatch')
  const execution = await executeTenderUpdateCapability(call, context(workspace))
  expect(execution.result.target_section_ids).toEqual(['SEC-3'])
  expect(await json(workspace, 'analysis/scoring-origin.json')).toEqual(origin)
  const scoring = await json(workspace, 'analysis/scoring.json') as { scoring_items: Array<{ id: string }> }
  expect(scoring.scoring_items.map(item => item.id)).toEqual(['SCORE-1', 'SCORE-2', 'SCORE-4', 'SCORE-5'])
  const catalog = parseScoringResponsePointCatalog(await json(workspace, 'analysis/scoring-response-points.json'))
  expect(catalog.points).toEqual(previous.points.filter(point => point.scoring_id !== 'SCORE-3'))
  expect(catalog.next_sequence).toBe(previous.next_sequence)
})

it('拒绝不存在的招标 ID，不创造新事实', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-update-unknown-')))
  await seedCapabilityProject(workspace, 'complete')
  const call = bidCapabilityInputSchema.parse({ capability: 'tender.update', input: { operations: [{
    type: 'update_requirement', requirement_id: 'REQ-DOES-NOT-EXIST', fields: { mandatory: false },
  }] } })
  if (call.capability !== 'tender.update') throw new Error('test call mismatch')
  await expect(executeTenderUpdateCapability(call, context(workspace))).rejects.toThrow('unknown tender requirement')
})

it('评分语义变化只重分配该评分项的 RP', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-tender-update-semantic-')))
  await seedCapabilityProject(workspace, 'complete')
  const previous = parseScoringResponsePointCatalog(await json(workspace, 'analysis/scoring-response-points.json'))
  const call = bidCapabilityInputSchema.parse({ capability: 'tender.update', input: { operations: [{
    type: 'update_scoring_item', scoring_id: 'SCORE-2', fields: { criterion: '分别响应设计与实施' },
  }] } })
  if (call.capability !== 'tender.update') throw new Error('test call mismatch')
  const execution = await executeTenderUpdateCapability(call, context(workspace), async (_context, scoring) => {
    expect(scoring.scoring_items.map(item => item.id)).toEqual(['SCORE-2'])
    return { schema_version: 1, points: [
      { scoring_id: 'SCORE-2', order: 1, text: '设计方案' },
      { scoring_id: 'SCORE-2', order: 2, text: '实施安排' },
    ] }
  })
  expect(execution.result.target_section_ids).toEqual(['SEC-2'])
  const catalog = parseScoringResponsePointCatalog(await json(workspace, 'analysis/scoring-response-points.json'))
  expect(catalog.points.filter(point => point.scoring_id !== 'SCORE-2'))
    .toEqual(previous.points.filter(point => point.scoring_id !== 'SCORE-2'))
  expect(catalog.points.filter(point => point.scoring_id === 'SCORE-2').map(point => point.id))
    .toEqual(['RP-000006', 'RP-000007'])
})
