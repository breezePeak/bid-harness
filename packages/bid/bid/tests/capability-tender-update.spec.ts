import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import { bidCapabilityInputSchema, type BidCapabilityExecutionContext } from '../src/bid-capability-contract.ts'
import { executeTenderUpdateCapability, validateTenderUpdateCapability } from '../src/bid-tender-update-capability.ts'
import { parseScoringResponsePointCatalog } from '../src/scoring-response-point-artifacts.ts'
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
