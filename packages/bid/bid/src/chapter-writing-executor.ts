import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type {} from '@deepseek-ai/dsh-tools'
import type { BidWorkspace } from './index.ts'
import { CHAPTER_WRITING_SCHEMA_VERSION, parseChapterMetadata, type ChapterManifestEntry } from './chapter-writing-artifacts.ts'
import type { BidStageTask, StageArtifact } from './control-plane-contract.ts'
import { parseEvidenceMapArtifact, type EvidenceMaterial } from './evidence-mapping-artifacts.ts'
import { parseConfirmedOutlineArtifact, parseOutlineConfirmationArtifact, outlineArtifactSha256 } from './outline-confirmation-artifacts.ts'
import type { OutlineArtifact, OutlineSection } from './outline-generation-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { assertNoLinkedPath } from './workspace-path.ts'

/** Focused inputs and output locations for one sequential S6 chapter task. */
export interface ChapterContext {
  section: OutlineSection
  contentPath: string
  metadataPath: string
  project: ReturnType<typeof parseTenderProjectArtifact>
  requirements: ReturnType<typeof parseTenderRequirementsArtifact>['requirements']
  scoring: ReturnType<typeof parseTenderScoringArtifact>['scoring_items']
  compliance: ReturnType<typeof parseTenderComplianceArtifact>['compliance_items']
  evidence: EvidenceMaterial[]
  missingTopics: string[]
}

/** Return writable sections in their confirmed parent/order traversal order. */
export function buildChapterWorklist(outline: OutlineArtifact): OutlineSection[] {
  const children = new Map<string | null, OutlineSection[]>()
  for (const section of outline.sections) {
    const siblings = children.get(section.parent_id) ?? []
    siblings.push(section)
    children.set(section.parent_id, siblings)
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const ordered: OutlineSection[] = []
  const visit = (parentId: string | null): void => {
    for (const section of children.get(parentId) ?? []) {
      ordered.push(section)
      visit(section.id)
    }
  }
  visit(null)
  return ordered.filter(section => section.writable)
}

function pickChapterContext(raw: {
  section: OutlineSection
  sequence: number
  project: ReturnType<typeof parseTenderProjectArtifact>
  requirements: ReturnType<typeof parseTenderRequirementsArtifact>
  scoring: ReturnType<typeof parseTenderScoringArtifact>
  compliance: ReturnType<typeof parseTenderComplianceArtifact>
  evidence: ReturnType<typeof parseEvidenceMapArtifact>
  globalComplianceIds: readonly string[]
}): ChapterContext {
  const requirementIds = new Set(raw.section.requirement_ids)
  const scoringIds = new Set(raw.section.scoring_ids)
  const complianceIds = new Set([...raw.section.compliance_ids, ...raw.globalComplianceIds])
  const mappings = [
    ...raw.evidence.requirement_mappings.filter(mapping => requirementIds.has(mapping.requirement_id)),
    ...raw.evidence.scoring_mappings.filter(mapping => scoringIds.has(mapping.scoring_id)),
  ]
  return {
    section: raw.section,
    contentPath: `chapters/sections/${String(raw.sequence).padStart(4, '0')}.md`,
    metadataPath: `chapters/meta/${String(raw.sequence).padStart(4, '0')}.json`,
    project: raw.project,
    requirements: raw.requirements.requirements.filter(item => requirementIds.has(item.id)),
    scoring: raw.scoring.scoring_items.filter(item => scoringIds.has(item.id)),
    compliance: raw.compliance.compliance_items.filter(item => complianceIds.has(item.id)),
    evidence: mappings.flatMap(mapping => mapping.materials),
    missingTopics: mappings.flatMap(mapping => mapping.missing_topics),
  }
}

/** Render exactly one focused S6 chapter-writing assignment. */
export function renderChapterWritingTask(agent: Agent, workspace: BidWorkspace, context: ChapterContext): string {
  const root = relative(workspace.root, workspace.sessionRoot).replaceAll('\\', '/')
  const global = {
    project_name: context.project.project_name,
    tender_name: context.project.tender_name,
    purchaser: context.project.purchaser,
    project_scope: context.project.project_scope,
    technical_scope: context.project.technical_scope,
    delivery_scope: context.project.delivery_scope,
  }
  return [
    '当前阶段：chapter_writing',
    `Bid Session：${agent.id}`,
    `Session Workspace：${root}`,
    `当前章节 section_id：${context.section.id}`,
    `唯一允许写入的正文文件：${root}/${context.contentPath}`,
    `唯一允许写入的元数据文件：${root}/${context.metadataPath}`,
    '只编写当前 writable section；不得新增、删除或重排正式目录，且不得修改任何已有 Artifact 或 manifest。',
    '正文紧扣 purpose，逐项回答 must_answer，优先覆盖评分关注点并满足合规规则。企业事实、产品参数、人员经验和既有能力必须由本地 Evidence 支撑；技术方案可依据本项目要求、Blueprint 和通用技术知识设计。不得虚构数字、标准号、企业能力或历史项目事实；不得出现“根据提供资料”或“作为 AI”。',
    'Evidence 仅可在 read 对应 chunk 后使用。若需补充资料，可仅为当前章节 grep，再 read 候选 chunk；web_search 和 bash 禁止。不得将 grep 命中直接当作事实。',
    '正文只保存本章节内容，不要重复正式章节标题树。建议表格适合时可使用 Markdown 表格；suggested_figures 仅作写作提示。',
    `Global Technical Context：${JSON.stringify(global)}`,
    `Current Blueprint：${JSON.stringify(context.section)}`,
    `Relevant Requirements：${JSON.stringify(context.requirements)}`,
    `Relevant Scoring：${JSON.stringify(context.scoring)}`,
    `Relevant Compliance：${JSON.stringify(context.compliance)}`,
    `Relevant Evidence refs：${JSON.stringify(context.evidence)}`,
    `Missing topics：${JSON.stringify(context.missingTopics)}`,
    '元数据必须是严格 JSON：{"section_id":"...","covered_must_answer":[...],"evidence_used":[{"file_id":"...","chunk":"...","line_start":1,"line_end":1,"usage":"adapt","summary":"..."}],"additional_materials":[],"unresolved_topics":[]}。covered_must_answer 必须只列实际回答的当前 must_answer；普通技术设计不能仅因缺少历史资料记为 unresolved。',
    '写完这两个文件后停止；Host 会独立校验路径、目录覆盖、Evidence 和元数据。',
  ].join('\n')
}

async function readJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const target = join(workspace.sessionRoot, path)
  await assertNoLinkedPath(workspace.root, target)
  return JSON.parse(await readFile(target, 'utf8'))
}

/** Execute all chapter tasks sequentially and programmatically publish their manifest. */
export async function executeChapterWriting(agent: Agent, workspace: BidWorkspace, task: BidStageTask): Promise<StageArtifact[]> {
  if (task.stage !== 'chapter_writing') throw new Error('chapter-writing-executor-stage-invalid')
  await agent.whenIdle()
  const [outlineRaw, confirmationRaw, projectRaw, requirementsRaw, scoringRaw, complianceRaw, evidenceRaw] = await Promise.all([
    readJson(workspace, 'outline/confirmed-outline.json'), readJson(workspace, 'outline/confirmation.json'),
    readJson(workspace, 'analysis/project.json'),
    readJson(workspace, 'analysis/requirements.json'), readJson(workspace, 'analysis/scoring.json'),
    readJson(workspace, 'analysis/compliance.json'), readJson(workspace, 'analysis/evidence-map.json'),
  ])
  const outline = parseConfirmedOutlineArtifact(outlineRaw)
  const confirmation = parseOutlineConfirmationArtifact(confirmationRaw)
  if (confirmation.confirmed_outline_sha256 !== outlineArtifactSha256(outline)) throw new Error('chapter-writing-confirmed-outline-mismatch')
  const project = parseTenderProjectArtifact(projectRaw)
  const requirements = parseTenderRequirementsArtifact(requirementsRaw)
  const scoring = parseTenderScoringArtifact(scoringRaw)
  const compliance = parseTenderComplianceArtifact(complianceRaw)
  const evidence = parseEvidenceMapArtifact(evidenceRaw)
  const chaptersRoot = join(workspace.sessionRoot, 'chapters')
  await assertNoLinkedPath(workspace.root, chaptersRoot)
  await rm(chaptersRoot, { recursive: true, force: true })
  await mkdir(join(chaptersRoot, 'sections'), { recursive: true, mode: 0o700 })
  await mkdir(join(chaptersRoot, 'meta'), { recursive: true, mode: 0o700 })
  const fs = agent.ctx.get('fs')
  const tools = agent.ctx.get('tools')
  if (fs === undefined || tools === undefined) throw new Error('Bid chapter writing requires fs and tools services')
  const entries: ChapterManifestEntry[] = []
  for (const [index, section] of buildChapterWorklist(outline).entries()) {
    const context = pickChapterContext({
      section, sequence: index + 1, project, requirements, scoring, compliance, evidence,
      globalComplianceIds: outline.global_compliance_ids,
    })
    const target = await fs.resolve(join(workspace.sessionRoot, context.contentPath))
    agent.ctx.emit('fs/observed', target, { kind: 'absent' }, { agent })
    const allowed = new Set(task.allowedTools)
    const liftRestriction = tools.restrict({ allow: task.allowedTools })
    const liftGuard = tools.guard(exec => allowed.has(exec.name) ? undefined : `Bid stage chapter_writing allows only ${task.allowedTools.join(', ')}`)
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: renderChapterWritingTask(agent, workspace, context) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }))
      await agent.whenIdle()
    } finally {
      liftGuard()
      liftRestriction()
    }
    const metadata = parseChapterMetadata(await readJson(workspace, context.metadataPath))
    entries.push({
      section_id: metadata.section_id,
      content_path: context.contentPath,
      requirement_ids: [...section.requirement_ids], scoring_ids: [...section.scoring_ids],
      compliance_ids: [...section.compliance_ids, ...outline.global_compliance_ids],
      covered_must_answer: metadata.covered_must_answer,
      evidence_used: metadata.evidence_used,
      additional_materials: metadata.additional_materials,
      unresolved_topics: metadata.unresolved_topics,
    })
  }
  await writeFile(join(chaptersRoot, 'manifest.json'), `${JSON.stringify({ schema_version: CHAPTER_WRITING_SCHEMA_VERSION, scope: 'technical_bid', confirmed_outline_sha256: outlineArtifactSha256(outline), chapters: entries }, null, 2)}\n`, { mode: 0o600 })
  return [{ stage: 'chapter_writing', type: 'chapter_manifest', path: 'chapters/manifest.json' }]
}
