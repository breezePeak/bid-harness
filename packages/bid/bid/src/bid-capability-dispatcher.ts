/** Host 内建能力分派器把公共调用交给现有业务适配器与精确文件许可。 */
import type { CapabilityTaskDispatcher } from './bid-capability-task.ts'
import type { BidCapabilityExecutionContext } from './bid-capability-contract.ts'
import type { BidStage, BidStageTask, StageArtifact, StageValidationResult } from './control-plane-contract.ts'
import type { BidWorkspace } from './index.ts'
import { defaultBidCapabilityForStage, executeDefaultBidCapability, validateDefaultBidCapability,
  type DefaultBidCapabilityContext } from './bid-capability-registry.ts'
import { allowedOutlineCapabilityWrites, executeOutlineCapability, validateOutlineCapability } from './bid-outline-capabilities.ts'
import { allowedEvidenceCapabilitySourceWrites, allowedEvidenceCapabilityWrites,
  executeEvidenceCapability, validateEvidenceCapability } from './bid-evidence-capability.ts'
import { allowedWritingCapabilitySourceWrites, allowedWritingCapabilityWrites,
  executeWritingCapability, validateWritingCapability } from './bid-writing-capability.ts'
import { allowedWritingPlanCapabilityWrites, executeWritingPlanCapability,
  validateWritingPlanCapability } from './bid-writing-plan-capability.ts'
import { allowedTenderUpdateCapabilityWrites, executeTenderUpdateCapability,
  validateTenderUpdateCapability } from './bid-tender-update-capability.ts'
import { allowedDocumentReviewWrites, executeDocumentReviewCapability,
  validateDocumentReviewCapability } from './bid-document-review-capability.ts'
import { allowedGenerationWrites, executeGenerationCapability,
  validateGenerationCapability } from './bid-generation-capability.ts'

/** 与阶段执行器一致的 Host 配置，来源于已验证的 cordis.yml。 */
export interface CapabilityDispatcherSettings {
  readonly modelStageRepairAttempts: number
  readonly evidenceMappingMaxConcurrency: number
  readonly chapterWritingMaxConcurrency: number
  readonly webSearchEnabled: boolean
}

/** 默认整本阶段与局部任务共用的 Host 分派入口。 */
export interface BidCapabilityDispatcher extends CapabilityTaskDispatcher {
  /** 将默认阶段交给其固定能力执行器；确认和 Run 结算仍归 Orchestrator。 */
  executeDefault(task: BidStageTask, context: DefaultBidCapabilityContext): Promise<StageArtifact[]>
  /** 校验默认阶段的完整产物。 */
  validateDefault(stage: BidStage, workspace: BidWorkspace, artifacts: StageArtifact[]): Promise<StageValidationResult>
}

/**
 * 以已注册能力适配器执行一个 Work 的有序步骤。
 * @param settings 当前 Host 的并发、修复与 Web 配置。
 * @returns 具备文件许可、执行和候选校验的分派器。
 */
export function createBidCapabilityDispatcher(settings: CapabilityDispatcherSettings): BidCapabilityDispatcher {
  return {
    executeDefault(task, context) {
      const capability = defaultBidCapabilityForStage(task.stage)
      if (capability === undefined) throw new Error(`BID_DEFAULT_CAPABILITY_UNAVAILABLE: ${task.stage}`)
      return executeDefaultBidCapability(capability, task, context)
    },
    validateDefault(stage, workspace, artifacts) {
      const capability = defaultBidCapabilityForStage(stage)
      if (capability === undefined) throw new Error(`BID_DEFAULT_CAPABILITY_UNAVAILABLE: ${stage}`)
      return validateDefaultBidCapability(capability, workspace, stage, artifacts)
    },
    allowedWrites(call, sectionIds, working, stepId) {
      switch (call.capability) {
        case 'tender.analyze':
        case 'outline.generate': return Promise.resolve(allowedGenerationWrites(call, sectionIds))
        case 'tender.update': return Promise.resolve(allowedTenderUpdateCapabilityWrites())
        case 'outline.update':
        case 'chapter.reorganize': return allowedOutlineCapabilityWrites(call, working, stepId, sectionIds)
        case 'outline.refine': return Promise.resolve(allowedEvidenceCapabilityWrites())
        case 'evidence.research': return Promise.resolve(allowedEvidenceCapabilityWrites())
        case 'writing.plan': return Promise.resolve(allowedWritingPlanCapabilityWrites())
        case 'document.review': {
          if (sectionIds !== null) throw new Error('BID_DOCUMENT_REVIEW_PROJECT_SCOPE_REQUIRED')
          return Promise.resolve(allowedDocumentReviewWrites())
        }
        case 'chapter.write': return allowedWritingCapabilityWrites(working, sectionIds)
        case 'chapter.review': return allowedWritingCapabilityWrites(working, sectionIds, 'review')
        case 'chapter.revise': {
          const id = call.input.reference.section_id
          if (sectionIds !== null && !sectionIds.has(id)) throw new Error('BID_CHAPTER_REVISION_SCOPE_INVALID')
          return allowedWritingCapabilityWrites(working, new Set([id]))
        }
        default: throw new Error(`BID_CAPABILITY_ADAPTER_UNAVAILABLE: ${call.capability}`)
      }
    },
    allowedWritesAfter(call, working) {
      switch (call.capability) {
        case 'outline.refine':
        case 'evidence.research': return allowedEvidenceCapabilitySourceWrites(working)
        case 'chapter.write':
        case 'chapter.revise': return allowedWritingCapabilitySourceWrites(working)
        case 'chapter.review': return Promise.resolve(new Set<string>())
        default: return Promise.resolve(new Set<string>())
      }
    },
    execute(call, context) {
      switch (call.capability) {
        case 'tender.analyze':
        case 'outline.generate': return executeGenerationCapability(call, context, settings.modelStageRepairAttempts)
        case 'tender.update': return executeTenderUpdateCapability(call, context)
        case 'outline.update':
        case 'chapter.reorganize': return executeOutlineCapability(call, context)
        case 'outline.refine': return executeEvidenceCapability({ capability: 'evidence.research', input: {
          mode: 'supplement', reason: call.input.feedback, allow_outline_refinement: true,
        } }, context, {
          maxRepairAttempts: settings.modelStageRepairAttempts,
          maxConcurrency: settings.evidenceMappingMaxConcurrency,
          webSearchEnabled: settings.webSearchEnabled,
        })
        case 'evidence.research': return executeEvidenceCapability(call, context, {
          maxRepairAttempts: settings.modelStageRepairAttempts,
          maxConcurrency: settings.evidenceMappingMaxConcurrency,
          webSearchEnabled: settings.webSearchEnabled,
        })
        case 'writing.plan': return executeWritingPlanCapability(call, context)
        case 'document.review': return executeDocumentReviewCapability(context, settings.modelStageRepairAttempts)
        case 'chapter.write':
        case 'chapter.revise':
        case 'chapter.review': return executeWritingCapability(call, context, {
          maxRepairAttempts: settings.modelStageRepairAttempts,
          maxConcurrency: settings.chapterWritingMaxConcurrency,
          webSearchEnabled: settings.webSearchEnabled,
        })
        default: throw new Error(`BID_CAPABILITY_ADAPTER_UNAVAILABLE: ${call.capability}`)
      }
    },
    async validate(call, context: BidCapabilityExecutionContext, result) {
      switch (call.capability) {
        case 'tender.analyze':
        case 'outline.generate': return validateGenerationCapability(call, context)
        case 'tender.update': return validateTenderUpdateCapability(context)
        case 'outline.update':
        case 'chapter.reorganize': return validateOutlineCapability(context, result)
        case 'outline.refine': {
          await validateEvidenceCapability(context, result)
          return validateOutlineCapability(context, result)
        }
        case 'evidence.research': return validateEvidenceCapability(context, result)
        case 'writing.plan': return validateWritingPlanCapability(context)
        case 'document.review': return validateDocumentReviewCapability(context)
        case 'chapter.write':
        case 'chapter.revise':
        case 'chapter.review': return validateWritingCapability(context, result.target_section_ids, result.needs_input)
        default: throw new Error(`BID_CAPABILITY_ADAPTER_UNAVAILABLE: ${call.capability}`)
      }
    },
  }
}
