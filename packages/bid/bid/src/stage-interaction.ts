/** 等待确认期间的 Main Agent 工具、可回放提示与当前阶段资料读取。 */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { BidWorkspace } from './index.ts'
import { buildOutlineView, outlineEditOperationSchema } from './outline-confirmation-edits.ts'
import { getOrCreateOutlineDraft } from './outline-draft-store.ts'
import { parseEvidenceMapArtifact, parseEvidenceMappingPlan } from './evidence-mapping-artifacts.ts'
import { readEvidenceMappingLog, readEvidenceMappingProgress } from './evidence-mapping-executor.ts'
import { parseScoringResponsePointCatalog } from './scoring-response-point-artifacts.ts'
import { parseTenderComplianceArtifact, parseTenderProjectArtifact, parseTenderRequirementsArtifact, parseTenderScoringArtifact } from './tender-analysis-artifacts.ts'
import { parseTenderScoringSelection } from './tender-analysis-confirmation.ts'
import { BID_INITIAL_RUNTIME_STATE, reduceBidRuntimeState } from './runtime-state.ts'
import { parseWritingPlan, writingPlanInputSchema } from './writing-requirements.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const identity = { expected_revision: z.number().int().positive(), expected_draft_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }
const scope = z.array(z.string().min(1)).min(1)

/** 在工具执行入口重新验证阶段操作参数，CAS 必须来自最近一次 inspect。 */
export const stageInteractionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('bid_stage_inspect') }).strict(),
  z.object({ action: z.literal('bid_outline_apply_operations'), ...identity, operations: z.array(outlineEditOperationSchema).min(1) }).strict(),
  z.object({ action: z.literal('bid_outline_regenerate_scope'), ...identity, section_ids: scope, feedback: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal('bid_evidence_remap'), ...identity, section_ids: scope, reason: z.string().optional(), mode: z.enum(['replace', 'supplement']).default('replace') }).strict(),
  writingPlanInputSchema.extend({ action: z.literal('bid_confirm_writing_plan') }).strict(),
])

const names = ['bid_stage_inspect', 'bid_outline_apply_operations', 'bid_outline_regenerate_scope', 'bid_evidence_remap', 'bid_confirm_writing_plan'] as const

/**
 * 判断会话是否拥有 Bid 阶段交互。
 * @param session 当前会话。
 * @returns 仅 Bid Main Agent 可进入阶段交互。
 */
export function isBidMainSession(session: Session): boolean {
  return session.header.origin !== 'subagent' && resolveSessionPreset(session) === 'bid' && session.header.cwd !== undefined
}

/**
 * 从 Bid 项目内的非链接文件读取 JSON。
 * @param workspace 会话工作区。
 * @param path 会话内相对路径。
 * @returns 已拒绝链接路径的 JSON 数据。
 */
export async function readStageJson(workspace: BidWorkspace, path: string): Promise<unknown> {
  const absolute = within(workspace.projectRoot, path)
  await assertNoLinkedPath(workspace.root, absolute)
  return JSON.parse(await readFile(absolute, 'utf8'))
}

async function inspectBidStageValue(workspace: BidWorkspace, session: Session) {
  const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
  const scoringPath = runtime.stage === 'tender_analysis' ? 'analysis/scoring-origin.json' : 'analysis/scoring.json'
  const [project, requirements, scoring, compliance] = await Promise.all([
    readStageJson(workspace, 'analysis/project.json').then(parseTenderProjectArtifact),
    readStageJson(workspace, 'analysis/requirements.json').then(parseTenderRequirementsArtifact),
    readStageJson(workspace, scoringPath).then(parseTenderScoringArtifact),
    readStageJson(workspace, 'analysis/compliance.json').then(parseTenderComplianceArtifact),
  ])
  if (runtime.stage === 'tender_analysis') {
    const selection = parseTenderScoringSelection(await readStageJson(workspace, 'analysis/tender-analysis-selection.json'), scoring)
    return { runtime, project, requirements, scoring, selected_scoring_ids: selection.selected_scoring_ids, compliance }
  }
  if (runtime.stage === 'chapter_writing') {
    const outline = await readStageJson(workspace, 'outline/confirmed-outline.json')
    const evidence = parseEvidenceMapArtifact(await readStageJson(workspace, 'analysis/evidence-map.json'))
    let writing_plan = null
    try { writing_plan = parseWritingPlan(await readStageJson(workspace, 'chapters/writing-plan.json')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { runtime, project, requirements, scoring, compliance, outline, evidence, writing_plan }
  }
  const draft = await getOrCreateOutlineDraft(workspace, false)
  const response_points = parseScoringResponsePointCatalog(await readStageJson(workspace, 'analysis/scoring-response-points.json'))
  const evidence = runtime.stage === 'evidence_mapping' ? parseEvidenceMapArtifact(await readStageJson(workspace, 'analysis/evidence-map.json')) : null
  const mappings = new Map(evidence?.section_mappings.map(item => [item.section_id, item]))
  return {
    runtime, project, requirements, scoring, compliance, response_points, draft,
    sections: buildOutlineView(draft.outline.sections).map(item => ({ ...item,
      evidence: mappings.get(item.section.id) ?? null,
      local_material_count: mappings.get(item.section.id)?.local_materials.length ?? 0,
      web_material_count: mappings.get(item.section.id)?.web_materials.length ?? 0,
    })),
    writable_section_ids: draft.outline.sections.filter(item => item.writable).map(item => item.id),
    mapping_plan: runtime.stage === 'evidence_mapping' ? parseEvidenceMappingPlan(await readStageJson(workspace, 'analysis/evidence-mapping-plan.json')) : null,
    mapping_progress: runtime.stage === 'evidence_mapping' ? await readEvidenceMappingProgress(workspace) : null,
    mapping_tasks: runtime.stage === 'evidence_mapping' ? (await readEvidenceMappingLog(workspace))?.tasks ?? [] : [],
  }
}

/**
 * 从权威产物和会话日志组装当前 Bid 阶段交互快照。
 * @param workspace 会话工作区。
 * @param session 读取状态的会话。
 * @returns 最新目录编号、CAS 与阶段资料，不从聊天历史推测。
 */
export function inspectBidStage(
  workspace: BidWorkspace, session: Session,
): ReturnType<typeof inspectBidStageValue> {
  return inspectBidStageValue(workspace, session)
}

/**
 * 渲染等待用户阶段的模型交互规则。
 * @param stage 当前阶段。
 * @returns 通过 user/message 入日志的交互规则。
 */
export function renderStageInteractionPrompt(stage: string): string {
  if (stage === 'chapter_writing') return [
    '当前 Bid 阶段：chapter_writing；当前状态：waiting_user。',
    '正式写作尚未开始。先调用 bid_stage_inspect，结合已确认目录、招标要求和资料映射理解用户的自然语言要求。',
    '只追问影响执行的关键歧义或冲突。资料不足、能力限制或招标要求冲突必须指出并提出处理建议；需要改变目录时，引导用户重置并重新确认 S4，不得偷偷改目录。',
    '保留用户原话。没有特殊要求时，仍应按招标要求、目录和现有资料形成默认计划。未提供的指标不得变成用户硬性要求。',
    '有特殊要求时，先用简短中文说明你的理解、重点和篇幅安排并请用户确认；用户已明确说“按这些要求直接开始”或“没有特殊要求，直接开始”时无需再次确认。',
    '页数是排版估算：约、至少、不超过或区间分别使用 approximate、minimum、maximum、range，未使用的一侧边界填 null，并写明模板或排版估算依据；不得承诺排版前的精确实际页数。把整书目标分配给全部可写叶节，不能给父节点预算，也不能机械平均或靠重复内容凑页数。',
    '获得确认或直接开始授权后调用 bid_confirm_writing_plan。user_requirements 必须逐条原样复制本次门禁期间的用户表述；Host 会与既有原话合并。sections 必须覆盖每个可写叶节且只出现一次。没有整书页数要求时 page_target 和所有 page_budget 都填 null；有目标时，叶节预算上下限之和必须分别等于整书上下限。',
    '首次计划的 revision 填 null。修改既有计划时，revision.summary 说明调整安排，revision.affected_section_ids 只列按新要求需要改写的可写叶节；未开始任务自动采用新计划，已完成的受影响章节及其强依赖下游会定向重写。全局变化确实影响全部正文时才列出全部叶节。',
    '工具成功即完成确认；随后 Host 会在本轮结束后启动既有章节写作与审核链路。不要直接 write Artifact 或调用其他工具启动章节任务。',
  ].join('\n')
  return [
    `当前 Bid 阶段：${stage}；当前状态：waiting_user。`,
    '你正在与用户进行当前阶段的交互修改。先调用 bid_stage_inspect 读取最新目录、评分点、资料和缺口。',
    '按 inspect 返回的 number、标题和父子关系，把“第三章”“3.2”“服务方案下面第二个”解析到实际 section.id；编号不是 Section ID。只有存在歧义时才询问用户，不要求用户提供内部 ID。',
    '只能使用当前可见阶段工具修改目录或资料，不得直接 write Artifact、调用其他工具绕过校验或自动推进阶段。',
    '目录拆分用 split_section，合并同级可写叶子用 merge_sections；局部重生成用 bid_outline_regenerate_scope。修改后重新 inspect 获取新 ID 与 revision。',
    '资料不对、重新匹配用 bid_evidence_remap(mode=replace)；资料不足、再补充用 supplement。传具体章节只处理该章节，传结构分支处理其可写后代。标题微调不强制 remap；用户要求修改并重新找资料时，修改后 remap 新范围。',
    '普通聊天中的“可以”“没问题”“这样可以吗”不是正式确认。修改完成后告知“已更新，请重新确认”，只有用户点击正式确认按钮才能进入下一阶段。',
  ].join('\n')
}

/**
 * 按实时阶段安装 scoped tools；全局 guard 拒绝交互期间的其他 Main Agent 工具调用。
 * @param ctx Host 插件上下文，负责全部注册释放。
 * @param execute 共享 Host 操作入口。
 * @param interacting 当前会话是否仍被阶段交互操作占用。
 */
export function installStageInteractionTools(
  ctx: Context,
  execute: (agent: Agent, request: unknown, signal: AbortSignal) => Promise<unknown>,
  interacting: (session: Session) => boolean,
): void {
  ctx.inject(['tools'], (toolCtx) => {
    const mounted = new Map<Agent, { stage: string; dispose: () => void }>()
    const sync = (agent: Agent): void => {
      const runtime = agent.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      const stage = isBidMainSession(agent.session) && runtime.status === 'waiting_user' ? runtime.stage : undefined
      const existing = mounted.get(agent)
      if (existing?.stage === stage) return
      existing?.dispose()
      mounted.delete(agent)
      if (stage === undefined) return
      const tools = agent.ctx.get('tools')
      if (tools === undefined) throw new Error('Bid stage interaction requires tools')
      const available = stage === 'tender_analysis' ? names.slice(0, 1)
        : stage === 'outline_generation' ? names.slice(0, 3)
          : stage === 'evidence_mapping' ? names.slice(0, 4) : [names[0], names[4]]
      const disposers: Array<() => void> = []
      const text: JsonSchemaNode = { type: 'string' }
      const strings: JsonSchemaNode = { type: 'array', items: text }
      const cas = { expected_revision: { type: 'integer' as const }, expected_draft_sha256: text }
      try {
        disposers.push(tools.restrict({ allow: [] }))
        for (const name of available) {
          const properties: Record<string, JsonSchemaNode> = name === 'bid_stage_inspect' || name === 'bid_confirm_writing_plan' ? {} : { ...cas }
          const required = Object.keys(properties)
          if (name === 'bid_outline_apply_operations') {
            properties.operations = { type: 'array', items: { type: 'object' }, description: '按 type 提交操作：update_section(section_id,title?,purpose?,must_answer?)；add_section(parent_id,order,writable,title,purpose,must_answer?)；delete_section(section_id)；move_section(section_id,parent_id,order)；split_section(section_id,children:[{title,purpose,must_answer}])；merge_sections(section_ids,title,purpose)。' }
            required.push('operations')
          }
          if (name === 'bid_outline_regenerate_scope' || name === 'bid_evidence_remap') {
            properties.section_ids = strings
            required.push('section_ids')
          }
          if (name === 'bid_outline_regenerate_scope') { properties.feedback = text; required.push('feedback') }
          if (name === 'bid_evidence_remap') { properties.reason = text; properties.mode = { type: 'string', enum: ['replace', 'supplement'] } }
          if (name === 'bid_confirm_writing_plan') {
            properties.user_requirements = strings
            properties.overall_goal = text
            properties.style_rules = strings
            properties.global_rules = strings
            properties.priorities = { type: 'array', items: {
              type: 'object', properties: { section_ids: strings, instruction: text },
              required: ['section_ids', 'instruction'], additionalProperties: false,
            } }
            properties.page_target = { oneOf: [{
              type: 'object', properties: {
                kind: { type: 'string', enum: ['approximate', 'minimum', 'maximum', 'range'] },
                min_pages: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                max_pages: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                estimate_basis: text,
              }, required: ['kind', 'min_pages', 'max_pages', 'estimate_basis'], additionalProperties: false,
            }, { type: 'null' }] }
            const pageBudget: JsonSchemaNode = { oneOf: [{
              type: 'object', properties: {
                min_pages: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                max_pages: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              },
              required: ['min_pages', 'max_pages'], additionalProperties: false,
            }, { type: 'null' }] }
            properties.sections = { type: 'array', items: {
              type: 'object', properties: {
                section_id: text, emphasis: { type: 'string', enum: ['concise', 'standard', 'detailed'] },
                page_budget: pageBudget, instructions: strings,
              }, required: ['section_id', 'emphasis', 'page_budget', 'instructions'], additionalProperties: false,
            } }
            properties.revision = { oneOf: [{
              type: 'object', properties: { summary: text, affected_section_ids: strings },
              required: ['summary', 'affected_section_ids'], additionalProperties: false,
            }, { type: 'null' }] }
            required.push('user_requirements', 'overall_goal', 'style_rules', 'global_rules', 'priorities', 'page_target', 'sections', 'revision')
          }
          const definition: ToolDefinition = {
            name,
            description: name === 'bid_stage_inspect' ? '读取当前阶段、最新目录编号与真实 ID、Draft CAS、评分关联和资料缺口。'
              : name === 'bid_confirm_writing_plan' ? '保存已获用户确认或直接开始授权的整体写作计划；成功后 Host 启动既有 S5 写作链路。'
                : name === 'bid_evidence_remap' ? '只重新研究选中章节或分支。replace 替换旧证据；supplement 保留并补充。完成后等待用户正式确认。'
                  : name === 'bid_outline_regenerate_scope' ? '按反馈局部重生成选中章节，保留范围外目录。完成后等待正式确认。'
                    : '使用最新 Draft CAS 执行结构化目录编辑，不直接写文件；返回更新后的目录，仍需正式确认。',
            parameters: { type: 'object', properties, required, additionalProperties: false },
            output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            async execute(args, exec) {
              if (exec.agent !== agent) throw new Error('BID_ACTION_NOT_ALLOWED')
              return execute(agent, { ...(args as Record<string, unknown>), action: name }, exec.signal)
            },
            presentCall: () => ({ card: 'generic', title: name }),
          }
          disposers.push(tools.register(definition))
        }
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose()
        throw error
      }
      mounted.set(agent, { stage, dispose: () => { for (const dispose of disposers.reverse()) dispose() } })
    }
    toolCtx.effect(() => toolCtx.tools.guard((exec) => {
      const session = exec.agent?.session
      if (session === undefined || !isBidMainSession(session)) return
      const runtime = session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if ((runtime.status === 'waiting_user' || interacting(session)) && !names.includes(exec.name as typeof names[number])) return 'BID_STAGE_TOOL_REQUIRED'
    }))
    toolCtx.on('agent/session-start', ({ agent }) => { sync(agent) }, { global: true })
    toolCtx.on('session/event', (session, event) => {
      if (!event.type.startsWith('bid.')) return
      const agent = ctx.agents.get(session.id)
      if (agent !== undefined) sync(agent)
    }, { global: true })
    toolCtx.on('agent/disposed', ({ agent }) => { mounted.get(agent)?.dispose(); mounted.delete(agent) }, { global: true })
    toolCtx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next()
      const runtime = agent.session.events.reduce(reduceBidRuntimeState, BID_INITIAL_RUNTIME_STATE)
      if (decision.kind === 'reject' || !isBidMainSession(agent.session) || runtime.status !== 'waiting_user' || !messages.some(message => message.source.kind === 'user')) return decision
      return { kind: 'enter', messages: [createUserMessage({ content: [{ type: 'text', text: renderStageInteractionPrompt(runtime.stage) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' } }), ...decision.messages] }
    }, { global: true })
    for (const agent of ctx.agents.list()) sync(agent)
    toolCtx.effect(() => () => { for (const value of mounted.values()) value.dispose(); mounted.clear() })
  })
}
