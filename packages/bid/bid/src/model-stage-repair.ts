import type { StageValidationIssue } from './control-plane-contract.ts'

/** Default number of Validator-guided repair turns for one model-produced Bid stage. */
export const DEFAULT_MODEL_STAGE_REPAIR_ATTEMPTS = 3

/** Host-owned repair limit shared by model-produced Bid stages. */
export interface ModelStageExecutionOptions {
  /** Maximum Validator-guided repair turns after the initial model output. */
  maxRepairAttempts: number
}

/**
 * Render browser-safe Validator issues without exposing Artifact contents.
 * @param issues - Host-produced validation issues for one model stage.
 * @returns compact lines suitable for a repair assignment.
 */
export function renderStageRepairIssues(issues: readonly StageValidationIssue[]): string[] {
  return issues.map((issue, index) => [
    `${index + 1}. ${issue.code}`,
    issue.artifact === undefined ? undefined : `文件=${issue.artifact}`,
    issue.path === undefined ? undefined : `字段=${issue.path}`,
    issue.message,
  ].filter(value => value !== undefined).join(' | '))
}
