/** Repair actions supported by the S5 browser. */
export type OutlineConfirmationRepairAction = 'reload_draft' | 'restore_server_draft' | 'focus_section' | 'retry_save' | 'retry_confirm'

/** Stage ownership and browser recovery for one S5 blocking issue. */
export interface OutlineConfirmationIssueDefinition {
  readonly owner: 'shared_structure' | 'shared_coverage' | 'outline_confirmation'
  readonly user_visible: true
  readonly user_editable: boolean
  readonly repair_action: OutlineConfirmationRepairAction
}

const sharedStructure = (user_editable = true): OutlineConfirmationIssueDefinition => ({ owner: 'shared_structure', user_visible: true, user_editable, repair_action: user_editable ? 'focus_section' : 'restore_server_draft' })
const sharedCoverage = (): OutlineConfirmationIssueDefinition => ({ owner: 'shared_coverage', user_visible: true, user_editable: false, repair_action: 'restore_server_draft' })
const confirmation = (repair_action: OutlineConfirmationRepairAction): OutlineConfirmationIssueDefinition => ({ owner: 'outline_confirmation', user_visible: true, user_editable: false, repair_action })

/** Exhaustive registry of issues that S5 validators and mutations may return. */
export const OUTLINE_CONFIRMATION_ISSUES = {
  OUTLINE_SHARED_SECTION_ID_DUPLICATE: sharedStructure(false), OUTLINE_SHARED_SECTION_SELF_PARENT: sharedStructure(),
  OUTLINE_SHARED_SECTION_PARENT_UNKNOWN: sharedStructure(), OUTLINE_SHARED_SECTION_LEVEL_INVALID: sharedStructure(),
  OUTLINE_SHARED_SECTION_ORDER_DUPLICATE: sharedStructure(), OUTLINE_SHARED_SECTION_TITLE_DUPLICATE: sharedStructure(),
  OUTLINE_SHARED_WRITABLE_NOT_LEAF: sharedStructure(), OUTLINE_SHARED_CONTAINER_EMPTY: sharedStructure(),
  OUTLINE_SHARED_MUST_ANSWER_MISSING: sharedStructure(), OUTLINE_SHARED_CONTAINER_MUST_ANSWER_INVALID: sharedStructure(),
  OUTLINE_SHARED_SECTION_REFERENCE_DUPLICATE: sharedStructure(), OUTLINE_SHARED_SECTION_CYCLE: sharedStructure(),
  OUTLINE_SHARED_REQUIREMENT_UNKNOWN: sharedCoverage(), OUTLINE_SHARED_REQUIREMENT_MISSING: sharedCoverage(),
  OUTLINE_SHARED_REQUIREMENT_WRITABLE_MISSING: sharedCoverage(), OUTLINE_SHARED_SCORING_UNKNOWN: sharedCoverage(),
  OUTLINE_SHARED_SCORING_MISSING: sharedCoverage(), OUTLINE_SHARED_SCORING_WRITABLE_MISSING: sharedCoverage(),
  OUTLINE_SHARED_COMPLIANCE_UNKNOWN: sharedCoverage(), OUTLINE_SHARED_COMPLIANCE_MISSING: sharedCoverage(),
  OUTLINE_SHARED_COMPLIANCE_DUPLICATE: sharedCoverage(), OUTLINE_SHARED_SOURCE_MAPPING_UNKNOWN: sharedCoverage(),
  OUTLINE_SHARED_SOURCE_MAPPING_MISSING: sharedCoverage(), OUTLINE_SHARED_RESPONSE_POINT_UNKNOWN: sharedCoverage(),
  OUTLINE_SHARED_RESPONSE_POINT_MISSING: sharedCoverage(), OUTLINE_SHARED_RESPONSE_POINT_DUPLICATE: sharedCoverage(),
  OUTLINE_SHARED_RESPONSE_POINT_TEXT_MISMATCH: sharedCoverage(), OUTLINE_SHARED_RESPONSE_POINT_SCORING_MISSING: sharedCoverage(),
  OUTLINE_SHARED_CONTAINER_EVIDENCE_INVALID: sharedCoverage(), OUTLINE_SHARED_RESPONSE_POINT_CATALOG_MISMATCH: sharedCoverage(),
  OUTLINE_CONFIRMATION_DRAFT_CONFLICT: confirmation('reload_draft'),
  OUTLINE_CONFIRMATION_DRAFT_INVALID: confirmation('reload_draft'),
  OUTLINE_CONFIRMATION_SOURCE_HASH_INVALID: confirmation('reload_draft'),
  OUTLINE_CONFIRMATION_DRAFT_HASH_INVALID: confirmation('reload_draft'),
  OUTLINE_CONFIRMATION_CONFIRMED_HASH_INVALID: confirmation('retry_confirm'),
  OUTLINE_CONFIRMATION_ARTIFACT_INVALID: confirmation('reload_draft'),
  OUTLINE_CONFIRMATION_ARTIFACT_SET_INVALID: confirmation('retry_confirm'),
  OUTLINE_CONFIRMATION_STAGE_INVALID: confirmation('retry_confirm'),
  OUTLINE_CONFIRMATION_RESPONSE_POINT_MISSING: confirmation('focus_section'),
  OUTLINE_CONFIRMATION_PERSIST_FAILED: confirmation('retry_save'),
} as const satisfies Record<string, OutlineConfirmationIssueDefinition>

/** S5 issue codes accepted by Host responses and browser recovery maps. */
export type OutlineConfirmationIssueCode = keyof typeof OUTLINE_CONFIRMATION_ISSUES
