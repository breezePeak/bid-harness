import { describe, expect, it } from 'vitest'
import type { BidClientProjection, BidStage, DocxExportOperation } from '@deepseek-ai/dsh-bid/control-plane'
import { buildBidStagePlan, buildDocxExportPlan } from '../src/client/bid-stage-plan.ts'
import { zh } from '../src/client/locales.ts'

const t = (key: keyof typeof zh): string => zh[key]

function projection(stage: BidStage, phase?: string): Pick<BidClientProjection, 'task'> {
  return {
    task: { stage, status: 'running', run: {
      runId: 'run', epoch: 1, baseProjectRevision: 1,
      work: {
        kind: 'stage_execution', workId: 'work', stage,
        requestRef: 'request.json', requestSha256: '0'.repeat(64), inputFingerprint: '1'.repeat(64),
      },
      startedAt: 1, updatedAt: 2,
      ...(phase === undefined ? {} : { progress: { phase, summary: phase, updatedAt: 2 } }),
    } },
  }
}

describe('buildBidStagePlan', () => {
  it('独立 S6 事件沿用三个步骤，并在完成后全部结算', () => {
    const base = { operationId: 'export-1', templateId: null, startedAt: 1, updatedAt: 2, message: '正在生成' }
    const running: DocxExportOperation = { ...base, status: 'running', phase: 'exporting' }
    expect(buildDocxExportPlan(running, t).map(item => item.status))
      .toEqual(['completed', 'in_progress', 'pending'])
    const completed: DocxExportOperation = { ...base, status: 'completed', phase: 'finalizing', path: 'output/a.docx', warnings: [] }
    expect(buildDocxExportPlan(completed, t).map(item => item.status))
      .toEqual(['completed', 'completed', 'completed'])
  })
  it.each(['waiting_user', 'completed'] as const)('S4 %s 保留全部完成的计划', (status) => {
    const current = projection('evidence_mapping', 'reviewing')
    expect(buildBidStagePlan({ task: { ...current.task, status, run: null } }, t).map(item => item.status))
      .toEqual(['completed', 'completed', 'completed'])
  })

  it.each([
    ['analyzing', ['in_progress', 'pending', 'pending', 'pending', 'pending']],
    ['generating', ['completed', 'in_progress', 'pending', 'pending', 'pending']],
    ['validating', ['completed', 'completed', 'in_progress', 'pending', 'pending']],
    ['reviewing', ['completed', 'completed', 'completed', 'in_progress', 'pending']],
  ] as const)('S3 的 %s 只完成已经经过的步骤', (phase, statuses) => {
    expect(buildBidStagePlan(projection('outline_generation', phase), t).map(item => item.status)).toEqual(statuses)
  })

  it.each([
    ['file_intake', undefined, '接收并解析项目资料'],
    ['tender_analysis', 'collecting', '整理项目、技术、评分与合规信息'],
    ['outline_generation', 'reviewing', '目录质量复核'],
    ['evidence_mapping', 'mapping', '逐章节资料研究与映射'],
    ['chapter_writing', 'finalizing', '全局合规复核'],
    ['docx_export', 'exporting', '生成 Word'],
  ] as const)('maps %s phase %s to its active stage step', (stage, phase, activeContent) => {
    const items = buildBidStagePlan(projection(stage, phase), t)
    expect(items.find(item => item.status === 'in_progress')?.content).toBe(activeContent)
    const active = items.findIndex(item => item.status === 'in_progress')
    expect(items.slice(0, active).every(item => item.status === 'completed')).toBe(true)
    expect(items.slice(active + 1).every(item => item.status === 'pending')).toBe(true)
  })

  it('shows S3 resume progress and inserts the repair step only while repair is active', () => {
    expect(buildBidStagePlan(projection('outline_generation', 'validating'), t).map(item => item.status))
      .toEqual(['completed', 'completed', 'in_progress', 'pending', 'pending'])
    const repairing = buildBidStagePlan(projection('outline_generation', 'repairing'), t)
    expect(repairing.map(item => item.content)).toContain('修正目录确定性问题')
    expect(repairing.find(item => item.status === 'in_progress')?.content).toBe('修正目录确定性问题')
  })
})
