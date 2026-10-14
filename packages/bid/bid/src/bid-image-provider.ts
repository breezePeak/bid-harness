/** 使用已有 pp 凭据调用 CPA Images API；外部图片先完整解码后转为项目 PNG。 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { normalizeApiKey } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import sharp, { type Metadata, type OutputInfo } from 'sharp'
import { z } from 'zod'
import type { BidImageGenerationView } from './control-plane-contract.ts'
import {
  BID_IMAGE_SETTINGS_NAMESPACE, resolveBidImageConfig, bidImageConnectionSpecSchema,
  type BidImageGenerationConfig, type BidImageConnectionSpec,
} from './bid-image-config.ts'

export { bidImageConnectionSpecSchema, type BidImageConnectionSpec } from './bid-image-config.ts'
export type { BidImageGenerationView } from './control-plane-contract.ts'

/** 模型可选择的图幅；返回尺寸以实际图片为准。 */
export type BidImageSize = '1024x1024' | '1536x1024' | '1024x1536'

/** 已完整解码、转为 PNG 的单张图。 */
export interface BidGeneratedImage {
  png: Buffer
  width: number
  height: number
  model: string
}

/** 程序绑定的作图请求；参考图仅接收已保存的项目字节。 */
export interface BidImageGenerationRequest {
  prompt: string
  size: BidImageSize
  /** 经完整解码校验后按原字节发送，须与会话事件的参考附件一致。 */
  reference?: Buffer
  /** 项目已冻结的模型；缺省使用正式作图配置中的模型。 */
  model?: string
  /**
   * HTTP 调用前记录同一次解析的实际连接；失败或取消后不发送请求。
   * @param connection 从当前正式配置解析的连接，不含凭据值。
   * @returns 请求日志持久化完成。
   */
  beforeRequest?: (connection: BidImageConnectionSpec) => Promise<void>
}

/** 设置 UI 与 S5 共用的作图能力。 */
export interface BidImageProvider {
  /**
   * 从当前正式配置解析连接，项目记录只能指定模型。
   * @param model 已解析的项目冻结模型；缺省使用当前全局模型。
   * @returns 不含密钥的连接，未选择全局或项目模型时为 undefined。
   */
  resolve(model?: string): BidImageConnectionSpec | undefined
  /**
   * 查询作图设置和就绪状态。
   * @returns 不含凭据值的设置投影。
   */
  view(): Promise<BidImageGenerationView>
  /**
   * 查询当前接口实际公布的模型 ID。
   * @param signal 所属查询操作的取消信号。
   * @returns 接口实际公布的模型 ID，按服务顺序去重。
   */
  discoverModels(signal: AbortSignal): Promise<string[]>
  /**
   * 生成单图，有参考图时调用编辑接口，不自动重试计费请求。
   * @param request 程序绑定的语义、图幅、参考图、冻结模型及请求记录回调。
   * @param signal 所属操作的取消信号。
   * @returns 经字节与像素限制验证的 PNG。
   */
  generate(request: BidImageGenerationRequest, signal: AbortSignal): Promise<BidGeneratedImage>
}

/** 不含提供方原始响应或凭据的作图失败。 */
export class BidImageError extends Error {
  /**
   * @param code 稳定错误分类。
   * @param message 可安全展示的中文说明。
   * @param status 提供方的 HTTP 状态。
   */
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message)
    this.name = 'BidImageError'
  }
}

const PP_NAMESPACE = settingsNamespace('llm-pi-ai')
const ppSettingsSchema = z.object({ providers: z.object({ pp: z.object({
  baseURL: z.string().optional(), apiKeyEnv: z.string().optional(),
}) }) })
const listingSchema = z.object({ data: z.array(z.object({ id: z.string().trim().min(1).max(200) })) })
const imageReplySchema = z.object({ data: z.tuple([z.object({ b64_json: z.string().min(1) })]) })
const MAX_LISTING_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_PIXELS = 4096 * 4096
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

function checkAbort(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw new BidImageError(timeoutOf(signal, 'BID_IMAGE_TIMEOUT') === undefined ? 'BID_IMAGE_CANCELLED' : 'BID_IMAGE_TIMEOUT',
    timeoutOf(signal, 'BID_IMAGE_TIMEOUT') === undefined ? '作图请求已取消。' : '作图接口请求超时。')
}

async function consumeReader(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    checkAbort(signal)
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) throw new BidImageError('BID_IMAGE_RESPONSE_TOO_LARGE', '作图接口响应超过字节上限。')
    chunks.push(value)
  }
  checkAbort(signal)
  return Buffer.concat(chunks, total)
}

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel()
    throw new BidImageError('BID_IMAGE_RESPONSE_TOO_LARGE', '作图接口响应超过字节上限。')
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  try {
    return await consumeReader(reader, limit, signal)
  } finally {
    await reader.cancel().catch(() => {
      // 已完成或拒绝的响应只需关闭读取；清理失败不改变原有结果。
    })
  }
}

async function requestJson(url: string, init: RequestInit, limit: number, signal: AbortSignal): Promise<unknown> {
  checkAbort(signal)
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal })
  } catch {
    checkAbort(signal)
    throw new BidImageError('BID_IMAGE_NETWORK_ERROR', '作图接口无法连接。')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new BidImageError(response.status === 401 || response.status === 403 ? 'BID_IMAGE_AUTH_ERROR' : 'BID_IMAGE_PROVIDER_ERROR',
      `作图接口返回 HTTP ${String(response.status)}。`, response.status)
  }
  let bytes: Buffer
  try {
    bytes = await readBounded(response, limit, signal)
  } catch (error) {
    checkAbort(signal)
    if (error instanceof BidImageError) throw error
    throw new BidImageError('BID_IMAGE_NETWORK_ERROR', '作图接口响应读取失败。')
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new BidImageError('BID_IMAGE_INVALID_RESPONSE', '作图接口未返回有效 JSON。')
  }
}

async function normalizeRaster(bytes: Buffer, limit: number, signal: AbortSignal): Promise<Omit<BidGeneratedImage, 'model'> & {
  sourceMediaType: 'image/png' | 'image/jpeg' | 'image/webp'
}> {
  checkAbort(signal)
  if (bytes.length === 0 || bytes.length > limit) throw new BidImageError('BID_IMAGE_RESPONSE_TOO_LARGE', '图片字节超过上限或为空。')
  let metadata: Metadata
  try {
    metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).metadata()
  } catch {
    checkAbort(signal)
    throw new BidImageError('BID_IMAGE_INVALID_RESPONSE', '作图接口返回的图片无法解码。')
  }
  let sourceMediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  switch (metadata.format) {
    case 'png': sourceMediaType = 'image/png'; break
    case 'jpeg': sourceMediaType = 'image/jpeg'; break
    case 'webp': sourceMediaType = 'image/webp'; break
    default: throw new BidImageError('BID_IMAGE_INVALID_RESPONSE', '作图接口必须返回单张 PNG、JPEG 或 WebP 图片。')
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw new BidImageError('BID_IMAGE_INVALID_RESPONSE', '作图接口必须返回单张 PNG、JPEG 或 WebP 图片。')
  }
  let image: { data: Buffer; info: OutputInfo }
  try {
    image = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).rotate().png().toBuffer({ resolveWithObject: true })
  } catch {
    checkAbort(signal)
    throw new BidImageError('BID_IMAGE_INVALID_RESPONSE', '作图接口返回的图片无法完整解码。')
  }
  checkAbort(signal)
  if (image.data.length > limit) throw new BidImageError('BID_IMAGE_RESPONSE_TOO_LARGE', '生成 PNG 超过图片字节上限。')
  return { png: image.data, width: image.info.width, height: image.info.height, sourceMediaType }
}

/**
 * 创建读取已解析 Settings 和已有 pp 凭据的作图能力。
 * @param ctx 拥有 Settings 与 Credentials 的当前 Host Context。
 * @param source 所属 Bid Host 的当前配置源，优先于 Context 中的配置。
 * @returns 已有 Bid Host 能力或新建能力；无 Host 且缺设置分节时默认关闭。
 */
export function createBidImageProvider(ctx: Context, source?: () => BidImageGenerationConfig): BidImageProvider {
  const hostImages = source === undefined ? ctx.get('bid')?.imageGeneration : undefined
  if (hostImages !== undefined) return hostImages
  const config = (): Required<BidImageGenerationConfig> => {
    const value = source === undefined
      ? ctx.get('settings')?.get(BID_IMAGE_SETTINGS_NAMESPACE)
      : source()
    return resolveBidImageConfig(value ?? {})
  }
  const connection = (options: Required<BidImageGenerationConfig>): BidImageConnectionSpec => {
    const pp = ppSettingsSchema.safeParse(ctx.get('settings')?.get(PP_NAMESPACE))
    if (!pp.success || pp.data.providers.pp.apiKeyEnv === undefined) {
      throw new BidImageError('BID_IMAGE_CONFIG_INVALID', '请先配置 pp 模型提供方及其已有凭据。')
    }
    const parsed = bidImageConnectionSpecSchema.omit({ model: true }).safeParse({
      baseURL: options.baseURL || pp.data.providers.pp.baseURL,
      timeoutMs: options.timeoutMs,
      maxImageBytes: options.maxImageBytes,
      apiKeyEnv: pp.data.providers.pp.apiKeyEnv,
    })
    if (!parsed.success) throw new BidImageError('BID_IMAGE_CONFIG_INVALID', '作图接口地址或 pp 凭据引用无效。')
    const url = new URL(parsed.data.baseURL)
    const path = url.pathname.replace(/\/+$/u, '')
    url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
    return { ...parsed.data, baseURL: url.toString().replace(/\/+$/u, ''), model: options.model }
  }
  const resolve = (model?: string): BidImageConnectionSpec | undefined => {
    const options = config()
    const selectedModel = model ?? options.model
    return selectedModel === '' ? undefined : connection({ ...options, model: selectedModel })
  }
  const apiKey = async (spec: BidImageConnectionSpec, signal: AbortSignal): Promise<string> => {
    checkAbort(signal)
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new BidImageError('BID_IMAGE_AUTH_ERROR', '已有 pp 凭据服务不可用。')
    const resolved = await credentials.resolve(credentialRef(spec.apiKeyEnv))
    checkAbort(signal)
    const checked = normalizeApiKey(resolved?.value ?? '')
    if (!checked.ok) throw new BidImageError('BID_IMAGE_AUTH_ERROR', '已有 pp 凭据缺失或不可用于 HTTP 认证。')
    return checked.value
  }
  return {
    resolve,
    async view() {
      const options = config()
      const view: BidImageGenerationView = {
        baseURL: options.baseURL, effectiveBaseURL: '', model: options.model, credentialConfigured: false, enabled: false,
      }
      let spec: BidImageConnectionSpec
      try {
        spec = connection(options)
      } catch (error) {
        return { ...view, error: error instanceof BidImageError ? error.message : '作图配置不可用。' }
      }
      view.effectiveBaseURL = spec.baseURL
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) view.credentialConfigured = (await credentials.describe(spec.apiKeyEnv)).configured
      view.enabled = options.model !== '' && view.credentialConfigured
      return view
    },
    async discoverModels(signal) {
      const spec = connection(config())
      using operation = deadline(signal, spec.timeoutMs, 'BID_IMAGE_TIMEOUT')
      const key = await apiKey(spec, operation.signal)
      const body = await requestJson(`${spec.baseURL}/models`, { headers: { Authorization: `Bearer ${key}` } }, MAX_LISTING_BYTES, operation.signal)
      const parsed = listingSchema.safeParse(body)
      if (!parsed.success) throw new BidImageError('BID_IMAGE_INVALID_RESPONSE', '作图接口模型列表无效。')
      return [...new Set(parsed.data.data.map(entry => entry.id))]
    },
    async generate(request, signal) {
      const current = resolve(request.model)
      const spec = current === undefined ? undefined : Object.freeze(current)
      if (spec === undefined) throw new BidImageError('BID_IMAGE_DISABLED', '请先选择并保存作图模型。')
      using operation = deadline(signal, spec.timeoutMs, 'BID_IMAGE_TIMEOUT')
      checkAbort(operation.signal)
      await request.beforeRequest?.(spec)
      checkAbort(operation.signal)
      const key = await apiKey(spec, operation.signal)
      let body: string | FormData
      let path: string
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
      if (request.reference === undefined) {
        body = JSON.stringify({ model: spec.model, prompt: request.prompt, size: request.size, n: 1, output_format: 'png' })
        headers['Content-Type'] = 'application/json'
        path = 'generations'
      } else {
        const reference = await normalizeRaster(request.reference, spec.maxImageBytes, operation.signal)
        const form = new FormData()
        form.set('model', spec.model)
        form.set('prompt', request.prompt)
        form.set('size', request.size)
        form.set('n', '1')
        form.set('output_format', 'png')
        form.set('image', new Blob([new Uint8Array(request.reference)], { type: reference.sourceMediaType }),
          `project-style.${reference.sourceMediaType.slice('image/'.length)}`)
        body = form
        path = 'edits'
      }
      const responseLimit = 4 * Math.ceil(spec.maxImageBytes / 3) + 1024 * 1024
      const reply = await requestJson(`${spec.baseURL}/images/${path}`, { method: 'POST', headers, body }, responseLimit, operation.signal)
      const parsed = imageReplySchema.safeParse(reply)
      if (!parsed.success) throw new BidImageError('BID_IMAGE_INVALID_RESPONSE', '作图接口必须返回单张内嵌图片，不能仅返回 URL。')
      const encoded = parsed.data.data[0].b64_json
      if (encoded.length > 4 * Math.ceil(spec.maxImageBytes / 3)) {
        throw new BidImageError('BID_IMAGE_RESPONSE_TOO_LARGE', '图片字节超过上限。')
      }
      if (!BASE64.test(encoded)) throw new BidImageError('BID_IMAGE_INVALID_RESPONSE', '作图接口图片的 Base64 无效。')
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.toString('base64') !== encoded) throw new BidImageError('BID_IMAGE_INVALID_RESPONSE', '作图接口图片的 Base64 无效。')
      const image = await normalizeRaster(bytes, spec.maxImageBytes, operation.signal)
      return { png: image.png, width: image.width, height: image.height, model: spec.model }
    },
  }
}
