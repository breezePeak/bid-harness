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
  const prompt = [input.instructions,
    ...(kind === 'cross_sections' ? [] : [input.detailInstructions ?? '']),
    ...(kind === 'cross_sections' ? ['本轮复核共享职责索引的所有章节关系，特别核对不同分片之间的职责冲突、重复、断裂和覆盖关系。详细叶子审查由独立请求完成。'] : []),
    `本片详细卡片位置：${JSON.stringify(cardPositions)}；只有这些位置允许 issue_kind=detail。其他可见位置仅审查职责关系、覆盖和用户目标。`,
    `Structure Review Cards：${JSON.stringify(cards)}`,
    `全书覆盖依据：${JSON.stringify(input.coverage)}`,
    `全书职责索引：${JSON.stringify(index)}`,
    `S3→S4 结构 diff：${JSON.stringify(input.differences)}`,
    `实际 Outline Operations：${JSON.stringify(input.operations)}`,
  ].join('\n')
  return { prompt, kind, sectionPositions: index.map(item => item.position), cardPositions,
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
 * 根据完整请求的固定密度估算生成有界分片。每个叶子恰好进入一个详细审查；共享索引跨片时逐对检查所有片间职责关系。
 * @param input - 全量审查依据及程序绑定位置。
 * @param budgetTokens - 已扣除 system、工具和输出余量后的输入 token 预算。
 * @returns 完整请求和可验证覆盖位置；单对象超限时抛错。
 */
export function buildOutlineReviewRequests(input: OutlineReviewContext, budgetTokens: number): OutlineReviewRequest[] {
  const render = (cards: OutlineReviewContext['cards'], index: OutlineReviewContext['index'], kind: OutlineReviewRequest['kind']) =>
    renderOutlineReviewRequest(input, cards, index, kind)
  const complete = render(input.cards, input.index, 'complete')
  if (complete.estimatedInputTokens <= budgetTokens) return [complete]
  const assertFits = (request: OutlineReviewRequest, position?: number): void => {
    if (request.estimatedInputTokens > budgetTokens) {
      throw new OutlineReviewContextTooLargeError(position, request.estimatedInputTokens, budgetTokens)
    }
  }
  assertFits(render([], [], 'sections'))
  const requests: OutlineReviewRequest[] = []
  const sharedIndexFits = render([], input.index, 'sections').estimatedInputTokens <= Math.floor(budgetTokens / 2)
  let cardBatch: OutlineReviewContext['cards'] = []
  const sectionRequest = (cards: OutlineReviewContext['cards']) => render(cards,
    sharedIndexFits ? input.index : input.index.filter(item => cards.some(card => card.section_id === item.id)), 'sections')
  for (const card of input.cards) {
    const candidate = sectionRequest([...cardBatch, card])
    if (candidate.estimatedInputTokens > budgetTokens && cardBatch.length > 0) {
      requests.push(sectionRequest(cardBatch))
      cardBatch = []
    }
    assertFits(sectionRequest([card]), input.index.find(item => item.id === card.section_id)?.position)
    cardBatch.push(card)
  }
  if (cardBatch.length > 0) requests.push(sectionRequest(cardBatch))
  if (sharedIndexFits) {
    requests.push(render([], input.index, 'cross_sections'))
    return requests
  }
  // 一片至多使用可用数据空间的一半，使任意两片仍能放入同一请求。
  const fixed = render([], [], 'cross_sections').estimatedInputTokens
  const indexBudget = fixed + Math.floor((budgetTokens - fixed) / 2)
  const indexBatches: OutlineReviewContext['index'][] = []
  let indexBatch: OutlineReviewContext['index'] = []
  for (const item of input.index) {
    const candidate = render([], [...indexBatch, item], 'cross_sections')
    if (candidate.estimatedInputTokens > indexBudget && indexBatch.length > 0) {
      indexBatches.push(indexBatch)
      indexBatch = []
    }
    const single = render([], [item], 'cross_sections')
    if (single.estimatedInputTokens > indexBudget) {
      throw new OutlineReviewContextTooLargeError(item.position, single.estimatedInputTokens, indexBudget)
    }
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
