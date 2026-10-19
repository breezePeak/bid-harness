/** 图资产与 Word 页面共用的真实图片请求、会话路由和视觉重试。 */
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { currentModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { sanitizeBidErrorText } from './safe-error.ts'

async function resolveVisualModel(ctx: Context, session: Session, signal: AbortSignal) {
  const llm = ctx.get('llm')
  const header = session.requestHeader()
  const agent = ctx.get('agents')?.get(session.id)
  const route = (agent === undefined ? undefined : currentModelSelection(agent.ctx)) ?? header?.config ?? agent?.options
  if (llm === undefined || route?.provider === undefined || route.model === undefined) throw new Error('DOCX_VISUAL_REVIEW_ROUTE_UNAVAILABLE')
  const info = await llm.resolveModelInfo(route.provider, route.model, signal)
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`DOCX_VISUAL_REVIEW_IMAGE_INPUT_REQUIRED:${route.model}`)
  }
  const configured = header?.adapterDefaults?.maxTokens === true ? undefined : header?.config.maxTokens
  return { llm, route: { ...route, provider: route.provider, model: route.model }, maxTokens: configured ?? info.defaultMaxTokens ?? 4_096 }
}

/**
 * 在计费生成前确认当前会话确实能检查图片。
 * @param ctx 提供模型和附件服务的上下文。
 * @param session 当前执行会话。
 * @param signal 所属操作的取消信号。
 */
export async function assertBidVisualModel(ctx: Context, session: Session, signal: AbortSignal): Promise<void> {
  if (ctx.get('attachments') === undefined) throw new Error('DOCX_VISUAL_REVIEW_ATTACHMENTS_UNAVAILABLE')
  await resolveVisualModel(ctx, session, signal)
}

/**
 * 将实际图片送入当前会话的视觉模型，所有请求均记录为可重建事件。
 * @param ctx 提供模型与附件服务的上下文。
 * @param session 保存来源、路由和审核请求的会话。
 * @param input 程序绑定的输入身份、真实图片及语义检查要求。
 * @param signal 所属操作的取消信号。
 * @returns 模型返回的 JSON；调用者使用所属能力的严格 Schema 校验。
 */
export async function requestBidVisualReview(ctx: Context, session: Session, input: {
  blockId: string
  inputHash: string
  prompt: string
  system: string
  images: Array<{ data: Uint8Array; mediaType: ImageAttachmentRef['mediaType']; name: string }>
}, signal?: AbortSignal): Promise<unknown> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('DOCX_VISUAL_REVIEW_ATTACHMENTS_UNAVAILABLE')
  const requestSignal = signal === undefined
    ? AbortSignal.timeout(120_000)
    : AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  const { llm, route, maxTokens } = await resolveVisualModel(ctx, session, requestSignal)
  const refs = await attachments.saveImages(input.images)
  const messages = [createUserMessage({
    content: [
      { type: 'text', text: input.prompt },
      ...refs.map(attachment => ({ type: 'image' as const, attachment })),
    ],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid' },
  })]
  const request = deepFreeze({
    blockId: input.blockId,
    inputHash: input.inputHash,
    messages,
    system: input.system,
    provider: route.provider,
    model: route.model,
    maxTokens,
  })
  const policy = llm.providerRetryPolicy(route.provider)
  for (let retry = 0; ; retry += 1) {
    requestSignal.throwIfAborted()
    session.append('bid.visual-review.request', request)
    const result = await llm.generate({
      system: input.system,
      messages,
      provider: route.provider,
      model: route.model,
      maxTokens,
      sessionId: session.id,
      signal: requestSignal,
    })
    if (result.finish.kind === 'error') {
      const failure = result.finish.failure
      const providerDelay = failure.providerRetryAfterMs
      const eligible = policy.mode === 'always'
        || retry < policy.maxRetries && policy.retryableCodes.includes(failure.code)
          && (providerDelay === undefined || providerDelay <= policy.maxDelayMs)
      if (eligible) {
        const localDelay = Math.min(policy.initialDelayMs * 2 ** Math.min(retry, 1024), policy.maxDelayMs)
        const jittered = Math.min(localDelay * (1 - policy.jitterRatio + 2 * policy.jitterRatio * Math.random()), policy.maxDelayMs)
        const delayMs = providerDelay !== undefined && providerDelay > 0 && providerDelay <= policy.maxDelayMs
          ? providerDelay : jittered
        await delay(delayMs, undefined, { signal: requestSignal })
        continue
      }
    }
    if (result.finish.kind !== 'stop') {
      const detail = result.finish.kind === 'error' || result.finish.kind === 'aborted'
        ? `:${result.finish.failure.code}:${sanitizeBidErrorText(result.finish.failure.message)}` : ''
      throw new Error(`DOCX_VISUAL_REVIEW_INCOMPLETE:${result.finish.kind}${detail}`)
    }
    const response = result.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    let value: unknown
    try { value = JSON.parse(response) } catch { throw new Error('DOCX_VISUAL_REVIEW_RESPONSE_INVALID') }
    return value
  }
}
