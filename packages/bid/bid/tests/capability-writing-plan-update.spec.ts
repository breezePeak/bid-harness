import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import { bidCapabilityInputSchema, type BidCapabilityExecutionContext } from '../src/bid-capability-contract.ts'
import { executeWritingPlanCapability, validateWritingPlanCapability } from '../src/bid-writing-plan-capability.ts'
import { parseWritingPlan } from '../src/writing-requirements.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { writeInputs } from './fixtures/chapter-writing-inputs.ts'

function context(workspace: BidWorkspace, text: string, sectionIds: ReadonlySet<string> | null = null): BidCapabilityExecutionContext {
  return {
    canonical: workspace, working: workspace, agent: {} as BidCapabilityExecutionContext['agent'],
    sourceSession: { id: 'user-session', events: [{ type: 'user/message',
      data: { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text }] } }] },
    run: createTestBidRunContext(), sectionIds, stepDirectory: workspace.root,
    inputSources: new Map(), baselineHashes: new Map(), allowedWrites: new Set(),
    stepId: 'step-1', rootWorkId: 'work-1', inputSha256: 'hash',
    authorization: { session_id: 'user-session', message_id: 'message-1' },
  }
}

it('本章写作要求只进入本章，保留其他 AC 身份', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-capability-writing-plan-local-')))
  await writeInputs(workspace)
  const path = join(workspace.projectRoot, 'chapters/writing-plan.json')
  const prior = parseWritingPlan(JSON.parse(await readFile(path, 'utf8')))
  prior.sections[0]!.acceptance_criteria.push({ id: 'AC-000001',
    scope: { kind: 'section', section_id: 'SEC-1' }, description: '第一章验收。',
    priority: 'required', evaluator: { kind: 'semantic' } })
  await writeFile(path, `${JSON.stringify(prior)}\n`)
  const ref = { session_id: 'user-session', message_id: 'message-1', seq: 0 }
  const call = bidCapabilityInputSchema.parse({ capability: 'writing.plan', input: {
    update_kind: 'patch', base_plan_version: 1, user_message_refs: [ref],
    summary: '只调整第二章', affected_section_ids: ['SEC-2'],
    sections: [{ section_id: 'SEC-2', add_user_message_refs: [ref],
      writing_instructions: ['展开第二章实施安排。'],
      acceptance_criteria: { add: [{ description: '具体说明第二章实施安排。',
        priority: 'required', evaluator: { kind: 'semantic' } }], update: [], delete: [] } }],
  } })
  if (call.capability !== 'writing.plan') throw new Error('test call mismatch')
  const execution = await executeWritingPlanCapability(call, context(workspace,
    '第二章写详细一点，其他章节不用动。', new Set(['SEC-2'])))
  expect(execution.result.target_section_ids).toEqual(['SEC-2'])
  expect(execution.result.changed_artifacts).toEqual(['chapters/writing-plan.json'])
  const updated = parseWritingPlan(JSON.parse(await readFile(path, 'utf8')))
  expect(updated.user_requirements).toEqual(prior.user_requirements)
  expect(updated.sections[1]?.user_requirements).toEqual(['第二章写详细一点，其他章节不用动。'])
  expect(updated.sections[0]).toEqual(prior.sections[0])
  expect(updated.sections[1]?.acceptance_criteria.map(item => item.id)).toEqual(['AC-000002'])
  await expect(validateWritingPlanCapability({ working: workspace })).resolves.toBeUndefined()
})

it('全书约束影响全部叶节，章节授权不能修改全书', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-capability-writing-plan-global-')))
  await writeInputs(workspace)
  const ref = { session_id: 'user-session', message_id: 'message-1', seq: 0 }
  const call = bidCapabilityInputSchema.parse({ capability: 'writing.plan', input: {
    update_kind: 'patch', base_plan_version: 1, user_message_refs: [ref],
    summary: '新增全书交付约束', affected_section_ids: [], sections: [],
    global_instructions: ['全书统一使用已核实的项目名称。'],
  } })
  if (call.capability !== 'writing.plan') throw new Error('test call mismatch')
  await expect(executeWritingPlanCapability(call, context(workspace,
    '全书统一使用已核实的项目名称。', new Set(['SEC-2']))))
    .rejects.toThrow('BID_WRITING_PLAN_SCOPE_INVALID')
  const result = await executeWritingPlanCapability(call, context(workspace,
    '全书统一使用已核实的项目名称。'))
  expect(result.result.target_section_ids).toEqual(['SEC-1', 'SEC-2', 'SEC-3'])
})
