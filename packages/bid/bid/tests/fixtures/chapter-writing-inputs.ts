/** S5 协议与调度测试共用的确认目录、S2/S4 输入。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BidWorkspace, outlineArtifactSha256, createScoringResponsePointCatalog, parseTenderProjectArtifact } from '@deepseek-ai/dsh-bid'
import type { ChapterContext } from '../../src/chapter-writing-executor.ts'
const source = [{ file_id: 'tender', chunk: 'corpus/tender/chunks/0001.md', line_start: 1, line_end: 1 }]

export async function writeInputs(workspace: BidWorkspace): Promise<ReturnType<typeof outlineFixture>> {
  await mkdir(join(workspace.projectRoot, 'analysis'), { recursive: true })
  await mkdir(join(workspace.projectRoot, 'outline'), { recursive: true })
  await writeFile(join(workspace.projectRoot, 'analysis/project.json'), `${JSON.stringify({ schema_version: 1, project_name: '测试项目', tender_name: null, purchaser: null, owner: null, project_background: ['建设背景'], project_objectives: ['建设目标'], project_scope: ['交付'], technical_scope: ['技术'], delivery_scope: ['实施'], implementation_constraints: ['周期'], key_technical_points: ['架构'], source_refs: source, analyzed_tender_files: ['tender'] })}\n`)
  await writeFile(join(workspace.projectRoot, 'analysis/requirements.json'), `${JSON.stringify({ schema_version: 1, requirements: [1, 2, 3].map(index => ({ id: `REQ-${index}`, category: '技术', raw_text: `要求${index}`, normalized_requirement: `响应要求${index}`, mandatory: true, source_refs: source })) })}\n`)
  const scoring = { schema_version: 1 as const, scoring_items: [1, 2, 3].map(index => ({ id: `SCORE-${index}`, parent: null, group: null, title: `评分${index}`, raw_text: `评分${index}`, criterion: `覆盖评分${index}`, score: 1, score_range: null, must_answer: true, source_refs: source })) }
  await writeFile(join(workspace.projectRoot, 'analysis/scoring.json'), `${JSON.stringify(scoring)}\n`)
  await writeFile(join(workspace.projectRoot, 'analysis/scoring-response-points.json'), `${JSON.stringify(createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [1, 2, 3].map(index => ({ scoring_id: `SCORE-${index}`, order: 1, text: `回答评分${index}` })) }))}\n`)
  await writeFile(join(workspace.projectRoot, 'analysis/compliance.json'), `${JSON.stringify({ schema_version: 1, compliance_items: [] })}\n`)
  await writeFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), `${JSON.stringify({ schema_version: 10, section_mappings: [1, 2, 3].map(index => ({ section_id: `SEC-${index}`, local_materials: [], web_materials: [], missing_topics: [], writing_dimensions: ['技术方案'] })) })}\n`)
  await writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), `${JSON.stringify({ schema_version: 2, stage: 'evidence_mapping', sources: [] })}\n`)
  const outline = outlineFixture()
  await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), `${JSON.stringify(outline)}\n`)
  const outlineSha256 = outlineArtifactSha256(outline)
  await writeFile(join(workspace.projectRoot, 'outline/confirmation.json'), `${JSON.stringify({ schema_version: 2, scope: 'technical_bid', decision: 'confirmed', source_outline_sha256: outlineSha256, confirmed_outline_sha256: outlineSha256, confirmed_draft_revision: 1, confirmed_draft_sha256: outlineSha256 })}\n`)
  return outline
}

export function outlineFixture() {
  return { schema_version: 3 as const, scope: 'technical_bid' as const, document_title: '技术标', global_compliance_ids: [], sections: [
    { id: 'STRUCT', parent_id: null, order: 1, level: 1, title: '实施方案', purpose: '目录', writable: false, must_answer: [], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated' as const, scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [] },
    ...[1, 2, 3].map(index => ({ id: `SEC-${index}`, parent_id: 'STRUCT', order: index, level: 2, title: `章节${index}`, purpose: `回答主题${index}`, writable: true, must_answer: [`回答${index}`], requirement_ids: [`REQ-${index}`], scoring_ids: [`SCORE-${index}`], compliance_ids: [], origin: 'generated' as const, scoring_response_point_ids: [`RP-${String(index).padStart(6, '0')}`], scoring_response_points: [{ scoring_id: `SCORE-${index}`, response_point: `回答评分${index}` }], suggested_tables: [], suggested_figures: [], writing_notes: [] })),
  ] }
}

export function emptyChapterContext(section: ReturnType<typeof outlineFixture>['sections'][number]): ChapterContext {
  return {
    section,
    headingPath: ['实施方案', section.title],
    outlineSections: outlineFixture().sections.map(({ id, parent_id, title, purpose, must_answer }) => (
      { id, parent_id, title, purpose, must_answer }
    )),
    contentPath: 'chapters/sections/0001.md',
    metadataPath: 'chapters/meta/0001.json',
    project: parseTenderProjectArtifact({
      schema_version: 1,
      project_name: '测试项目',
      tender_name: null,
      purchaser: null,
      owner: null,
      project_background: [],
      project_objectives: [],
      project_scope: [],
      technical_scope: [],
      delivery_scope: [],
      implementation_constraints: [],
      key_technical_points: [],
      source_refs: source,
      analyzed_tender_files: ['tender'],
    }),
    requirements: [],
    scoring: [],
    responsePoints: [],
    compliance: [],
    globalCompliance: [],
    relatedMaterials: [],
    referenceBidMaterials: [],
    frameworkDraftMaterials: [],
    webMaterials: [],
    writingDimensions: [],
    missingTopics: [],
    availableLocalCorpus: [],
    localReadLocations: [],
    frameworkReadLocations: [],
    webReadLocations: [],
  }
}
