import { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'
import schemastery from '@deepseek-ai/schemastery'
import { installSettingsSection, SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BID_IMAGE_SETTINGS_NAMESPACE, BidImageGenerationConfig, resolveBidImageConfig, bidImageConnectionSpecSchema } from '../src/bid-image-config.ts'
import { createBidImageProvider, type BidImageConnectionSpec } from '../src/bid-image-provider.ts'

const cleanups: Array<() => void | Promise<void>> = []
const signal = (): AbortSignal => new AbortController().signal

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  }))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`
}

function provider(baseURL: string, config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const settings: Record<string, unknown> = {
    'bid-images': { model: 'gpt-image-2', ...config },
    'llm-pi-ai': { providers: { pp: { baseURL, apiKeyEnv: 'PP_TEST_KEY' } } },
  }
  cleanups.push(ctx.provide('settings', { get: (namespace: string) => settings[namespace] }))
  const resolveCredential = vi.fn(async (_ref: string) => ({ value: 'test-key', source: 'memory' }))
  cleanups.push(ctx.provide('credentials', {
    resolve: resolveCredential,
    describe: async () => ({ configured: true, source: 'memory', writable: true }),
  }))
  return { ctx, settings, images: createBidImageProvider(ctx), resolveCredential }
}

function json(response: ServerResponse, value: unknown): void {
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(value))
}

function generatedBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('生成请求必须使用JSON文本')
  return JSON.parse(init.body) as unknown
}

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 16, channels: 3, background: '#225588' } }).png().toBuffer()
}

async function mockImageFetch() {
  const source = await png()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    data: [{ b64_json: source.toString('base64') }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  cleanups.push(() => { fetch.mockRestore() })
  return fetch
}

describe('标书作图配置', () => {
  it('空配置关闭作图并明确默认超时与图片上限', () => {
    expect(resolveBidImageConfig({})).toEqual({ baseURL: '', model: '', timeoutMs: 300_000, maxImageBytes: 20 * 1024 * 1024 })
    expect(createBidImageProvider(new Context()).resolve()).toBeUndefined()
  })

  it('显式 composition 已选择模型但缺 Settings/pp 时明确报错，不静默关闭', () => {
    const ctx = new Context()
    const images = createBidImageProvider(ctx, () => ({ model: 'composition-image' }))
    cleanups.push(ctx.provide('bid', { imageGeneration: images }))
    expect(createBidImageProvider(ctx)).toBe(images)
    expect(() => createBidImageProvider(ctx).resolve()).toThrow(/pp/u)
    expect(() => createBidImageProvider(new Context(), () => ({ model: 'explicit-image' })).resolve()).toThrow(/pp/u)
  })

  it('显式 source 覆盖 Settings，挂载及卸载沿原 composition 配置源恢复', async () => {
    class MemorySettings extends SettingsProvider {
      readonly writable = true
      protected load() { return Promise.resolve({}) }
      protected persist() { return Promise.resolve() }
    }
    const ctx = new Context()
    const entry = { model: 'composition-image' }
    let current: () => BidImageGenerationConfig = () => entry
    installSettingsSection(ctx, BID_IMAGE_SETTINGS_NAMESPACE, BidImageGenerationConfig, entry, {
      setSource(next) { current = next }, onChange() {},
    })
    const images = createBidImageProvider(ctx, () => current())
    const fiber = ctx.plugin(MemorySettings)
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    ctx.settings.register(settingsNamespace('llm-pi-ai'), schemastery.object({ providers: schemastery.object({
      pp: schemastery.object({ baseURL: schemastery.string(), apiKeyEnv: schemastery.string() }),
    }) }), { base: { providers: { pp: { baseURL: 'http://127.0.0.1:8317/v1', apiKeyEnv: 'PP_TEST_KEY' } } } })
    await ctx.settings.update(BID_IMAGE_SETTINGS_NAMESPACE, { model: 'live-image' })
    expect(images.resolve()?.model).toBe('live-image')
    expect(createBidImageProvider(ctx, () => entry).resolve()?.model).toBe('composition-image')
    await fiber.dispose()
    const view = await images.view()
    expect(view).toMatchObject({ model: 'composition-image', enabled: false })
    expect(view.error).toContain('pp')
    expect(() => images.resolve()).toThrow(/pp/u)
  })

  it.each(['bad-url', 'file:///tmp/images', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#fragment'])('拒绝非法接口地址 %s', (baseURL) => {
    expect(() => resolveBidImageConfig({ baseURL })).toThrow(/HTTP\(S\)/u)
  })

  it.each([
    ['http://127.0.0.1:8317', 'http://127.0.0.1:8317/v1'],
    ['http://127.0.0.1:8317/proxy/v1/', 'http://127.0.0.1:8317/proxy/v1'],
    ['http://127.0.0.1:8317/proxy', 'http://127.0.0.1:8317/proxy/v1'],
  ])('归一化接口根地址 %s 并保留部署路径', (baseURL, effective) => {
    expect(provider(baseURL).images.resolve()!.baseURL).toBe(effective)
  })

  it('继承 pp 的地址和凭据引用，设置投影没有密钥', async () => {
    const { images } = provider('http://127.0.0.1:8317/v1')
    expect(images.resolve()).toMatchObject({ baseURL: 'http://127.0.0.1:8317/v1', model: 'gpt-image-2', apiKeyEnv: 'PP_TEST_KEY' })
    expect(await images.view()).toEqual({ baseURL: '', effectiveBaseURL: 'http://127.0.0.1:8317/v1', model: 'gpt-image-2', credentialConfigured: true, enabled: true })
    expect(JSON.stringify(await images.view())).not.toContain('test-key')
  })

  it('选定模型时 pp 缺失明确失败，未选模型不启动请求', async () => {
    const { images, settings } = provider('http://127.0.0.1:8317/v1')
    delete settings['llm-pi-ai']
    expect(() => images.resolve()).toThrow(/pp/u)
    settings['bid-images'] = { model: '' }
    await expect(images.generate({ prompt: '项目示意图', size: '1536x1024' }, signal())).rejects.toMatchObject({ code: 'BID_IMAGE_DISABLED' })
  })

  it('正式连接规范拒绝密钥值、非法凭据引用和未选择模型', () => {
    const spec = provider('http://127.0.0.1:8317/v1').images.resolve()!
    expect(bidImageConnectionSpecSchema.safeParse(spec).success).toBe(true)
    for (const invalid of [{ ...spec, apiKey: 'secret' }, { ...spec, apiKeyEnv: 'bad-ref' }, { ...spec, model: '' }]) {
      expect(bidImageConnectionSpecSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('已有项目只冻结模型，全局未选模型时仍从正式配置解析连接', () => {
    const { images } = provider('https://official.example/v1', { model: '' })
    expect(images.resolve()).toBeUndefined()
    expect(images.resolve('frozen-image-model')).toMatchObject({
      model: 'frozen-image-model', baseURL: 'https://official.example/v1', apiKeyEnv: 'PP_TEST_KEY',
    })
  })
})

describe('作图目的地只接受正式配置', () => {
  it('忽略请求中额外的恶意连接，fetch 与凭据解析仍使用正式配置', async () => {
    const fetch = await mockImageFetch()
    const { images, resolveCredential } = provider('https://official.example/v1')
    const request = { prompt: '方案场景', size: '1024x1024' as const,
      connection: { baseURL: 'https://untrusted.example/v1', model: 'injected-model', apiKeyEnv: 'OTHER_PRIVATE_KEY',
        timeoutMs: 1, maxImageBytes: 1 },
    }
    await images.generate(request, signal())
    expect(resolveCredential).toHaveBeenCalledExactlyOnceWith('PP_TEST_KEY')
    expect(fetch).toHaveBeenCalledOnce()
    const [target, init] = fetch.mock.calls[0]!
    expect(target).toBe('https://official.example/v1/images/generations')
    expect(init?.headers).toEqual({ Authorization: 'Bearer test-key', 'Content-Type': 'application/json' })
    expect(init?.redirect).toBe('error')
    expect(generatedBody(init)).toEqual({ model: 'gpt-image-2', prompt: '方案场景', size: '1024x1024', n: 1, output_format: 'png' })
  })

  it('正式地址与pp引用变化后保留项目模型，回调日志等于同一次解析的实际请求', async () => {
    const fetch = await mockImageFetch()
    const { images, settings, resolveCredential } = provider('https://previous.example/v1')
    const model = images.resolve()!.model
    settings['bid-images'] = { model: '', baseURL: 'https://current.example/cpa', timeoutMs: 1000, maxImageBytes: 1024 }
    settings['llm-pi-ai'] = { providers: { pp: { baseURL: 'https://current.example/v1', apiKeyEnv: 'PP_CURRENT_KEY' } } }
    let recorded: BidImageConnectionSpec | undefined
    await images.generate({ prompt: '继续项目风格', size: '1536x1024', model,
      async beforeRequest(connection) {
        recorded = { ...connection }
        settings['bid-images'] = { model: 'next-model', baseURL: 'https://next.example/v1' }
        settings['llm-pi-ai'] = { providers: { pp: { baseURL: 'https://next.example/v1', apiKeyEnv: 'PP_NEXT_KEY' } } }
      },
    }, signal())
    expect(recorded).toEqual({ model: 'gpt-image-2', baseURL: 'https://current.example/cpa/v1', apiKeyEnv: 'PP_CURRENT_KEY',
      timeoutMs: 1000, maxImageBytes: 1024 })
    expect(resolveCredential).toHaveBeenCalledExactlyOnceWith('PP_CURRENT_KEY')
    expect(fetch).toHaveBeenCalledOnce()
    const [target, init] = fetch.mock.calls[0]!
    expect(target).toBe(`${recorded?.baseURL}/images/generations`)
    expect(generatedBody(init)).toEqual({ model: recorded?.model, prompt: '继续项目风格', size: '1536x1024', n: 1, output_format: 'png' })
  })

  it('预检凭据后请求记录失败，不发起HTTP', async () => {
    const fetch = await mockImageFetch()
    const { images, resolveCredential } = provider('https://official.example/v1')
    await expect(images.generate({ prompt: '方案场景', size: '1024x1024',
      beforeRequest: () => Promise.reject(new Error('request log unavailable')),
    }, signal())).rejects.toThrow('request log unavailable')
    expect(fetch).not.toHaveBeenCalled()
    expect(resolveCredential).toHaveBeenCalledOnce()
  })

  it('预检凭据后在记录回调期间取消，不发起HTTP', async () => {
    const fetch = await mockImageFetch()
    const { images, resolveCredential } = provider('https://official.example/v1')
    const controller = new AbortController()
    await expect(images.generate({ prompt: '方案场景', size: '1024x1024',
      beforeRequest: () => { controller.abort(); return Promise.resolve() },
    }, controller.signal)).rejects.toMatchObject({ code: 'BID_IMAGE_CANCELLED' })
    expect(fetch).not.toHaveBeenCalled()
    expect(resolveCredential).toHaveBeenCalledOnce()
  })
})

describe('CPA Images API 真实 HTTP 入口', () => {
  it('未选择模型也可查询接口模型，并保持列表顺序去重', async () => {
    let observed: { url: string | undefined; authorization: string | undefined } = { url: undefined, authorization: undefined }
    const baseURL = await serve((request, response) => {
      observed = { url: request.url, authorization: request.headers.authorization }
      json(response, { data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-1.5' }, { id: 'gpt-image-2' }] })
    })
    expect(await provider(baseURL, { model: '' }).images.discoverModels(signal())).toEqual(['gpt-image-2', 'gpt-image-1.5'])
    expect(observed).toEqual({ url: '/v1/models', authorization: 'Bearer test-key' })
  })

  it('生成 JSON 和参考图 multipart 均返回完整解码的单张 PNG', async () => {
    const source = await png()
    const calls: Array<{ path: string | undefined; contentType: string | undefined; body: Buffer }> = []
    const baseURL = await serve(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      calls.push({ path: request.url, contentType: request.headers['content-type'], body: Buffer.concat(chunks) })
      json(response, { data: [{ b64_json: source.toString('base64') }] })
    })
    const { images } = provider(baseURL)
    const first = await images.generate({ prompt: '实施场景插图', size: '1536x1024' }, signal())
    const second = await images.generate({ prompt: '保持项目风格绘制另一场景', size: '1024x1536', reference: first.png }, signal())
    expect(first).toMatchObject({ width: 24, height: 16, model: 'gpt-image-2' })
    expect(await sharp(second.png).metadata()).toMatchObject({ format: 'png', width: 24, height: 16 })
    expect(calls[0]!.path).toBe('/v1/images/generations')
    expect(JSON.parse(calls[0]!.body.toString('utf8'))).toEqual({ model: 'gpt-image-2', prompt: '实施场景插图', size: '1536x1024', n: 1, output_format: 'png' })
    expect(calls[1]!.path).toBe('/v1/images/edits')
    expect(calls[1]!.contentType).toMatch(/^multipart\/form-data; boundary=/u)
    expect(calls[1]!.body.toString('utf8')).toContain('name="image"; filename="project-style.png"')
    expect(calls[1]!.body.includes(first.png)).toBe(true)
  })

  it.each(['png', 'jpeg', 'webp'] as const)('参考附件 %s 的实际 multipart 保留原始字节和媒体类型', async (format) => {
    const reference = await sharp(await png()).toFormat(format, { quality: 70 }).toBuffer()
    const output = await png()
    let sent: { bytes: Buffer; mediaType: string; name: string } | undefined
    const baseURL = await serve(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const form = await new Response(new Uint8Array(Buffer.concat(chunks)), {
        headers: { 'Content-Type': request.headers['content-type'] ?? '' },
      }).formData()
      const image = form.get('image')
      if (image === null || typeof image === 'string') throw new Error('image multipart part absent')
      sent = { bytes: Buffer.from(await image.arrayBuffer()), mediaType: image.type, name: image.name }
      json(response, { data: [{ b64_json: output.toString('base64') }] })
    })
    await provider(baseURL).images.generate({ prompt: '延续项目参考图风格', size: '1536x1024', reference }, signal())
    expect(sent).toEqual({ bytes: reference, mediaType: `image/${format}`, name: `project-style.${format}` })
  })

  it.each([
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"></svg>'), 'BID_IMAGE_INVALID_RESPONSE'],
    [Buffer.from('broken image'), 'BID_IMAGE_INVALID_RESPONSE'],
    [Buffer.alloc(101), 'BID_IMAGE_RESPONSE_TOO_LARGE'],
  ] as const)('非法参考附件在发起计费请求前拒绝 %#', async (reference, code) => {
    let calls = 0
    const baseURL = await serve((_request, response) => { calls++; response.end() })
    await expect(provider(baseURL, { maxImageBytes: 100 }).images.generate({
      prompt: '项目参考图', size: '1536x1024', reference,
    }, signal())).rejects.toMatchObject({ code })
    expect(calls).toBe(0)
  })

  it('项目冻结模型在正式配置改变后使用新地址与原模型', async () => {
    const source = await png()
    let usedModel = ''
    let oldCalls = 0
    const previous = await serve((_request, response) => { oldCalls++; response.end() })
    const baseURL = await serve(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      usedModel = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string }).model
      json(response, { data: [{ b64_json: source.toString('base64') }] })
    })
    const { images, settings } = provider(previous)
    const model = images.resolve()!.model
    settings['bid-images'] = { baseURL, model: '' }
    await images.generate({ prompt: '场景', size: '1024x1024', model }, signal())
    expect(usedModel).toBe('gpt-image-2')
    expect(oldCalls).toBe(0)
  })

  it.each([
    { data: [{ url: 'http://127.0.0.1:1/private' }] },
    { data: [{ b64_json: '%%%not-base64' }] },
    { data: [{ b64_json: Buffer.from('not an image').toString('base64') }] },
    { data: [{ b64_json: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64') }] },
    { data: [{ b64_json: 'AA==' }, { b64_json: 'AA==' }] },
  ])('拒绝 URL、坏 Base64、不完整/非栅格和多图响应 %#', async (reply) => {
    const baseURL = await serve((_request, response) => { json(response, reply) })
    await expect(provider(baseURL).images.generate({ prompt: '场景', size: '1024x1024' }, signal())).rejects.toMatchObject({ code: 'BID_IMAGE_INVALID_RESPONSE' })
  })

  it('不读取错误响应正文、不自动重试计费请求', async () => {
    let count = 0
    const baseURL = await serve((_request, response) => {
      count++
      response.writeHead(401)
      response.end('Authorization: Bearer provider-echoed-secret')
    })
    await expect(provider(baseURL).images.generate({ prompt: '场景', size: '1024x1024' }, signal())).rejects.toMatchObject({ code: 'BID_IMAGE_AUTH_ERROR', message: '作图接口返回 HTTP 401。', status: 401 })
    expect(count).toBe(1)
  })

  it('拒绝重定向，不把凭据带到另一接口', async () => {
    let targetCalls = 0
    const target = await serve((_request, response) => { targetCalls++; response.end() })
    const baseURL = await serve((_request, response) => { response.writeHead(302, { Location: `${target}/models` }); response.end() })
    await expect(provider(baseURL).images.discoverModels(signal())).rejects.toMatchObject({ code: 'BID_IMAGE_NETWORK_ERROR' })
    expect(targetCalls).toBe(0)
  })

  it('限制流式响应的实际总量，不相信 Content-Length', async () => {
    const baseURL = await serve((_request, response) => {
      response.write(' '.repeat(600_000))
      response.end(' '.repeat(600_000))
    })
    await expect(provider(baseURL, { maxImageBytes: 1 }).images.generate({ prompt: '场景', size: '1024x1024' }, signal())).rejects.toMatchObject({ code: 'BID_IMAGE_RESPONSE_TOO_LARGE' })
  })

  it('单张 Base64 图片超过 decoded 字节上限时拒绝', async () => {
    const source = await png()
    const baseURL = await serve((_request, response) => { json(response, { data: [{ b64_json: source.toString('base64') }] }) })
    await expect(provider(baseURL, { maxImageBytes: source.length - 1 }).images.generate({ prompt: '场景', size: '1024x1024' }, signal())).rejects.toMatchObject({ code: 'BID_IMAGE_RESPONSE_TOO_LARGE' })
  })

  it('停止信号取消等待中的 HTTP，并清理响应', async () => {
    let entered!: () => void
    const received = new Promise<void>((resolve) => { entered = resolve })
    const baseURL = await serve((_request, response) => { response.writeHead(200); response.write('{'); entered() })
    const controller = new AbortController()
    const generating = provider(baseURL).images.generate({ prompt: '场景', size: '1024x1024' }, controller.signal)
    const assertion = expect(generating).rejects.toMatchObject({ code: 'BID_IMAGE_CANCELLED' })
    await received
    controller.abort()
    await assertion
  })

  it('无响应的接口达到截止时间返回超时分类', async () => {
    const baseURL = await serve(() => {})
    await expect(provider(baseURL, { timeoutMs: 30 }).images.generate({ prompt: '场景', size: '1024x1024' }, signal())).rejects.toMatchObject({ code: 'BID_IMAGE_TIMEOUT' })
  })
})
