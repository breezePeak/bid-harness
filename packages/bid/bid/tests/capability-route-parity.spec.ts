import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBidStageTask } from '../src/runtime-state.ts'
import {
  defaultBidCapabilityForStage,
  executeDefaultBidCapability,
  validateDefaultBidCapability,
  type DefaultBidCapabilityContext,
} from '../src/bid-capability-registry.ts'

const calls = vi.hoisted(() => ({
  tender: vi.fn(async () => []),
  outline: vi.fn(async () => []),
  evidence: vi.fn(async () => []),
  chapter: vi.fn(async () => []),
  tenderValidation: vi.fn(async () => ({ ok: true })),
  outlineValidation: vi.fn(async () => ({ ok: true })),
  evidenceValidation: vi.fn(async () => ({ ok: true })),
  chapterValidation: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../src/tender-analysis-executor.ts', () => ({ executeTenderAnalysis: calls.tender }))
vi.mock('../src/outline-generation-executor.ts', () => ({ executeOutlineGeneration: calls.outline }))
vi.mock('../src/evidence-mapping-executor.ts', () => ({ executeEvidenceMapping: calls.evidence }))
vi.mock('../src/chapter-writing-executor.ts', () => ({ executeChapterWriting: calls.chapter }))
vi.mock('../src/tender-analysis-validator.ts', () => ({ validateTenderAnalysis: calls.tenderValidation }))
vi.mock('../src/outline-generation-validator.ts', () => ({ validateOutlineGeneration: calls.outlineValidation }))
vi.mock('../src/evidence-mapping-validator.ts', () => ({ validateEvidenceMapping: calls.evidenceValidation }))
vi.mock('../src/chapter-writing-validator.ts', () => ({ validateChapterWriting: calls.chapterValidation }))

beforeEach(() => { vi.clearAllMocks() })

describe('默认能力路线', () => {
  it('维持 S2、S3、S4、S5 的顺序及独立的 S1、S6 边界', () => {
    expect(['file_intake', 'tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing', 'docx_export']
      .map(stage => defaultBidCapabilityForStage(stage as Parameters<typeof defaultBidCapabilityForStage>[0])))
      .toEqual([undefined, 'tender.analyze', 'outline.generate', 'evidence.research', 'chapter.write', undefined])
  })

  it('每项默认能力只调用一次原执行器及对应 Validator，保留 Run、预算和并发', async () => {
    const agent = { id: 'execution-agent' }
    const workspace = { projectRoot: 'test-project' }
    const run = { work: { workId: 'work-1' } }
    const writingControl = { bind: vi.fn() }
    const recovery = { workId: 'work-1', unit: 'section', instruction: '继续', issues: [] }
    const context = {
      agent, workspace, run, writingControl, recovery,
      maxRepairAttempts: 3,
      evidenceMappingMaxConcurrency: 2,
      chapterWritingMaxConcurrency: 4,
      chapterWritingCompletionRepairRounds: 5,
      webSearchEnabled: true,
    } as unknown as DefaultBidCapabilityContext
    const stages = [
      ['tender_analysis', 'tender.analyze', calls.tender, calls.tenderValidation],
      ['outline_generation', 'outline.generate', calls.outline, calls.outlineValidation],
      ['evidence_mapping', 'evidence.research', calls.evidence, calls.evidenceValidation],
      ['chapter_writing', 'chapter.write', calls.chapter, calls.chapterValidation],
    ] as const
    for (const [stage, capability, executor, validator] of stages) {
      const task = buildBidStageTask(stage)
      await executeDefaultBidCapability(capability, task, context)
      expect(executor).toHaveBeenCalledOnce()
      expect(executor).toHaveBeenCalledWith(agent, workspace, task, expect.objectContaining({ run, recovery, maxRepairAttempts: 3 }))
      await validateDefaultBidCapability(capability, workspace as DefaultBidCapabilityContext['workspace'], stage, [])
      expect(validator).toHaveBeenCalledOnce()
      expect(validator).toHaveBeenCalledWith(workspace, stage, [])
    }
    expect(calls.evidence).toHaveBeenCalledWith(agent, workspace, buildBidStageTask('evidence_mapping'),
      expect.objectContaining({ maxConcurrency: 2, webSearchEnabled: true }))
    expect(calls.chapter).toHaveBeenCalledWith(agent, workspace, buildBidStageTask('chapter_writing'),
      expect.objectContaining({ maxConcurrency: 4, maxCompletionRepairRounds: 5, webSearchEnabled: true, control: writingControl }))
  })
})
