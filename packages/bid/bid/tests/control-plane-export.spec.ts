import { describe, expect, it } from 'vitest'
import * as controlPlane from '@deepseek-ai/dsh-bid/control-plane'

describe('browser-safe Bid control-plane export', () => {
  it('serves pure data contracts without the document pipeline entry', () => {
    expect(Object.keys(controlPlane).sort()).toEqual([
      'BID_BINARY_UPLOAD_PATH',
      'BID_CLIENT_ACTIONS',
      'BID_DOCUMENT_ROLES',
      'BID_RUNTIME_PROJECTION_KEY',
      'BID_STAGES',
      'BID_UPLOAD_FILES_HEADER',
      'BID_UPLOAD_SESSION_HEADER',
      'DOCX_TEMPLATE_MAX_BYTES',
      'DOCX_TEMPLATE_NAME_HEADER',
      'DOCX_TEMPLATE_REVISION_HEADER',
      'DOCX_TEMPLATE_SIZE_HEADER',
      'DOCX_TEMPLATE_UPLOAD_PATH',
      'OUTLINE_CONFIRMATION_ISSUES',
      'STAGE_RUN_STATUSES',
      'applyOutlineEdits',
      'applyTenderAnalysisEdits',
      'buildOutlineView',
      'isBidDocumentRole',
      'parseBidReviewWorkbenchView',
    ])
    expect(controlPlane.BID_RUNTIME_PROJECTION_KEY).toBe('bid.runtime')
    expect(controlPlane.BID_STAGES).toEqual([
      'file_intake', 'tender_analysis', 'outline_generation', 'evidence_mapping', 'chapter_writing', 'docx_export',
    ])
    expect(controlPlane.BID_CLIENT_ACTIONS).toEqual([
      'upload_files',
      'start_stage',
      'stop_stage',
      'retry_stage',
      'export_docx',
      'revise_chapter',
      'confirm_tender_analysis',
      'confirm_outline',
      'regenerate_outline',
      'send_message',
    ])
  })
})
