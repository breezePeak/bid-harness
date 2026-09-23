import { expect, it } from 'vitest'
import type { BidCapabilityPlanView } from '@deepseek-ai/dsh-bid/control-plane'
import { buildCapabilityTaskPlan } from '../src/client/bid-stage-plan.ts'
import { zh } from '../src/client/locales.ts'

it('按能力 Work 检查点显示真实步骤，不把等待输入和失败显示成完成', () => {
  const plan: BidCapabilityPlanView = {
    workId: 'work', title: '拆分第三章并补写', scope: 'chapter-3', status: 'awaiting_input',
    steps: [
      { id: '1', capability: 'outline.update', status: 'completed', detail: null },
      { id: '2', capability: 'chapter.reorganize', status: 'completed', detail: null },
      { id: '3', capability: 'evidence.research', status: 'awaiting_input', detail: '缺少来源' },
      { id: '4', capability: 'chapter.write', status: 'pending', detail: null },
      { id: '5', capability: 'chapter.review', status: 'pending', detail: null },
    ],
  }
  const items = buildCapabilityTaskPlan(plan, key => zh[key])
  expect(items.map(item => item.content)).toEqual([
    '修改目录', '迁移章节原文', '补充资料研究', '编写章节', '审核章节',
  ])
  expect(items.map(item => item.status)).toEqual([
    'completed', 'completed', 'in_progress', 'pending', 'pending',
  ])
  expect(buildCapabilityTaskPlan({ ...plan, status: 'failed', steps: [
    ...plan.steps.slice(0, 2), { ...plan.steps[2]!, status: 'failed' }, ...plan.steps.slice(3),
  ] }, key => zh[key]).map(item => item.status)[2]).toBe('in_progress')
})
