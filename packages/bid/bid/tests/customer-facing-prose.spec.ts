import { describe, expect, it } from 'vitest'
import { customerFacingOutlineText, findBidInternalIdentifiers } from '../src/customer-facing-prose.ts'

const context = {
  outline: { sections: [{ id: 'SEC-001' }] },
  requirements: { requirements: [{ id: 'REQ-003', raw_text: '系统应提供审计功能。' }] },
  scoring: { scoring_items: [{ id: 'SC-001', raw_text: '技术方案完整得分。' }] },
  compliance: { compliance_items: [{ id: 'COM-001', raw_text: '响应单位应具备相关资质。' }] },
  responsePoints: { points: [{ id: 'RP-000001' }] },
  acceptanceCriterionIds: ['AC-000001'],
}

describe('标书客户可见文本', () => {
  it('识别紧邻中文的系统身份，并忽略较长业务标识的一部分', () => {
    expect(findBidInternalIdentifiers('对应REQ-003、COM-001，内部为SEC-001和AC-000001。', context))
      .toEqual(['REQ-003', 'COM-001', 'SEC-001', 'AC-000001'])
    expect(findBidInternalIdentifiers('| 需求名称 | 响应措施 |\n| --- | --- |\n| SC-001 | 建立审计机制 |', context))
      .toEqual(['SC-001'])
    expect(findBidInternalIdentifiers('业务编号XREQ-003-A可正常显示。', context)).toEqual([])
    expect(findBidInternalIdentifiers('我方建立角色权限和操作审计机制。', context)).toEqual([])
  })

  it('保留招标原文已有的采购方编号', () => {
    const purchaserContext = {
      ...context,
      requirements: { requirements: [{ id: 'REQ-003', raw_text: '按采购方条款 REQ-003 提供审计功能。' }] },
    }
    expect(findBidInternalIdentifiers('对应采购方条款REQ-003。', purchaserContext)).toEqual([])
  })

  it('只返回会进入预览和导出的目录字段', () => {
    expect(customerFacingOutlineText({
      document_title: '技术标',
      sections: [{ title: '实施方案', summary: '我方按计划实施。' }],
    })).toEqual([
      { text: '技术标', path: 'document_title' },
      { text: '实施方案', path: 'sections.0.title' },
      { text: '我方按计划实施。', path: 'sections.0.summary' },
    ])
  })
})
