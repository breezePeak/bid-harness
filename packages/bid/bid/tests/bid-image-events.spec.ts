import { createHash } from 'node:crypto'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { bidImageRequestedSchema, BID_SESSION_EVENT_TYPES } from '../src/bid-events.ts'

const request = {
  owner: { kind: 'chapter', section_id: 'SEC-1' }, request_sha256: 'a'.repeat(64), style_sha256: 'b'.repeat(64),
  prompt: '项目统一蓝灰色插画。\n\n本图用途：技术方案\n本图内容：机房维护',
  size: '1536x1024' as const, model: 'gpt-image-2', base_url: 'https://cpa.example/v1',
}

describe('作图请求的持久事件', () => {
  it('进入当前日志词表并完整保留实际模型输入', () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has('bid.image.requested')).toBe(true)
    expect(BID_SESSION_EVENT_TYPES).toContain('bid.image.requested')
    expect(bidImageRequestedSchema.parse(request)).toEqual(request)
  })

  it('不接纳凭据或带认证信息的地址', () => {
    for (const value of [{ ...request, apiKey: 'secret' }, { ...request, apiKeyEnv: 'PP_API_KEY' },
      { ...request, base_url: 'https://user:secret@cpa.example/v1' }]) {
      expect(bidImageRequestedSchema.safeParse(value).success).toBe(false)
    }
  })

  it('参考图保留原资产身份和实际输入附件，并拒绝伪造的派生身份', () => {
    const hash = 'c'.repeat(64)
    const inputHash = 'd'.repeat(64)
    const reference = {
      kind: 'style',
      id: `IMG-${createHash('sha256').update(inputHash + hash).digest('hex')}`,
      path: `assets/images/${hash}.png`, content_sha256: hash, request_sha256: inputHash,
      width: 24, height: 16,
      attachment: { attachmentId: AttachmentId('style-reference'), mediaType: 'image/png' as const, bytes: 100, width: 24, height: 16 },
    }
    expect(bidImageRequestedSchema.parse({ ...request, reference }).reference).toEqual(reference)
    expect(bidImageRequestedSchema.parse({ ...request, reference: { ...reference,
      attachment: { ...reference.attachment, name: undefined, originalDimensions: undefined },
    } }).reference?.attachment).toEqual(reference.attachment)
    expect(bidImageRequestedSchema.safeParse({ ...request, reference: { ...reference, id: `IMG-${'e'.repeat(64)}` } }).success).toBe(false)
    expect(bidImageRequestedSchema.safeParse({ ...request, reference: { ...reference, attachment: undefined } }).success).toBe(false)
  })
})
