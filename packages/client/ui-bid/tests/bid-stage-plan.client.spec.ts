import { describe, expect, it } from 'vitest'
import type { BidClientProjection, BidStage } from '@deepseek-ai/dsh-bid/control-plane'
import { buildBidStagePlan } from '../src/client/bid-stage-plan.ts'
import { zh } from '../src/client/locales.ts'

const t = (key: keyof typeof zh): string => zh[key]

function projection(stage: BidStage, phase?: string): Pick<BidClientProjection, 'runtime' | 'run'> {
  return {
    runtime: { stage, status: 'running' },
    run: phase === undefined ? null : {
      runId: 'run', stage, epoch: 1, baseProjectRevision: 1,
      work: {
        kind: 'stage_execution', workId: 'work', stage,
        requestRef: 'request.json', requestSha256: '0'.repeat(64), inputFingerprint: '1'.repeat(64),
      },
      status: 'running', startedAt: 1, updatedAt: 2,
      progress: { phase, summary: phase, updatedAt: 2 },
    },
  }
}

describe('buildBidStagePlan', () => {
  it.each([
    ['file_intake', undefined, '接收并解析项目资料'],
    ['tender_analysis', 'collecting', '整理项目、技术、评分与合规信息'],
    ['outline_generation', 'reviewing', '目录质量复核'],
    ['evidence_mapping', 'mapping', '逐章节资料研究与映射'],
    ['chapter_writing', 'finalizing', '全局合规复核'],
    ['docx_export', 'exporting', '生成并检查 Word 文档'],
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
