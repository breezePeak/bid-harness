/** 真实 Loader 中续用章节 Writer，验证全章重写、最小修改和相邻段落修订。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import {
  checkpointBidProjectState, parseChapterExecutionLog,
  type BidChapterRevisionRequest,
} from '@deepseek-ai/dsh-bid'
import { CallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { runChapterWritingLoop } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'

function toolCall(id: string, name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function candidate(markdown: string) {
  return { markdown, metadata: { local_materials_used: [{
    file_ref: 'F1', chunk: 'chunk_0001', usage: 'reference', summary: '支撑本章实施流程的组织与步骤安排。',
  }] } }
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少章节修订回放配置路径')
let ctx: Context | undefined
try {
  ctx = await boot('bid-chapter-revision-snapshot', configPath)
  const { agent, workspace, requests, parentScript, childScript } = await runChapterWritingLoop(ctx, process.cwd())
  const markdownPath = join(workspace.projectRoot, 'chapters/sections/0001.md')
  const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
  const evidencePath = join(workspace.projectRoot, 'analysis/evidence-map.json')
  const evidenceBefore = await readFile(evidencePath, 'utf8')
  const initialLog = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
  const writerId = initialLog.sections[0]!.final_writer_child_session_id
  assert.ok(writerId)
  await agent.whenIdle()
  const parentRequestCount = requests.filter(request => request.sessionId === agent.id).length
  const initialRequestCount = requests.length
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
  const user = ctx.sessions.create(SessionId('revision-user'), {
    meta: { cwd: process.cwd(), agentPreset: 'bid' },
  })
  let revisionNumber = 0
  const runRevision = async (revision: BidChapterRevisionRequest, markdown: string, invalidMarkdown?: string) => {
    revisionNumber += 1
    if (invalidMarkdown !== undefined) childScript.push(toolCall('reject-outside-selection', 'submit_chapter', candidate(invalidMarkdown)))
    childScript.push(
      toolCall(`submit-revision-${revisionNumber}`, 'submit_chapter', candidate(markdown)),
      toolCall('review-coverage', 'review_coverage_items', { items: ['R1', 'R2', 'R3', 'R4'].map(item_ref => ({
        item_ref, status: 'covered', evidence_quote_refs: ['Q2'], issue: null,
      })) }),
      toolCall('review-global-constraint', 'review_global_constraints', {
        items: [{ compliance_id: 'GLOBAL-1', status: 'not_applicable', evidence_quote_refs: [], issue: '当前章节没有冲突表述。' }],
      }),
      toolCall('review-acceptance', 'review_acceptance_criteria', {
        items: [{ criterion_id: 'AC-000002', status: 'met', evidence_quote_refs: ['Q2'], reason: '正文详细说明了访问控制实施流程。' }],
      }),
      toolCall('review-summary', 'set_review_summary', {
        quality_checks: { project_specific: true, structure_complete: true, legacy_project_pollution_free: true,
          placeholder_free: true, obvious_repetition_free: true },
        blocking_issues: [],
        assignment_conflicts: [],
      }),
      toolCall('finish-review', 'finish_chapter_review', {}),
    )
    parentScript.push(
      toolCall(`review-global-${revisionNumber}`, 'review_global_compliance', {
        compliance_id: 'GLOBAL-1', category: 'cross_chapter_constraint', owners: [{ kind: 'document', section_id: null }],
        status: 'pass', checked_section_ids: ['SEC-SECURITY'], evidence_refs: ['D1'], affected_section_ids: [], issue: null,
      }),
      toolCall(`finish-global-review-${revisionNumber}`, 'finish_global_compliance_review', {}),
      toolCall(`finish-writing-plan-${revisionNumber}`, 'submit_chapter_writing_completion_review', {
        action: 'complete', reason: '修订后的章节与整书 required 条件均已满足。',
        document_acceptance: [
          { criterion_id: 'AC-000001', status: 'met', evidence_quote_refs: [], reason: '整书术语与技术响应一致。' },
        ],
      }),
    )
    const outcome = await ctx!.bid.reviseChapter(user, revision)
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    const persisted = await readFile(markdownPath, 'utf8')
    assert.equal(persisted, markdown)
    const log = parseChapterExecutionLog(JSON.parse(await readFile(logPath, 'utf8')))
    assert.equal(log.sections[0]!.final_writer_child_session_id, writerId)
    assert.equal(requests.filter(request => request.sessionId === agent.id).length, parentRequestCount + revisionNumber * 3)
    assert.equal(requests.filter(request => request.sessionId === user.id).length, 0)
    return persisted
  }
  const reference = (markdown: string) => ({
    section_id: 'SEC-SECURITY', content_sha256: createHash('sha256').update(markdown).digest('hex'),
  })
  const rewritten = [
    '# 1 访问控制与安全审计',
    '本章按访问控制、权限复核和安全审计组织实施，统一使用已确认的项目术语。',
    '权限管理由授权审批开始，按角色分配访问范围，并记录授权依据和操作责任。',
    '安全审计记录访问时间、操作对象和处理结果，定期核对异常访问与整改情况。',
    '最终交付权限台账与审计记录，原定交付内容保持不变。',
  ].join('\n\n') + '\n'
  const whole = await runRevision({
    instruction: '请全量重写本章节，按访问控制、权限管理、安全审计和交付安排重新组织正文。',
    reference: { scope: 'chapter', ...reference(await readFile(markdownPath, 'utf8')) },
  }, rewritten)
  const minimal = await runRevision({
    instruction: '请最小修改，仅将“统一使用已确认的项目术语”改为“统一使用已确认的访问控制术语”。',
    reference: { scope: 'chapter', ...reference(whole) },
  }, whole.replace('统一使用已确认的项目术语', '统一使用已确认的访问控制术语'))
  const beforeStaleRequest = requests.length
  const stale = await ctx.bid.reviseChapter(user, {
    instruction: '修改旧版本', reference: { scope: 'chapter', ...reference(whole) },
  })
  assert.deepEqual(stale, { ok: false, error: {
    code: 'BID_CHAPTER_REVISION_CONFLICT', message: '章节正文已变化，请重新选择章节或段落。',
  } })
  assert.equal(requests.length, beforeStaleRequest)
  assert.equal(await readFile(markdownPath, 'utf8'), minimal)
  const start = minimal.indexOf('权限管理由授权审批开始')
  const end = minimal.indexOf('\n\n最终交付')
  assert.ok(start > 0 && end > start)
  const replacement = [
    '权限管理由授权审批开始，按角色分配访问范围；授权人员登记审批依据，复核人员确认权限与岗位职责一致。',
    '安全审计记录访问时间、操作对象和处理结果；发现异常访问后登记责任人、整改措施与复核结论。',
  ].join('\n\n')
  const revised = minimal.slice(0, start) + replacement + minimal.slice(end)
  const finalMarkdown = await runRevision({
    instruction: '请细化这两个段落中的审批和复核责任。仅修改选中的段落。',
    reference: { scope: 'paragraphs', ...reference(minimal), start, end, text: minimal.slice(start, end) },
  }, revised, revised.replace('原定交付内容保持不变', '整章交付内容已被越界改写'))
  assert.equal(finalMarkdown.slice(0, start), minimal.slice(0, start))
  assert.equal(finalMarkdown.slice(start + replacement.length), minimal.slice(end))
  assert.equal(await readFile(evidencePath, 'utf8'), evidenceBefore)
  const revisionRequests = requests.slice(initialRequestCount).filter(request => request.sessionId === writerId)
  assert.equal(revisionRequests.length, 4)
  for (const request of revisionRequests) assert.ok(JSON.stringify(request.messages).includes('本地资料只有实施流程。'))
  assert.ok(JSON.stringify(revisionRequests.at(-1)!.messages).includes('统一使用已确认的项目术语'))
  assert.equal(childScript.length, 0)
  assert.equal(parentScript.length, 0)
  process.stdout.write(`${JSON.stringify({
    writer_session_reused: true, original_context_retained: true, main_agent_completion_reviewed: true,
    paragraphs_outside_selection_unchanged: true, evidence_unchanged: true,
  })}\n`)
} finally {
  await ctx?.fiber.dispose()
}
