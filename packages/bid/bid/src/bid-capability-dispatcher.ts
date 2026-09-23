/** Host 内建能力分派器把公共调用交给现有业务适配器与精确文件许可。 */
import type { CapabilityTaskDispatcher } from './bid-capability-task.ts'
import type { BidCapabilityExecutionContext } from './bid-capability-contract.ts'
import { allowedOutlineCapabilityWrites, executeOutlineCapability, validateOutlineCapability } from './bid-outline-capabilities.ts'
import { allowedEvidenceCapabilitySourceWrites, allowedEvidenceCapabilityWrites,
  executeEvidenceCapability, validateEvidenceCapability } from './bid-evidence-capability.ts'
import { allowedWritingCapabilitySourceWrites, allowedWritingCapabilityWrites,
  executeWritingCapability, validateWritingCapability } from './bid-writing-capability.ts'
import { allowedWritingPlanCapabilityWrites, executeWritingPlanCapability,
  validateWritingPlanCapability } from './bid-writing-plan-capability.ts'
import { allowedTenderUpdateCapabilityWrites, executeTenderUpdateCapability,
  validateTenderUpdateCapability } from './bid-tender-update-capability.ts'

/** 与阶段执行器一致的 Host 配置，来源于已验证的 cordis.yml。 */
export interface CapabilityDispatcherSettings {
  readonly modelStageRepairAttempts: number
  readonly evidenceMappingMaxConcurrency: number
  readonly chapterWritingMaxConcurrency: number
  readonly webSearchEnabled: boolean
}

/**
 * 以已注册能力适配器执行一个 Work 的有序步骤。
 * @param settings 当前 Host 的并发、修复与 Web 配置。
 * @returns 具备文件许可、执行和候选校验的分派器。
 */
export function createBidCapabilityDispatcher(settings: CapabilityDispatcherSettings): CapabilityTaskDispatcher {
  return {
    allowedWrites(call, sectionIds, working, stepId) {
      switch (call.capability) {
        case 'tender.update': return Promise.resolve(allowedTenderUpdateCapabilityWrites())
        case 'outline.update':
        case 'outline.refine':
        case 'chapter.reorganize': return allowedOutlineCapabilityWrites(call, working, stepId, sectionIds)
        case 'evidence.research': return Promise.resolve(allowedEvidenceCapabilityWrites())
        case 'writing.plan': return Promise.resolve(allowedWritingPlanCapabilityWrites())
        case 'chapter.write':
        case 'chapter.review': return allowedWritingCapabilityWrites(working, sectionIds)
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
        case 'evidence.research': return allowedEvidenceCapabilitySourceWrites(working)
        case 'chapter.write':
        case 'chapter.revise':
        case 'chapter.review': return allowedWritingCapabilitySourceWrites(working)
        default: return Promise.resolve(new Set<string>())
      }
    },
    execute(call, context) {
      switch (call.capability) {
        case 'tender.update': return executeTenderUpdateCapability(call, context)
        case 'outline.update':
        case 'outline.refine':
        case 'chapter.reorganize': return executeOutlineCapability(call, context)
        case 'evidence.research': return executeEvidenceCapability(call, context, {
          maxRepairAttempts: settings.modelStageRepairAttempts,
          maxConcurrency: settings.evidenceMappingMaxConcurrency,
          webSearchEnabled: settings.webSearchEnabled,
        })
        case 'writing.plan': return executeWritingPlanCapability(call, context)
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
        case 'tender.update': return validateTenderUpdateCapability(context)
        case 'outline.update':
        case 'outline.refine':
        case 'chapter.reorganize': return validateOutlineCapability(context, result)
        case 'evidence.research': return validateEvidenceCapability(context, result)
        case 'writing.plan': return validateWritingPlanCapability(context)
        case 'chapter.write':
        case 'chapter.revise':
        case 'chapter.review': return validateWritingCapability(context, result.target_section_ids)
        default: throw new Error(`BID_CAPABILITY_ADAPTER_UNAVAILABLE: ${call.capability}`)
      }
    },
  }
}
