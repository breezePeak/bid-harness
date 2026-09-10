/** 跨 Session 回归与源码 Loader 共用的真实项目文件和独立聊天。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { createScoringResponsePointCatalog, outlineArtifactSha256, type BidWorkspace, type ChapterWritingManifest, type OutlineArtifact } from '@deepseek-ai/dsh-bid'

/**
 * 读取应用真实导出文件中的标题编号关联，供源码 Loader 快照核对。
 * @param bytes 完整 DOCX。
 * @returns 段落编号数量、列表实例数量及关联的标题样式。
 */
export async function summarizeDocxHeadingNumbering(bytes: Buffer): Promise<{ paragraphs: number; lists: number; styles: string[] }> {
  const zip = await JSZip.loadAsync(bytes)
  const document = await zip.file('word/document.xml')!.async('string')
  const numbering = await zip.file('word/numbering.xml')!.async('string')
  return { paragraphs: [...document.matchAll(/<w:numPr>/gu)].length,
    lists: new Set([...document.matchAll(/<w:numId w:val="(\d+)"\/>/gu)].map(match => match[1])).size,
    styles: [...numbering.matchAll(/<w:pStyle w:val="(Heading[1-6])"\/>/gu)].map(match => match[1]!),
  }
}

/** @param session 原聊天。该内容不得出现在新 Session 中。 */
export function seedConversation(session: Session): void {
  const callId = CallId('previous-read')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'aaa' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [
      { type: 'reasoning', text: '仅属于 A 的推理' }, { type: 'text', text: 'bbb' },
      { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
    ] }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'previous result' }], isError: false }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** @param workspace 共享项目目录。@returns 含一章可读正文的已确认目录。 */
export async function seedProjectArtifacts(workspace: BidWorkspace): Promise<OutlineArtifact> {
  const [tender] = await workspace.import([{ name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('技术要求：必须按期交付，技术方案得 10 分。') }])
  if (tender?.absoluteChunkIndexPath === null || tender?.absoluteChunkIndexPath === undefined || tender.chunksPath === null) throw new Error('测试招标文件缺少分块')
  const index = JSON.parse(await readFile(tender.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }
  const source = { file_id: tender.id, chunk: `${tender.chunksPath}/${index.chunks[0]!.path}`, line_start: 1, line_end: 1 }
  const scoring = { schema_version: 1 as const, scoring_items: [{ id: 'SCORE-1', parent: null, group: '技术', title: '技术方案', raw_text: '技术方案得 10 分', criterion: '完整技术方案', score: 10, score_range: null, must_answer: true, source_refs: [source] }] }
  const outline: OutlineArtifact = { schema_version: 3, scope: 'technical_bid', document_title: '项目技术标', global_compliance_ids: [], sections: [{
    id: 'SEC-1', parent_id: null, order: 1, level: 1, title: '技术方案', purpose: '说明交付方案', writable: true,
    must_answer: ['按期交付'], requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'], compliance_ids: [], origin: 'generated',
    scoring_response_point_ids: ['RP-000001'], scoring_response_points: [{ scoring_id: 'SCORE-1', response_point: '说明技术方案' }],
    suggested_tables: [], suggested_figures: [], writing_notes: [],
  }] }
  const artifacts: Record<string, unknown> = {
    'analysis/project.json': { schema_version: 1, project_name: '项目 A', tender_name: null, purchaser: null, owner: null, project_background: ['技术建设'], project_objectives: ['交付技术方案'], project_scope: ['技术方案'], technical_scope: ['方案设计'], delivery_scope: ['按期交付'], implementation_constraints: ['按期交付'], key_technical_points: ['技术方案'], source_refs: [source], analyzed_tender_files: [tender.id] },
    'analysis/requirements.json': { schema_version: 1, requirements: [{ id: 'REQ-1', category: '技术', raw_text: '必须按期交付', normalized_requirement: '按期交付', mandatory: true, source_refs: [source] }] },
    'analysis/scoring-origin.json': scoring,
    'analysis/scoring.json': scoring,
    'analysis/tender-analysis-selection.json': { schema_version: 1, selected_scoring_ids: ['SCORE-1'] },
    'analysis/scoring-response-points.json': createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [{ scoring_id: 'SCORE-1', order: 1, text: '说明技术方案' }] }),
    'analysis/compliance.json': { schema_version: 1, compliance_items: [] },
    'analysis/evidence-map.json': { schema_version: 10, section_mappings: [{ section_id: 'SEC-1', local_materials: [], web_materials: [], missing_topics: ['待补充实施材料'], writing_dimensions: ['技术方案'] }] },
    'outline/outline.json': outline,
    'outline/confirmed-outline.json': outline,
    'chapters/writing-plan.json': {
      schema_version: 2, scope: 'technical_bid', plan_version: 1, confirmed: true,
      confirmed_outline_sha256: outlineArtifactSha256(outline), user_requirements: ['没有特殊要求，直接开始'],
      global_instructions: ['完整响应招标要求。'],
      document_acceptance: [{
        id: 'AC-000001', scope: { kind: 'document' }, description: '整书完整响应要求。',
        priority: 'required', evaluator: { kind: 'semantic' },
      }],
      sections: [{
        section_id: 'SEC-1', task: '完成技术方案。', user_requirements: [], writing_instructions: [],
        acceptance_criteria: [{
          id: 'AC-000002', scope: { kind: 'section', section_id: 'SEC-1' }, description: '完成本章任务。',
          priority: 'required', evaluator: { kind: 'semantic' },
        }],
      }],
      revision: null,
    },
    'chapters/execution-log.json': { schema_version: 2, scope: 'technical_bid', confirmed_outline_sha256: outlineArtifactSha256(outline), max_concurrency: 1, observed_max_concurrency: 1, sections: [{ section_id: 'SEC-1', depends_on: [], related_sections: [], status: 'completed', attempts: [], final_writer_child_session_id: 'writer-a', final_reviewer_child_session_id: 'reviewer-a' }] },
    'chapters/manifest.json': { schema_version: 6, scope: 'technical_bid', confirmed_outline_sha256: outlineArtifactSha256(outline), chapters: [{
      section_id: 'SEC-1', content_path: 'chapters/sections/0001.md', requirement_ids: ['REQ-1'], scoring_ids: ['SCORE-1'], compliance_ids: [],
      covered_must_answer: ['按期交付'], covered_scoring_response_point_ids: ['RP-000001'], covered_scoring_response_points: [{ scoring_id: 'SCORE-1', response_point: '说明技术方案' }],
      local_materials_used: [], web_materials_used: [], unresolved_topics: [], review_path: 'chapters/reviews/0001.json', review_sha256: 'a'.repeat(64),
      handoff: { section_id: 'SEC-1', decisions: [], terminology: [], numbers_and_parameters: [], interfaces: [], deployment_constraints: [], cross_reference_targets: [], unresolved_topics: [] },
    }] } satisfies ChapterWritingManifest,
  }
  for (const [path, value] of Object.entries(artifacts)) {
    const absolute = join(workspace.projectRoot, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, `${JSON.stringify(value)}\n`)
  }
  await mkdir(join(workspace.projectRoot, 'chapters/sections'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 技术方案\n\n已有正文。\n')
  return outline
}
