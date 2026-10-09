/** S4 目录审查按估算 token 分片，并保留每个章节及所有跨片职责关系。 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'

/** 一个审查请求的完整输入及由程序绑定的覆盖位置。 */
export interface OutlineReviewRequest {
  prompt: string
  sectionPositions: number[]
  cardPositions: number[]
  estimatedInputTokens: number
  kind: 'complete' | 'sections' | 'cross_sections'
  /** 硬预算分组时实际提供的字段及完整字符串范围，由程序核对覆盖。 */
  evidenceParts?: OutlineReviewEvidencePart[]
}

/** 保留字段位置与原文身份的无损审查分段；偏移使用 UTF-16 字符位置。 */
interface OutlineReviewEvidencePart {
  path: Array<string | number>
  value: unknown
  start?: number
  end?: number
  total?: number
  source?: Omit<OutlineReviewSource, 'text'>
}

/** 分片前的共享职责索引和叶子审查资料。 */
export interface OutlineReviewContext {
  instructions: string
  detailInstructions?: string
  cards: Array<{ section_id: string; [key: string]: unknown }>
  index: Array<{ position: number; id: string; [key: string]: unknown }>
  coverage: unknown
  differences: unknown
  operations: unknown
  sources?: readonly OutlineReviewSource[]
  projectSourceKeys?: readonly string[]
  evidenceParts?: OutlineReviewEvidencePart[]
}

/** Host 校验并按采购文件身份去重的完整审核原文。 */
export interface OutlineReviewSource {
  key: string
  file_id: string
  name: string
  chunk: string
  text: string
  line_count: number
}

/** 详细卡片判断与共享索引关系判断采用不同的接纳范围。 */
export type OutlineReviewIssueKind = 'detail' | 'relationship' | 'coverage' | 'user_request'

/**
 * 将复核意见绑定到本片可审查的章节；索引可见不能替代详细卡片。
 * @param issue 模型选择的章节、问题类型和业务理由。
 * @param request 当前请求拥有的索引及详细卡片位置。
 * @param sections 全书章节，位置与当前索引一致。
 * @returns 可供局部修复的章节身份与理由；越权意见抛出工具参数诊断。
 */
export function bindOutlineReviewIssue(issue: { section_position: number; issue_kind: OutlineReviewIssueKind; reason: string },
  request: OutlineReviewRequest, sections: readonly { id: string }[]): { section_id: string; reason: string } {
  const section = sections[issue.section_position]
  if (section === undefined || !request.sectionPositions.includes(issue.section_position)) {
    throw new ToolArgsError([`section_position: 不属于本片职责索引；可选位置：${JSON.stringify(request.sectionPositions)}。`])
  }
  if (issue.issue_kind === 'detail' && !request.cardPositions.includes(issue.section_position)) {
    throw new ToolArgsError([`section_position: 本片没有该章详细卡片，不可阻断其展开粒度；详细位置：${JSON.stringify(request.cardPositions)}。`])
  }
  return { section_id: section.id, reason: issue.reason }
}

/** 单个审查对象无法放入剩余输入预算；禁止截断其内容。 */
export class OutlineReviewContextTooLargeError extends Error {
  constructor(readonly position: number | undefined, readonly inputTokens: number, readonly budgetTokens: number) {
    super(`目录审查对象超过输入预算：位置 ${String(position)}，估算 ${String(inputTokens)} token，预算 ${String(budgetTokens)} token。`)
  }
}

function renderOutlineReviewRequest(
  input: OutlineReviewContext,
  cards: OutlineReviewContext['cards'],
  index: OutlineReviewContext['index'],
  kind: OutlineReviewRequest['kind'],
): OutlineReviewRequest {
  const cardPositions = index.filter(item => cards.some(card => card.section_id === item.id)).map(item => item.position)
  const sourceKeys = new Set([...(input.projectSourceKeys ?? []), ...(kind === 'complete' ? [...cards, ...index] : cards.length === 0 ? index : cards)
    .flatMap(item => item.source_keys as string[] | undefined ?? [])])
  const sources = (input.sources ?? []).filter(source => sourceKeys.has(source.key))
  const prompt = [input.instructions,
    ...(kind === 'cross_sections' ? [] : [input.detailInstructions ?? '']),
    ...(kind === 'cross_sections' ? ['本轮复核共享职责索引的所有章节关系，特别核对不同分片之间的职责冲突、重复、断裂和覆盖关系。详细叶子审查由独立请求完成。'] : []),
    `本片详细卡片位置：${JSON.stringify(cardPositions)}；只有这些位置允许 issue_kind=detail。其他可见位置仅审查职责关系、覆盖和用户目标。`,
    `Structure Review Cards：${JSON.stringify(cards)}`,
    ...(input.sources === undefined ? [] : [`采购原文：${JSON.stringify(sources)}`]),
    `全书覆盖依据：${JSON.stringify(input.coverage)}`,
    `全书职责索引：${JSON.stringify(index)}`,
    `S3→S4 结构 diff：${JSON.stringify(input.differences)}`,
    `实际 Outline Operations：${JSON.stringify(input.operations)}`,
    ...(input.evidenceParts === undefined ? [] : [
      '本片只核对以下字段和原文分段。path、来源和 start/end 由程序绑定；未在本片出现不能判为缺证。全部分段成功后程序才接纳完整审核，不宣称已读未提供的原文。',
      `本片依据分段：${JSON.stringify(input.evidenceParts)}`,
    ]),
  ].join('\n')
  return { prompt, kind, sectionPositions: index.map(item => item.position), cardPositions,
    ...(input.evidenceParts === undefined ? {} : { evidenceParts: input.evidenceParts }),
    estimatedInputTokens: estimateMessage(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })) }
}

/**
 * 为已确定范围的复核构造一个完整请求，按全部输入预算校验且不生成其他分片。
 * @param input 已选定的详细卡片、职责索引及完整复核依据。
 * @param budgetTokens 已扣除 system、工具和输出余量后的输入 token 预算。
 * @returns 完整请求及实际卡片权限；整体超限时抛错，不截断依据。
 */
export function buildOutlineReviewRequest(input: OutlineReviewContext, budgetTokens: number): OutlineReviewRequest {
  const request = renderOutlineReviewRequest(input, input.cards, input.index, 'complete')
  if (request.estimatedInputTokens > budgetTokens) {
    throw new OutlineReviewContextTooLargeError(undefined, request.estimatedInputTokens, budgetTokens)
  }
  return request
}

/**
 * 按目标预算组装完整章节；硬预算不足时无损细分业务字段和原文，共享索引逐对检查跨片职责关系。
 * @param input - 全量审查依据及程序绑定位置。
 * @param budgetTokens - 已扣除 system、工具和输出余量后的输入 token 预算。
 * @param targetTokens - 常规分片目标；不可拆分的单章或跨片关系可使用剩余模型预算。
 * @returns 全部必需请求及程序绑定的覆盖位置；最小请求仍超限时抛错。
 */
export function buildOutlineReviewRequests(
  input: OutlineReviewContext, budgetTokens: number, targetTokens = budgetTokens,
): OutlineReviewRequest[] {
  try { return buildWholeOutlineReviewRequests(input, budgetTokens, targetTokens) } catch (error) {
    if (!(error instanceof OutlineReviewContextTooLargeError)) throw error
    return buildPartitionedOutlineReviewRequests(input, budgetTokens)
  }
}

function buildWholeOutlineReviewRequests(
  input: OutlineReviewContext, budgetTokens: number, targetTokens: number,
): OutlineReviewRequest[] {
  const target = Math.min(targetTokens, budgetTokens)
  const render = (cards: OutlineReviewContext['cards'], index: OutlineReviewContext['index'], kind: OutlineReviewRequest['kind']) =>
    renderOutlineReviewRequest(input, cards, index, kind)
  const complete = render(input.cards, input.index, 'complete')
  if (complete.estimatedInputTokens <= target) return [complete]
  const assertFits = (request: OutlineReviewRequest, position?: number): void => {
    if (request.estimatedInputTokens > budgetTokens) {
      throw new OutlineReviewContextTooLargeError(position, request.estimatedInputTokens, budgetTokens)
    }
  }
  assertFits(render([], [], 'sections'))
  const requests: OutlineReviewRequest[] = []
  const sharedIndexFits = render([], input.index, 'sections').estimatedInputTokens <= Math.floor(target / 2)
  let cardBatch: OutlineReviewContext['cards'] = []
  const sectionRequest = (cards: OutlineReviewContext['cards']) => render(cards,
    sharedIndexFits ? input.index : input.index.filter(item => cards.some(card => card.section_id === item.id)), 'sections')
  for (const card of input.cards) {
    const candidate = sectionRequest([...cardBatch, card])
    if (candidate.estimatedInputTokens > target && cardBatch.length > 0) {
      requests.push(sectionRequest(cardBatch))
      cardBatch = []
    }
    assertFits(sectionRequest([card]), input.index.find(item => item.id === card.section_id)?.position)
    cardBatch.push(card)
  }
  if (cardBatch.length > 0) requests.push(sectionRequest(cardBatch))
  const fixed = render([], [], 'cross_sections').estimatedInputTokens
  const relationBudget = Math.min(budgetTokens, Math.max(target, fixed + Math.floor(target / 2)))
  const crossSections = render([], input.index, 'cross_sections')
  if (crossSections.estimatedInputTokens <= relationBudget) {
    requests.push(crossSections)
    return requests
  }
  // 公共依据占满目标时仍为索引保留空间；两片配对和大单节点均受模型硬上限约束。
  const indexBudget = fixed + Math.floor((relationBudget - fixed) / 2)
  const indexBatches: OutlineReviewContext['index'][] = []
  let indexBatch: OutlineReviewContext['index'] = []
  for (const item of input.index) {
    const candidate = render([], [...indexBatch, item], 'cross_sections')
    if (candidate.estimatedInputTokens > indexBudget && indexBatch.length > 0) {
      indexBatches.push(indexBatch)
      indexBatch = []
    }
    const single = render([], [item], 'cross_sections')
    assertFits(single, item.position)
    indexBatch.push(item)
  }
  if (indexBatch.length > 0) indexBatches.push(indexBatch)
  for (const [left, leftBatch] of indexBatches.entries()) {
    for (const [offset, rightBatch] of indexBatches.slice(left).entries()) {
      const request = render([], offset === 0 ? leftBatch : [...leftBatch, ...rightBatch], 'cross_sections')
      assertFits(request)
      requests.push(request)
    }
  }
  return requests
}

function buildPartitionedOutlineReviewRequests(input: OutlineReviewContext, budget: number): OutlineReviewRequest[] {
  const requests: OutlineReviewRequest[] = []
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const scope = (cards: OutlineReviewContext['cards'], index: OutlineReviewContext['index'], kind: OutlineReviewRequest['kind'],
    details = kind !== 'cross_sections') => {
    const ids = new Set(index.map(item => item.id))
    const sourceKeys = new Set(!details ? [] : [...(input.projectSourceKeys ?? []), ...(cards.length === 0 ? index : cards)
      .flatMap(item => item.source_keys as string[] | undefined ?? [])])
    const businessIds = new Set(cards.flatMap(card => ['requirements', 'scoring', 'response_points', 'compliance']
      .flatMap(key => (card[key] as Array<{ id: string }> | undefined ?? []).map(item => item.id)))
      .concat(details ? index.flatMap(item => item.coverage_ids as string[] | undefined ?? []) : []))
    const coverage = record(input.coverage)
    const selectedCoverage = coverage === undefined ? input.coverage : Object.fromEntries(Object.entries(coverage)
      .map(([key, value]) => [key, Array.isArray(value) ? value.filter((item) => {
        const business = record(item)
        return business === undefined || businessIds.has(String(business.id)) || !details
      }).map((item: unknown) => {
        const business = record(item)
        return !details && business !== undefined ? { id: business.id } : item
      })
        : !details ? undefined : value]))
    const related = (value: unknown) => {
      const item = record(value)
      return item === undefined || (typeof item.section_id === 'string' ? ids.has(item.section_id)
        : Array.isArray(item.section_ids) ? item.section_ids.some(id => ids.has(String(id))) : true)
    }
    const payload = { cards, index, coverage: selectedCoverage,
      differences: Array.isArray(input.differences) ? input.differences.filter(related) : input.differences,
      operations: Array.isArray(input.operations) ? input.operations.filter(related) : input.operations }
    const compactIndex = index.map(({ position, id, parent_id, title, writable }) => ({ position, id, parent_id, title, writable }))
    const compactCards = cards.map(({ section_id, title }) => ({ section_id, title }))
    const render = (parts: OutlineReviewEvidencePart[]) => renderOutlineReviewRequest({ ...input,
      sources: [], coverage: { requirements: [], scoring: [], response_points: [], compliance: [] },
      differences: [], operations: [], evidenceParts: parts,
    }, compactCards, compactIndex, kind)
    const empty = render([])
    if (empty.estimatedInputTokens >= budget) {
      throw new OutlineReviewContextTooLargeError(index[0]?.position, empty.estimatedInputTokens, budget)
    }
    let batch: OutlineReviewEvidencePart[] = []
    const add = (part: OutlineReviewEvidencePart): void => {
      if (render([...batch, part]).estimatedInputTokens <= budget) { batch.push(part); return }
      if (batch.length > 0) { requests.push(render(batch)); batch = [] }
      if (render([part]).estimatedInputTokens <= budget) { batch.push(part); return }
      const object = record(part.value)
      const entries = Array.isArray(part.value) ? part.value.map((value, position) => [position, value] as const)
        : object === undefined ? [] : Object.entries(object)
      if (entries.length > 0) {
        for (const [key, value] of entries) add({ ...part, path: [...part.path, key], value })
      } else if (typeof part.value === 'string' && part.value.length > 1) {
        let middle = Math.floor(part.value.length / 2)
        if (/^[\uDC00-\uDFFF]$/u.test(part.value.charAt(middle))) middle--
        if (middle === 0) throw new OutlineReviewContextTooLargeError(index[0]?.position, render([part]).estimatedInputTokens, budget)
        const start = part.start ?? 0
        const total = part.total ?? part.value.length
        add({ ...part, value: part.value.slice(0, middle), start, end: start + middle, total })
        add({ ...part, value: part.value.slice(middle), start: start + middle, end: start + part.value.length, total })
      } else throw new OutlineReviewContextTooLargeError(index[0]?.position, render([part]).estimatedInputTokens, budget)
    }
    // 先保留完整业务记录；只有该记录仍超限时才沿字段或原文位置细分。
    for (const [key, value] of Object.entries(payload)) add({ path: [key], value })
    for (const source of input.sources ?? []) {
      if (!sourceKeys.has(source.key)) continue
      const { text, ...identity } = source
      add({ path: ['sources', source.key, 'text'], value: text, source: identity, start: 0, end: text.length, total: text.length })
    }
    if (batch.length > 0) requests.push(render(batch))
  }
  for (const card of input.cards) scope([card], input.index.filter(item => item.id === card.section_id), 'sections')
  for (const item of input.index.filter(item => !input.cards.some(card => card.section_id === item.id))) {
    scope([], [item], 'cross_sections', true)
  }
  // 每对职责都在同一关系范围内复核，原文和业务详情由各章分段核对。
  for (const [left, item] of input.index.entries()) for (const right of input.index.slice(left)) {
    scope([], item === right ? [item] : [item, right], 'cross_sections')
  }
  return requests
}
