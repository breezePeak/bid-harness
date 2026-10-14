/** 标书作图配置与请求连接规范；凭据引用只从正式 pp 配置读取。 */

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { z as zod } from 'zod'

/** 标书作图独立设置分节。 */
export const BID_IMAGE_SETTINGS_NAMESPACE = settingsNamespace('bid-images')

/** 用户配置；空地址继承 pp，空模型不为新项目启用作图。 */
export interface BidImageGenerationConfig {
  /** 作图 API 根地址，路径后追加 images/generations 或 images/edits。 */
  baseURL?: string
  /** 用户从服务模型列表选择的作图模型。 */
  model?: string
  /** 单次请求及响应读取的截止时间。 */
  timeoutMs?: number
  /** 单张输入、解码后图片及最终 PNG 的字节上限。 */
  maxImageBytes?: number
}

/** 作图设置的加载及写入 Schema。 */
export const BidImageGenerationConfig: z<BidImageGenerationConfig> = z.object({
  baseURL: z.string().default(''),
  model: z.string().default(''),
  timeoutMs: z.natural().min(1).max(600_000).default(300_000),
  maxImageBytes: z.natural().min(1).max(20 * 1024 * 1024).default(20 * 1024 * 1024),
})

const apiRootSchema = zod.url().refine((value) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // URL 校验已失败时仍可能进入 refinement；只返回同一字段的失败。
    return false
  }
  return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
    && url.search === '' && url.hash === ''
}, '作图接口地址必须为不含认证、查询参数和片段的 HTTP(S) 地址。')

/** 正式配置解析出的单次请求连接规范，不作为项目文件的授权。 */
export const bidImageConnectionSpecSchema = zod.object({
  baseURL: apiRootSchema,
  model: zod.string().trim().min(1).max(200),
  timeoutMs: zod.number().int().min(1).max(600_000),
  maxImageBytes: zod.number().int().min(1).max(20 * 1024 * 1024),
  apiKeyEnv: zod.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).transform(credentialRef),
}).strict()

/** 不含密钥的单次请求连接，由提供方从正式配置解析。 */
export type BidImageConnectionSpec = zod.output<typeof bidImageConnectionSpecSchema>

/**
 * 解析作图配置的默认值及自身约束，不读取其他服务。
 * @param config 当前 Settings 或 composition 配置。
 * @returns 字段完整的作图配置。
 */
export function resolveBidImageConfig(config: BidImageGenerationConfig): Required<BidImageGenerationConfig> {
  const values = BidImageGenerationConfig(config) as Required<BidImageGenerationConfig>
  const baseURL = values.baseURL.trim().replace(/\/+$/u, '')
  const model = values.model.trim()
  if (baseURL !== '' && !apiRootSchema.safeParse(baseURL).success) {
    throw new Error('作图接口地址必须为不含认证、查询参数和片段的 HTTP(S) 地址。')
  }
  if (model.length > 200) throw new Error('作图模型名称不能超过 200 个字符。')
  return { baseURL, model, timeoutMs: values.timeoutMs, maxImageBytes: values.maxImageBytes }
}
