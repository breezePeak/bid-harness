/** 章节与独立任务共用的计费图片请求记录；未知远端结果不能自动重发。 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BidWorkspace } from './index.ts'
import type { BidCommitScope } from './run-coordinator.ts'
import { BidImageError, type BidImageProvider, type BidGeneratedImage } from './bid-image-provider.ts'
import { bidImageRequestedSchema, type BidImageRequestedData } from './bid-events.ts'
import { DOCX_MAX_BODY_IMAGE_BYTES, docxImageDimensions } from './docx-image.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const resultSchema = z.object({ path: z.string().regex(/^assets\/images\/[a-f0-9]{64}\.png$/u),
  sha256: hash, width: z.number().int().positive(), height: z.number().int().positive(), model: z.string().min(1) }).strict()
const attemptSchema = z.object({ schema_version: z.literal(1), request: bidImageRequestedSchema,
  status: z.enum(['requested', 'uncertain', 'failed', 'completed']), attempts: z.literal(1),
  error_code: z.string().min(1).optional(), result: resultSchema.optional(),
}).strict().refine(value => (value.status === 'completed') === (value.result !== undefined))
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

/**
 * 获取请求事实的唯一存储路径。
 * @param requestSha256 程序由实际输入派生的摘要。
 * @returns 项目相对 JSON 路径。
 */
export function bidImageRequestPath(requestSha256: string): string {
  return `assets/image-requests/${hash.parse(requestSha256)}.json`
}

/**
 * 执行一次计费生成，成功结果复用；发出后未知、已失败的同一请求均不自动重发。
 * @param workspace 当前候选项目。
 * @param provider 已配置的项目图提供方。
 * @param writer 记录实际语义与参考附件的 Agent。
 * @param commits 当前 Run 的候选提交权限。
 * @param request 已绑定来源、语义、模型与可选真实参考图。
 * @param signal 所属 Run 的取消信号。
 * @returns 完整解码并已保存的真实 PNG；未确认远端结果时抛出明确错误。
 */
export async function generateTrackedBidImage(workspace: BidWorkspace, provider: BidImageProvider, writer: Agent,
  commits: BidCommitScope, request: Omit<BidImageRequestedData, 'base_url'> & { referenceBytes?: Buffer },
  signal: AbortSignal): Promise<BidGeneratedImage> {
  const { referenceBytes, ...fields } = request
  if ((fields.reference === undefined) !== (referenceBytes === undefined)
    || referenceBytes !== undefined && digest(referenceBytes) !== fields.reference?.content_sha256) {
    throw new Error('BID_IMAGE_REFERENCE_BYTES_MISMATCH')
  }
  const connection = provider.resolve(request.model)
  if (connection === undefined) throw new BidImageError('BID_IMAGE_DISABLED', '请先选择并保存作图模型。')
  const expected = bidImageRequestedSchema.parse({ ...fields, model: connection.model, base_url: connection.baseURL })
  const path = within(workspace.projectRoot, bidImageRequestPath(fields.request_sha256))
  await assertNoLinkedPath(workspace.root, path)
  let saved: string | undefined
  try { saved = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (saved !== undefined) {
    const attempt = attemptSchema.parse(JSON.parse(saved))
    if (JSON.stringify(attempt.request) !== JSON.stringify(expected)) throw new Error('BID_IMAGE_REQUEST_CHANGED')
    if (attempt.status !== 'completed' || attempt.result === undefined) {
      throw new BidImageError(attempt.status === 'failed' ? 'BID_IMAGE_PREVIOUS_REQUEST_FAILED' : 'BID_IMAGE_RESULT_UNCERTAIN',
        attempt.status === 'failed' ? '提供方已拒绝此请求；请核对原因后由用户授权新的生成。' : '此请求已发出但远端结果未确认；不会自动再次生成计费。')
    }
    const result = attempt.result
    if (result.path !== `assets/images/${result.sha256}.png`) throw new Error('BID_IMAGE_RESULT_PATH_INVALID')
    const imagePath = within(workspace.projectRoot, result.path)
    await assertNoLinkedPath(workspace.root, imagePath)
    const png = await readFile(imagePath)
    const dimensions = docxImageDimensions(png)
    if (digest(png) !== result.sha256 || dimensions.type !== 'png' || dimensions.width !== result.width
      || dimensions.height !== result.height) throw new Error('BID_IMAGE_RESULT_CHANGED')
    return { png, width: result.width, height: result.height, model: result.model }
  }
  const attempt = { sent: false }
  let result: BidGeneratedImage
  try {
    result = await provider.generate({ prompt: fields.prompt, size: fields.size, model: fields.model,
      ...(referenceBytes === undefined ? {} : { reference: referenceBytes }),
      async beforeRequest(spec) {
        const actual = bidImageRequestedSchema.parse({ ...fields, model: spec.model, base_url: spec.baseURL })
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('BID_IMAGE_CONNECTION_CHANGED')
        writer.session.append('bid.image.requested', actual)
        if (!await writer.ctx.sessions.flush(writer.session)) throw new Error('BID_IMAGE_REQUEST_LOG_UNAVAILABLE')
        await commits.writeJson(path, attemptSchema.parse({ schema_version: 1, request: actual, status: 'requested', attempts: 1 }))
        attempt.sent = true
      },
    }, signal)
  } catch (error) {
    if (attempt.sent && !signal.aborted) await commits.writeJson(path, attemptSchema.parse({ schema_version: 1, request: expected,
      status: error instanceof BidImageError && error.status !== undefined ? 'failed' : 'uncertain', attempts: 1,
      error_code: error instanceof BidImageError ? error.code : 'BID_IMAGE_RESULT_UNCERTAIN' }))
    throw error
  }
  if (!attempt.sent) throw new Error('BID_IMAGE_REQUEST_NOT_RECORDED')
  signal.throwIfAborted()
  const dimensions = docxImageDimensions(result.png)
  if (dimensions.type !== 'png' || dimensions.width !== result.width || dimensions.height !== result.height
    || result.png.length > DOCX_MAX_BODY_IMAGE_BYTES) throw new Error('BID_IMAGE_PROVIDER_RESULT_INVALID')
  const sha256 = digest(result.png)
  await commits.publish(async (lease) => {
    await lease.writeBytes(within(workspace.projectRoot, `assets/images/${sha256}.png`), result.png)
    await lease.writeJson(path, attemptSchema.parse({ schema_version: 1, request: expected, status: 'completed', attempts: 1,
      result: { path: `assets/images/${sha256}.png`, sha256, width: result.width, height: result.height, model: result.model } }))
  })
  return result
}
