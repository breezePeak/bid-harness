/** S5 文档级全局合规核验协议及其确定性完整性检查。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { BidManifest } from './index.ts'
import { chapterToolArgs, createChapterProtocol, type ChapterProtocol } from './chapter-writing-protocol.ts'
import { registerCompletedChapterReader } from './chapter-reading.ts'
import {
  GLOBAL_COMPLIANCE_REVIEW_SCHEMA_VERSION,
  parseGlobalComplianceReviewArtifact,
  type GlobalComplianceReviewArtifact,
  type GlobalComplianceReviewItem,
} from './chapter-writing-global-review-artifacts.ts'
import type { StageValidationIssue } from './control-plane-contract.ts'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'
import type { TenderComplianceArtifact } from './tender-analysis-artifacts.ts'

/** Main Agent 可用于提交文档级核验的私有工具。 */
export const GLOBAL_COMPLIANCE_REVIEW_TOOLS = ['read_completed_chapter', 'review_global_compliance', 'finish_global_compliance_review'] as const

/** Current chapter bytes made available to the document-level review. */
export interface GlobalComplianceChapter {
  readonly section_id: string
  readonly title: string
  readonly markdown: string
  readonly candidate_sha256: string
}

/** Host-bound evidence selectable by the document-level reviewer. */
export type GlobalComplianceEvidence =
  | { readonly evidence_ref: string; readonly kind: 'chapter_quote'; readonly section_id: string; readonly quote: string }
  | { readonly evidence_ref: string; readonly kind: 'material'; readonly file_id: string; readonly name: string; readonly role: 'tender' | 'outline_framework' | 'reference_bid' | 'reference' }

/**
 * Build stable evidence references from current chapter lines and imported material identities.
 * @param chapters Current accepted chapter bodies.
 * @param manifest Current imported-material identities.
 * @returns Stable evidence references in chapter then manifest order.
 */
export function buildGlobalComplianceEvidence(
  chapters: readonly GlobalComplianceChapter[], manifest: BidManifest,
): GlobalComplianceEvidence[] {
  const evidence: GlobalComplianceEvidence[] = []
  for (const chapter of chapters) {
    for (const quote of chapter.markdown.split('\n').map(line => line.trim()).filter(Boolean)) {
      evidence.push({ evidence_ref: `D${evidence.length + 1}`, kind: 'chapter_quote', section_id: chapter.section_id, quote })
    }
  }
  for (const file of manifest.files) {
    evidence.push({
      evidence_ref: `D${evidence.length + 1}`,
      kind: 'material',
      file_id: String(file.id),
      name: file.originalName,
      role: file.role,
    })
  }
  return evidence
}

const text = z.string().trim().min(1)
const ownerInput = z.object({
  kind: z.enum(['chapter', 'document', 'delivery']),
  section_id: text.nullable(),
}).strict()
const itemInput = z.object({
  compliance_id: text,
  category: z.enum(['cross_chapter_constraint', 'document_requirement', 'delivery_requirement']),
  owners: z.array(ownerInput).min(1),
  status: z.enum(['pass', 'fail', 'pending', 'not_applicable']),
  checked_section_ids: z.array(text),
  evidence_refs: z.array(text),
  affected_section_ids: z.array(text),
  issue: text.nullable(),
}).strict()

const stringParameter = { type: 'string' }
const nullableString = { oneOf: [stringParameter, { type: 'null' }] }

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

/**
 * Validate identity, current chapter bindings, and internally consistent conclusions.
 * @param report Document-level record to validate.
 * @param outline Current confirmed outline.
 * @param compliance Canonical tender compliance records.
 * @param chapters Current persisted chapter bodies.
 * @param manifest Current imported-material identities.
 * @returns Deterministic record issues; semantic conclusions remain model-owned.
 */
export function validateGlobalComplianceReview(
  report: GlobalComplianceReviewArtifact,
  outline: OutlineArtifact,
  compliance: TenderComplianceArtifact,
  chapters: readonly GlobalComplianceChapter[],
  manifest: BidManifest,
): StageValidationIssue[] {
  const issues: StageValidationIssue[] = []
  const expected = outline.global_compliance_ids
  const canonical = new Map(compliance.compliance_items.map(item => [item.id, item]))
  const chapterById = new Map(chapters.map(chapter => [chapter.section_id, chapter]))
  const fileById = new Map(manifest.files.map(file => [String(file.id), file]))
  if (report.items.length !== expected.length
    || report.items.some((item, index) => item.compliance_id !== expected[index])) {
    issues.push({ code: 'GLOBAL_COMPLIANCE_IDENTITIES_INVALID', message: '文档级核验必须按确认目录顺序逐项记录全部全局合规 ID。', path: 'items' })
  }
  for (const [index, item] of report.items.entries()) {
    const source = canonical.get(item.compliance_id)
    const path = `items.${index}`
    if (source === undefined || item.item !== source.normalized_rule) {
      issues.push({ code: 'GLOBAL_COMPLIANCE_ITEM_INVALID', message: '文档级核验条目必须绑定当前合规原文身份。', path })
    }
    const checkedIds = item.checked_chapters.map(value => value.section_id)
    const ownerIds = item.owners.flatMap(owner => owner.kind === 'chapter' ? [owner.section_id] : [])
    if (duplicate(checkedIds) || duplicate(ownerIds) || duplicate(item.affected_section_ids)) {
      issues.push({ code: 'GLOBAL_COMPLIANCE_DUPLICATE_INVALID', message: '章节归属、检查范围和受影响章节不得重复。', path })
    }
    for (const checked of item.checked_chapters) {
      const chapter = chapterById.get(checked.section_id)
      if (chapter === undefined || chapter.candidate_sha256 !== checked.candidate_sha256) {
        issues.push({ code: 'GLOBAL_COMPLIANCE_CHAPTER_STALE', message: '文档级核验引用的章节正文版本已失效。', path })
      }
    }
    for (const id of [...ownerIds, ...item.affected_section_ids]) {
      if (!chapterById.has(id)) issues.push({ code: 'GLOBAL_COMPLIANCE_SECTION_INVALID', message: `文档级核验引用未知可写章节 ${id}。`, path })
    }
    for (const evidence of item.evidence) {
      if (evidence.kind === 'chapter_quote') {
        const chapter = chapterById.get(evidence.section_id)
        if (chapter === undefined || !checkedIds.includes(evidence.section_id) || !chapter.markdown.includes(evidence.quote)) {
          issues.push({ code: 'GLOBAL_COMPLIANCE_EVIDENCE_INVALID', message: '正文依据必须来自已登记检查范围内的当前章节原文。', path })
        }
      } else {
        const file = fileById.get(evidence.file_id)
        if (file === undefined || file.originalName !== evidence.name || file.role !== evidence.role) {
          issues.push({ code: 'GLOBAL_COMPLIANCE_EVIDENCE_INVALID', message: '材料依据必须匹配当前项目文件身份。', path })
        }
      }
    }
    if (item.status === 'pass' && (item.issue !== null || item.evidence.length === 0)) {
      issues.push({ code: 'GLOBAL_COMPLIANCE_RESULT_INVALID', message: '核验通过必须具有当前依据且 issue 为 null。', path })
    }
    if (item.status !== 'pass' && (item.issue === null || item.issue.trim().length === 0)) {
      issues.push({ code: 'GLOBAL_COMPLIANCE_RESULT_INVALID', message: '未通过、待确认或不适用必须说明依据或未完成原因。', path })
    }
    if (item.category === 'delivery_requirement' && item.status === 'pass') {
      issues.push({ code: 'GLOBAL_COMPLIANCE_DELIVERY_EVIDENCE_INVALID', message: '当前 S5 不能观察实际递交操作，递交要求不得仅凭正文或导入材料判定完成。', path })
    }
  }
  return issues
}

/**
 * Install the document-level review tools on the existing S5 Main Agent.
 * @param agent S5 Main Agent.
 * @param outline Current confirmed outline.
 * @param outlineHash SHA-256 identity of the confirmed outline.
 * @param compliance Canonical compliance input.
 * @param chapters Current chapter bodies and hashes.
 * @param evidence Host-bound evidence choices.
 * @param retained Still-current item results from a prior report.
 * @param maxContinuations Maximum continuations before a missing finish fails.
 * @returns Captured report protocol.
 */
export function attachGlobalComplianceReview(
  agent: Agent,
  outline: OutlineArtifact,
  outlineHash: string,
  compliance: TenderComplianceArtifact,
  chapters: readonly GlobalComplianceChapter[],
  evidence: readonly GlobalComplianceEvidence[],
  retained: readonly GlobalComplianceReviewItem[],
  maxContinuations: number,
): ChapterProtocol<GlobalComplianceReviewArtifact> {
  const runtime = createChapterProtocol<GlobalComplianceReviewArtifact>(agent, 'finish_global_compliance_review', maxContinuations)
  const globalIds = new Set(outline.global_compliance_ids)
  const chapterById = new Map(chapters.map(chapter => [chapter.section_id, chapter]))
  const evidenceByRef = new Map(evidence.map(item => [item.evidence_ref, item]))
  const canonical = new Map(compliance.compliance_items.map(item => [item.id, item]))
  const items = new Map(retained.map(item => [item.compliance_id, item]))
  try {
    const quoteRefs = registerCompletedChapterReader(runtime, new Map(chapters.map(chapter => [chapter.section_id, {
      markdown: chapter.markdown, content_sha256: chapter.candidate_sha256,
    }])))
    runtime.register({
      name: 'review_global_compliance',
      description: '记录全局要求的核验性质、责任归属、结论与当前依据；合法 fail/pending 可保存。',
      parameters: {
        type: 'object', properties: {
          compliance_id: stringParameter,
          category: { type: 'string', enum: ['cross_chapter_constraint', 'document_requirement', 'delivery_requirement'] },
          owners: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['chapter', 'document', 'delivery'] }, section_id: nullableString }, required: ['kind', 'section_id'], additionalProperties: false } },
          status: { type: 'string', enum: ['pass', 'fail', 'pending', 'not_applicable'] },
          checked_section_ids: { type: 'array', items: stringParameter },
          evidence_refs: { type: 'array', items: stringParameter },
          affected_section_ids: { type: 'array', items: stringParameter },
          issue: nullableString,
        },
        required: ['compliance_id', 'category', 'owners', 'status', 'checked_section_ids', 'evidence_refs', 'affected_section_ids', 'issue'],
        additionalProperties: false,
      },
      execute(args) {
        const input = chapterToolArgs(itemInput, args)
        if (!globalIds.has(input.compliance_id)) throw new ToolArgsError([`compliance_id: 未知全局合规 ID ${input.compliance_id}。`])
        if (duplicate(input.checked_section_ids) || duplicate(input.affected_section_ids)) throw new ToolArgsError(['checked_section_ids 和 affected_section_ids 不得重复。'])
        const checked = input.checked_section_ids.map((sectionId) => {
          const chapter = chapterById.get(sectionId)
          if (chapter === undefined) throw new ToolArgsError([`checked_section_ids: 未知可写章节 ${sectionId}。`])
          return { section_id: sectionId, candidate_sha256: chapter.candidate_sha256 }
        })
        const owners = input.owners.map((owner) => {
          if (owner.kind === 'chapter') {
            if (owner.section_id === null || !chapterById.has(owner.section_id)) throw new ToolArgsError(['chapter owner 必须填写当前可写 section_id。'])
            return { kind: 'chapter' as const, section_id: owner.section_id }
          }
          if (owner.section_id !== null) throw new ToolArgsError([`${owner.kind} owner 的 section_id 必须为 null。`])
          return { kind: owner.kind }
        })
        const selected = input.evidence_refs.map((ref) => {
          const quote = quoteRefs.get(ref)
          if (quote !== undefined) return { kind: 'chapter_quote' as const, ...quote }
          const value = evidenceByRef.get(ref)
          if (value === undefined) throw new ToolArgsError([`evidence_refs: 未知当前依据 ${ref}。`])
          const { evidence_ref: _ref, ...durable } = value
          return durable
        })
        for (const value of selected) if (value.kind === 'chapter_quote' && !input.checked_section_ids.includes(value.section_id)) {
          throw new ToolArgsError([`正文依据 ${value.section_id} 必须同时列入 checked_section_ids。`])
        }
        for (const sectionId of input.affected_section_ids) if (!chapterById.has(sectionId)) {
          throw new ToolArgsError([`affected_section_ids: 未知可写章节 ${sectionId}。`])
        }
        if (input.status === 'pass' && (input.issue !== null || selected.length === 0)) throw new ToolArgsError(['pass 必须选择当前依据且 issue 为 null。'])
        if (input.status !== 'pass' && input.issue === null) throw new ToolArgsError([`${input.status} 必须说明依据或未完成原因。`])
        if (input.category === 'delivery_requirement' && input.status === 'pass') {
          throw new ToolArgsError(['S5 没有实际递交执行证据；递交要求必须保留 pending，不能凭正文或文件生成判定完成。'])
        }
        const source = canonical.get(input.compliance_id)
        if (source === undefined) throw new ToolArgsError([`compliance_id: 缺少 canonical 条目 ${input.compliance_id}。`])
        items.set(input.compliance_id, {
          compliance_id: input.compliance_id,
          item: source.normalized_rule,
          category: input.category,
          owners,
          status: input.status,
          checked_chapters: checked,
          evidence: selected,
          affected_section_ids: input.affected_section_ids,
          issue: input.issue,
        })
        return Promise.resolve({ recorded: true, compliance_id: input.compliance_id })
      },
    })
    runtime.register({
      name: 'finish_global_compliance_review',
      description: '检查全部全局 ID 均有当前核验记录并保存报告；fail/pending 不阻止报告提交。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute(args, exec) {
        chapterToolArgs(z.object({}).strict(), args)
        const missing = outline.global_compliance_ids.filter(id => !items.has(id))
        if (missing.length > 0) return Promise.resolve({ completed: false, missing_compliance_ids: missing })
        const report = parseGlobalComplianceReviewArtifact({
          schema_version: GLOBAL_COMPLIANCE_REVIEW_SCHEMA_VERSION,
          scope: 'technical_bid',
          confirmed_outline_sha256: outlineHash,
          items: outline.global_compliance_ids.map((id) => {
            const item = items.get(id)
            if (item === undefined) throw new Error(`S5 global review lost ${id}`)
            return item
          }),
        })
        return Promise.resolve(runtime.finish(exec, report))
      },
    })
    return runtime
  } catch (error: unknown) {
    runtime.dispose()
    throw error
  }
}
