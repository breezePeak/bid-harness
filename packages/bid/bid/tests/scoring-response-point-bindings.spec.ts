import { describe, expect, it } from 'vitest'
import { bindSectionResponsePoints } from '../src/scoring-response-point-bindings.ts'
import { parseScoringResponsePointCatalog } from '../src/scoring-response-point-artifacts.ts'

const catalog = parseScoringResponsePointCatalog({
  schema_version: 1, scope: 'technical_bid', scoring_sha256: 'a'.repeat(64), next_sequence: 4,
  points: [
    { id: 'RP-000001', scoring_id: 'SC-001', order: 1, text: '说明实施方法' },
    { id: 'RP-000002', scoring_id: 'SC-001', order: 2, text: '说明成果验收' },
    { id: 'RP-000003', scoring_id: 'SC-002', order: 1, text: '说明交付安排' },
  ],
})

describe('正式响应点的评分关联绑定', () => {
  it('保留显式评分项，按选择顺序补齐并去重所属评分项和生成文字快照', () => {
    expect(bindSectionResponsePoints(['SC-003'], ['RP-000003', 'RP-000002', 'RP-000001'], catalog)).toEqual({
      scoring_ids: ['SC-003', 'SC-002', 'SC-001'],
      scoring_response_points: [
        { scoring_id: 'SC-002', response_point: '说明交付安排' },
        { scoring_id: 'SC-001', response_point: '说明成果验收' },
        { scoring_id: 'SC-001', response_point: '说明实施方法' },
      ],
    })
  })

  it('未知响应点不能通过删除引用或猜测所属评分项完成绑定', () => {
    expect(() => bindSectionResponsePoints(['SC-001'], ['RP-000001', 'RP-999999'], catalog))
      .toThrow('未知评分响应点 RP-999999')
  })
})
