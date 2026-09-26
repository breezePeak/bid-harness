/** 能力化回归共用的旧格式项目；章节身份、来源和正文内容固定。 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createScoringResponsePointCatalog, outlineArtifactSha256, type BidWorkspace, type ChapterWritingManifest, type OutlineArtifact } from '@deepseek-ai/dsh-bid'
import { normalizeFlowchartInputs } from '../src/flowchart.ts'
import { collectDocxExportSnapshot } from '../src/docx-export.ts'
import { seedProjectArtifacts } from './fixtures/project-session.ts'

const ids = ['SEC-1', 'SEC-2', 'SEC-3', 'SEC-4', 'SEC-5'] as const
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const serial = (index: number): string => String(index + 1).padStart(4, '0')

async function writeJson(workspace: BidWorkspace, path: string, value: unknown): Promise<void> {
  const absolute = join(workspace.projectRoot, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, `${JSON.stringify(value)}\n`)
}

/**
 * 建立有真实招标分块、五个叶节和旧版执行记录的项目。
 * @param workspace 空测试项目。
 * @param variant 全部完成或仅前两章完成。
 * @returns 固定目录及已写章节身份。
 */
export async function seedCapabilityProject(workspace: BidWorkspace, variant: 'complete' | 'partial'): Promise<{
  outline: OutlineArtifact
  completedIds: readonly string[]
}> {
  await seedProjectArtifacts(workspace)
  const requirements = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8')) as {
    requirements: Array<{ source_refs: Array<{ file_id: string; chunk: string; line_start: number; line_end: number }> }>
  }
  const source = requirements.requirements[0]!.source_refs
  const [reference] = await workspace.import([{ name: 'reference.md', role: 'reference',
    bytes: new TextEncoder().encode('参考资料：设计、实施和验收采用可追踪的交付记录。') }])
  if (reference?.chunksPath === null || reference?.chunksPath === undefined) throw new Error('测试参考资料缺少分块')
  const referenceIndex = JSON.parse(await readFile(join(workspace.projectRoot, reference.chunksPath, 'index.json'), 'utf8')) as {
    chunks: Array<{ path: string }>
  }
  const referenceChunk = referenceIndex.chunks[0]?.path.replace(/\.md$/u, '')
  if (referenceChunk === undefined) throw new Error('测试参考资料分块为空')
  const original = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/outline.json'), 'utf8')) as OutlineArtifact
  const parent = (id: string, order: number, title: string): OutlineArtifact['sections'][number] => ({
    ...original.sections[0]!, id, parent_id: null, order, level: 1, title, writable: false,
    must_answer: [], requirement_ids: [], scoring_ids: [], scoring_response_point_ids: [], scoring_response_points: [],
  })
  const leaves = ids.map((id, index) => ({
    ...original.sections[0]!, id, parent_id: index < 3 ? 'GROUP-A' : 'GROUP-B',
    order: index < 3 ? index + 1 : index - 2, level: 2, title: `章节${index + 1}`,
    purpose: `回答主题${index + 1}`, must_answer: [`回答主题${index + 1}`],
    requirement_ids: [`REQ-${index + 1}`], scoring_ids: [`SCORE-${index + 1}`],
    scoring_response_point_ids: [`RP-${serial(index).padStart(6, '0')}`],
    scoring_response_points: [{ scoring_id: `SCORE-${index + 1}`, response_point: `回答评分${index + 1}` }],
  }))
  const outline: OutlineArtifact = { ...original, sections: [parent('GROUP-A', 1, '设计'), parent('GROUP-B', 2, '交付'), ...leaves] }
  const outlineHash = outlineArtifactSha256(outline)
  const completedIds = variant === 'complete' ? [...ids] : [...ids.slice(0, 2)]
  const scoring = { schema_version: 1, scoring_items: ids.map((_, index) => ({
    id: `SCORE-${index + 1}`, parent: null, group: '技术', title: `评分${index + 1}`,
    raw_text: `评分${index + 1}`, criterion: `回答评分${index + 1}`, score: 1, score_range: null,
    must_answer: true, source_refs: source,
  })) }
  await writeJson(workspace, 'analysis/requirements.json', { schema_version: 1, requirements: ids.map((_, index) => ({
    id: `REQ-${index + 1}`, category: '技术', raw_text: `要求${index + 1}`,
    normalized_requirement: `回答主题${index + 1}`, mandatory: true, source_refs: source,
  })) })
  await writeJson(workspace, 'analysis/scoring-origin.json', scoring)
  await writeJson(workspace, 'analysis/scoring.json', scoring)
  await writeJson(workspace, 'analysis/tender-analysis-selection.json', { schema_version: 1, selected_scoring_ids: scoring.scoring_items.map(item => item.id) })
  await writeJson(workspace, 'analysis/scoring-response-points.json', createScoringResponsePointCatalog(scoring, {
    schema_version: 1, points: ids.map((_, index) => ({
      scoring_id: `SCORE-${index + 1}`, order: 1, text: `回答评分${index + 1}`,
    })),
  }))
  await writeJson(workspace, 'analysis/evidence-map.json', { section_mappings: ids.map((id, index) => ({
    section_id: id, local_materials: index === 2 ? [] : [{
      source_kind: 'reference', file_id: reference.id, chunk: referenceChunk, usage: 'reference', summary: `资料${index + 1}`,
    }], web_materials: [], missing_topics: index === 2 ? ['缺少第三章实施案例'] : [], writing_dimensions: [`主题${index + 1}`],
  })) })
  await writeJson(workspace, 'outline/outline.json', outline)
  await writeJson(workspace, 'outline/confirmed-outline.json', outline)
  await writeJson(workspace, 'chapters/writing-plan.json', {
    schema_version: 3, scope: 'technical_bid', plan_version: 1, confirmed: true,
    confirmed_outline_sha256: outlineHash,
    user_message_refs: [{ session_id: 'main', message_id: 'message-1', seq: 1 }],
    user_requirements: ['按招标要求编写'], global_instructions: ['术语保持一致'],
    document_acceptance: [{ id: 'AC-000001', scope: { kind: 'document' }, description: '响应全部要求', priority: 'required', evaluator: { kind: 'semantic' } }],
    sections: ids.map((id, index) => ({ section_id: id, task: `编写章节${index + 1}`, user_message_refs: [], user_requirements: [],
      writing_instructions: [], acceptance_criteria: [{ id: `AC-${String(index + 2).padStart(6, '0')}`,
        scope: { kind: 'section', section_id: id }, description: `回答主题${index + 1}`,
        priority: 'required', evaluator: { kind: 'semantic' } }],
    })), revision: null,
  })
  const flowcharts = normalizeFlowchartInputs('SEC-1', [{
    key: 'process-flow', title: '流程关系', direction: 'TB', nodes: [
      { key: 'start', type: 'start', text: '启动' }, { key: 'finish', type: 'end', text: '完成' },
    ], edges: [{ from: 'start', to: 'finish' }],
  }])
  const chapters: ChapterWritingManifest['chapters'] = []
  for (const [index, id] of ids.entries()) {
    if (!completedIds.includes(id)) continue
    const markdown = index === 0
      ? '# 章节1\n\n流程一：收集输入。\n\n流程二：校验结果。\n\n流程三：交付成果。\n\n| 步骤 | 产物 |\n| --- | --- |\n| 校验 | 报告 |\n\n{{flowchart:process-flow}}\n'
      : `# 章节${index + 1}\n\n回答主题${index + 1}。${index === 1 ? '参见章节1的流程。' : ''}\n`
    const contentPath = `chapters/sections/${serial(index)}.md`
    const reviewPath = `chapters/reviews/${serial(index)}.json`
    const metadataPath = `chapters/meta/${serial(index)}.json`
    const metadata = {
      section_id: id, covered_must_answer: [`回答主题${index + 1}`],
      covered_scoring_response_point_ids: [`RP-${String(index + 1).padStart(6, '0')}`],
      covered_scoring_response_points: [{ scoring_id: `SCORE-${index + 1}`, response_point: `回答评分${index + 1}` }],
      local_materials_used: [], web_materials_used: [], unresolved_topics: index === 2 ? ['缺少第三章实施案例'] : [],
      flowcharts: index === 0 ? flowcharts.map(chart => ({ ...chart,
        nodes: chart.nodes.map(node => ({ ...node })), edges: chart.edges.map(edge => ({ ...edge })),
      })) : [],
      handoff: { section_id: id, decisions: [], terminology: [], numbers_and_parameters: [], interfaces: [],
        deployment_constraints: [], cross_reference_targets: index === 1 ? ['SEC-1'] : [], unresolved_topics: [] },
    }
    const contentHash = hash(markdown)
    await writeJson(workspace, metadataPath, metadata)
    await writeFile(join(workspace.projectRoot, contentPath), markdown)
    await writeJson(workspace, reviewPath, {
      schema_version: 8, section_id: id, verdict: 'pass', candidate_sha256: contentHash,
      writer_child_session_id: `writer-${id}`, reviewer_child_session_id: `reviewer-${id}`,
      must_answer_coverage: [], requirement_coverage: [], response_point_coverage: [], compliance_coverage: [],
      acceptance_criteria_results: [], global_compliance_checks: [], assignment_conflicts: [],
      external_input_gaps: [], claim_checks: [], quality_checks: { bidder_response_voice: true,
        project_specific: true, structure_complete: true, legacy_project_pollution_free: true,
        placeholder_free: true, obvious_repetition_free: true }, blocking_issues: [],
    })
    chapters.push({ ...metadata, content_path: contentPath, requirement_ids: [`REQ-${index + 1}`],
      scoring_ids: [`SCORE-${index + 1}`], compliance_ids: [], review_path: reviewPath, review_sha256: contentHash })
  }
  await writeJson(workspace, 'chapters/manifest.json', {
    schema_version: 6, scope: 'technical_bid', confirmed_outline_sha256: outlineHash, chapters,
  } satisfies ChapterWritingManifest)
  await writeJson(workspace, 'chapters/execution-log.json', {
    schema_version: 3, scope: 'technical_bid', confirmed_outline_sha256: outlineHash,
    writing_plan_version: 1, max_concurrency: 2, observed_max_concurrency: 2,
    sections: ids.map(id => ({ section_id: id, depends_on: [], related_sections: [], epoch: 0,
      status: completedIds.includes(id) ? 'completed' : 'pending',
      attempts: completedIds.includes(id) ? (['writer', 'reviewer'] as const).map(role => ({
        role, attempt: 1, child_session_id: `${role}-${id}`, label: `${role} ${id}`,
        started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:01:00.000Z',
        stop_reason: 'completed', accepted: true, issues: [],
        input: { plan_version: 1, section_epoch: 0, dependencies: [] },
      })) : [],
      final_writer_child_session_id: completedIds.includes(id) ? `writer-${id}` : null,
      final_reviewer_child_session_id: completedIds.includes(id) ? `reviewer-${id}` : null,
    })),
  })
  return { outline, completedIds }
}

/**
 * 采集可比较的业务快照，不包含临时路径、时间或 Run 身份。
 * @param workspace 已建立的测试项目。
 * @returns 目录、正文归属、资料、计划、Child 与导出快照身份。
 */
export async function captureCapabilityBaseline(workspace: BidWorkspace): Promise<unknown> {
  const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(workspace.projectRoot, path), 'utf8')) as unknown
  const outline = await read('outline/confirmed-outline.json') as OutlineArtifact
  const manifest = await read('chapters/manifest.json') as ChapterWritingManifest
  const execution = await read('chapters/execution-log.json') as { sections: Array<{
    section_id: string
    status: string
    attempts: Array<{ role: string; child_session_id: string }>
  }> }
  const plan = await read('chapters/writing-plan.json') as { sections: Array<{
    section_id: string
    task: string
    acceptance_criteria: Array<{ id: string }>
  }> }
  const evidence = await read('analysis/evidence-map.json') as { section_mappings: Array<{
    section_id: string
    local_materials: unknown[]
    missing_topics: string[]
  }> }
  const chapters = await Promise.all(manifest.chapters.map(async entry => ({
    section_id: entry.section_id, content_path: entry.content_path,
    content_sha256: hash(await readFile(join(workspace.projectRoot, entry.content_path), 'utf8')),
    review_path: entry.review_path,
  })))
  const exportSnapshot = await collectDocxExportSnapshot(workspace)
  return {
    outline: outline.sections.map(section => ({ id: section.id, parent_id: section.parent_id,
      order: section.order, title: section.title, writable: section.writable })),
    chapters,
    evidence: evidence.section_mappings.map(mapping => ({ section_id: mapping.section_id,
      local_materials: mapping.local_materials, missing_topics: mapping.missing_topics })),
    plan: plan.sections.map(section => ({ section_id: section.section_id, task: section.task,
      acceptance_ids: section.acceptance_criteria.map(item => item.id) })),
    execution: execution.sections.map(section => ({ section_id: section.section_id,
      status: section.status, children: section.attempts.map(attempt => ({ role: attempt.role,
        child_session_id: attempt.child_session_id })) })),
    export_sha256: hash(exportSnapshot.markdown),
    export_pending_sections: (exportSnapshot.markdown.match(/本节尚无已保存正文/gu) ?? []).length,
  }
}
