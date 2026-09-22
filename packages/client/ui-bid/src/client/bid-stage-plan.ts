import type { BidClientProjection, BidStage } from '@deepseek-ai/dsh-bid/control-plane'
import type { PlanListItem } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BidKey } from './locales.ts'

interface StagePlanStep {
  readonly key: string
  readonly label: BidKey
  readonly phases: readonly string[]
}

type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string

const STAGE_STEPS = {
  file_intake: [
    { key: 'processing', label: 'plan.file_intake.processing', phases: ['starting'] },
  ],
  tender_analysis: [
    { key: 'locating', label: 'plan.tender.locating', phases: ['starting', 'locating'] },
    { key: 'collecting', label: 'plan.tender.collecting', phases: ['collecting'] },
    { key: 'validating', label: 'plan.tender.validating', phases: ['validating'] },
  ],
  outline_generation: [
    { key: 'analyzing', label: 'plan.outline.analyzing', phases: ['starting', 'analyzing'] },
    { key: 'generating', label: 'plan.outline.generating', phases: ['generating'] },
    { key: 'validating', label: 'plan.outline.validating', phases: ['validating'] },
    { key: 'reviewing', label: 'plan.outline.reviewing', phases: ['reviewing'] },
    { key: 'finalizing', label: 'plan.outline.finalizing', phases: ['finalizing'] },
  ],
  evidence_mapping: [
    { key: 'preparing', label: 'plan.mapping.preparing', phases: ['starting'] },
    { key: 'mapping', label: 'plan.mapping.mapping', phases: ['mapping'] },
    { key: 'reviewing', label: 'plan.mapping.reviewing', phases: ['reviewing'] },
  ],
  chapter_writing: [
    { key: 'planning', label: 'plan.writing.planning', phases: ['starting'] },
    { key: 'writing', label: 'plan.writing.writing', phases: ['writing'] },
    { key: 'reviewing', label: 'plan.writing.reviewing', phases: ['reviewing'] },
    { key: 'finalizing', label: 'plan.writing.finalizing', phases: ['finalizing'] },
    { key: 'completing', label: 'plan.writing.completing', phases: ['completing'] },
  ],
  docx_export: [
    { key: 'collecting', label: 'plan.export.collecting', phases: ['starting', 'collecting'] },
    { key: 'exporting', label: 'plan.export.exporting', phases: ['exporting'] },
    { key: 'finalizing', label: 'plan.export.finalizing', phases: ['finalizing'] },
  ],
} as const satisfies Record<BidStage, readonly StagePlanStep[]>

const REPAIR_STEPS = {
  tender_analysis: { key: 'repairing', label: 'plan.tender.repairing', phases: ['repairing'] },
  outline_generation: { key: 'repairing', label: 'plan.outline.repairing', phases: ['repairing'] },
  chapter_writing: { key: 'repairing', label: 'plan.writing.repairing', phases: ['repairing'] },
} as const satisfies Partial<Record<BidStage, StagePlanStep>>

function stepsFor(stage: BidStage, phase: string): readonly StagePlanStep[] {
  const steps: readonly StagePlanStep[] = STAGE_STEPS[stage]
  const repair = REPAIR_STEPS[stage as keyof typeof REPAIR_STEPS]
  if (phase !== 'repairing' || repair === undefined) return steps
  const insertAfter = stage === 'chapter_writing' ? 3 : 2
  return [...steps.slice(0, insertAfter), repair, ...steps.slice(insertAfter)]
}

/** Project the latest Host milestone onto the stage's ordered display steps. */
export function buildBidStagePlan(
  projection: Pick<BidClientProjection, 'task'>,
  t: TranslateBid,
): readonly PlanListItem[] {
  const phase = projection.task.run?.progress?.phase ?? 'starting'
  const steps = stepsFor(projection.task.stage, phase)
  const matched = steps.findIndex(step => step.phases.includes(phase))
  const active = matched < 0 ? 0 : matched
  return steps.map((step, index) => ({
    key: step.key,
    content: t(step.label),
    status: index < active ? 'completed' : index === active ? 'in_progress' : 'pending',
  }))
}
