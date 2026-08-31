import { describe, expect, it } from 'vitest'
import {
  applyTenderAnalysisEdits,
  parseTenderAnalysisEditOperations,
  type TenderAnalysisConfirmationView,
} from '@deepseek-ai/dsh-bid'

const source = {
  file_id: 'tender', chunk: 'corpus/tender/chunks/chunk_0001.md', line_start: 1, line_end: 2,
}
const analysis: TenderAnalysisConfirmationView = {
  project: {
    schema_version: 1,
    project_name: '原项目', tender_name: '招标', purchaser: '采购人', owner: '建设单位',
    project_background: ['原背景'], project_objectives: ['原目标'], project_scope: ['建设平台'],
    technical_scope: ['总体架构'], delivery_scope: ['部署交付'], implementation_constraints: ['三个月上线'],
    key_technical_points: ['安全架构'], source_refs: [source], analyzed_tender_files: ['tender'],
  },
  scoring: {
    schema_version: 1,
    scoring_items: [{
      id: 'SCORE-1', parent: null, group: '技术评分', title: '总体方案', raw_text: '总体方案完整得 10 分',
      criterion: '方案完整可行', score: 10, score_range: null, must_answer: true,
      response_points: ['总体架构'], source_refs: [source],
    }],
  },
}

describe('tender-analysis confirmation edits', () => {
  it('updates only editable project and scoring conclusions', () => {
    const edited = applyTenderAnalysisEdits(analysis, parseTenderAnalysisEditOperations([
      { type: 'update_project', fields: { key_technical_points: ['安全架构', '兼容既有系统'] } },
      { type: 'update_scoring_item', scoring_id: 'SCORE-1', criterion: '方案完整、可行且可落地', response_points: ['总体架构', '实施路径'] },
    ]))

    expect(edited.project.key_technical_points).toEqual(['安全架构', '兼容既有系统'])
    expect(edited.scoring.scoring_items[0]).toMatchObject({
      criterion: '方案完整、可行且可落地', response_points: ['总体架构', '实施路径'],
      raw_text: '总体方案完整得 10 分', source_refs: [source], score: 10,
    })
  })

  it('rejects source-truth fields, unknown scoring ids, and empty response points', () => {
    expect(() => parseTenderAnalysisEditOperations([{
      type: 'update_scoring_item', scoring_id: 'SCORE-1', raw_text: '伪造原文',
    }])).toThrow()
    expect(() => parseTenderAnalysisEditOperations([{
      type: 'update_project', fields: { source_refs: [] },
    }])).toThrow()
    expect(() => parseTenderAnalysisEditOperations([{
      type: 'update_scoring_item', scoring_id: 'SCORE-1', response_points: [],
    }])).toThrow()
    expect(() => applyTenderAnalysisEdits(analysis, [{
      type: 'update_scoring_item', scoring_id: 'SCORE-X', criterion: '无效',
    }])).toThrow('unknown tender scoring item')
  })
})
