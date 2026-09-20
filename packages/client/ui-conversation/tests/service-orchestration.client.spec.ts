// @vitest-environment jsdom
// ConversationController scope addressing over the runtime's real scope tag:
// TestSessions mints tagged scopes through the production createScope, so the
// service's scopeOf/binding path runs against production resolution (no local
// tag probe).
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { QueuedMessage, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { ConversationController, UnsupportedImageMediaTypeError } from '../src/client/service.ts'
import { zh } from '../src/client/locales.ts'

async function bench(readAttachment?: SessionFace['readAttachment']) {
  const runtime = await SlotTestRuntime.create()
  const prompt = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const beginOutgoing = vi.fn()
  const updateOutgoing = vi.fn()
  const updateQueue = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const loadOlder = vi.fn(() => Promise.resolve())
  await runtime.sessions.add({
    id: 's1',
    session: {
      prompt,
      beginOutgoing,
      updateOutgoing,
      updateQueue,
      cancel,
      loadOlder,
      ...(readAttachment === undefined ? {} : { readAttachment }),
    },
  })
  // config.input is required (the apply shares its hub with the inject
  // factories); the bench passes its own instance explicitly.
  const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}))
  const fiber = runtime.ctx.plugin(ConversationController, {
    input: hub,
    blocks: new ComposerBlockRegistry(),
  })
  await fiber.await()
  const root = runtime.ctx.get('conversation') as ConversationController
  const scoped = runtime.sessions.scope('s1')!.get('conversation') as ConversationController
  const shell = hub.shellFor(runtime.sessions.binding('s1')!)
  return {
    runtime, fiber, root, scoped, hub, shell, prompt, beginOutgoing, updateOutgoing, updateQueue, cancel, loadOlder,
  }
}

describe('ConversationController', () => {
  it('keeps immediate submit policy scoped to the addressed session', async () => {
    const b = await bench()
    expect(b.scoped.resolveSubmitModeOverride(true, true)).toBeUndefined()

    b.scoped.setSubmitModePolicy('immediate')
    expect(b.scoped.resolveSubmitModeOverride(false, true)).toBe('queue')
    expect(b.scoped.resolveSubmitModeOverride(true, true)).toBe('steer')
    expect(b.scoped.resolveSubmitModeOverride(true, false)).toBe('queue')

    await b.runtime.sessions.add({ id: 's2', session: { prompt: vi.fn() } })
    const other = b.runtime.sessions.scope('s2')!.get('conversation') as ConversationController
    expect(other.resolveSubmitModeOverride(true, true)).toBeUndefined()

    b.scoped.setSubmitModePolicy('default')
    expect(b.scoped.resolveSubmitModeOverride(true, true)).toBeUndefined()
    await b.runtime.dispose()
  })

  it('业务引用提交失败保留草稿且不转发普通消息，释放后恢复普通发送', async () => {
    const b = await bench()
    const sessionId = b.runtime.sessions.behavior('s1').sessionId
    const pending = Promise.withResolvers<{ kind: 'success' }>()
    const handler = vi.fn(() => pending.promise)
    const dispose = b.root.submitHandlers.register(sessionId, handler)
    expect(() => b.root.submitHandlers.register(sessionId, handler)).toThrow('已注册')
    b.shell.setDraft('仅修改引用段落')
    b.shell.submit()
    await vi.waitFor(() => { expect(handler).toHaveBeenCalledOnce() })
    expect(handler).toHaveBeenCalledWith('仅修改引用段落', [], expect.any(AbortSignal), 'queue', expect.any(String))
    expect(b.prompt).not.toHaveBeenCalled()
    pending.reject(new Error('正文已更新，请重新选择。'))
    await vi.waitFor(() => {
      expect(b.shell.notices.getSnapshot()?.text).toContain('正文已更新')
    })
    expect(b.shell.snapshot.draft).toBe('仅修改引用段落')
    expect(b.prompt).not.toHaveBeenCalled()
    dispose()
    b.shell.submit()
    await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: '仅修改引用段落' }], 'queue', expect.any(AbortSignal), expect.any(String))
    await b.runtime.dispose()
  })

  it('业务处理器按会话隔离并在未接管时发送普通消息', async () => {
    const b = await bench()
    const sessionId = b.runtime.sessions.behavior('s1').sessionId
    const otherPrompt = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
    await b.runtime.sessions.add({ id: 's2', session: { prompt: otherPrompt } })
    const handler = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
    const dispose = b.root.submitHandlers.register(sessionId, handler)
    b.shell.setDraft('重写章节')
    b.shell.submit()
    await vi.waitFor(() => { expect(b.shell.snapshot.draft).toBe('') })
    expect(handler).toHaveBeenCalledOnce()
    expect(b.prompt).not.toHaveBeenCalled()
    const otherShell = b.hub.shellFor(b.runtime.sessions.binding('s2')!)
    otherShell.setDraft('其他会话消息')
    otherShell.submit()
    await vi.waitFor(() => { expect(otherPrompt).toHaveBeenCalledOnce() })
    expect(handler).toHaveBeenCalledOnce()
    dispose()
    b.root.submitHandlers.register(sessionId, () => undefined)
    dispose()
    b.shell.setDraft('无引用消息')
    b.shell.submit()
    await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
    await b.runtime.dispose()
  })

  it('routes operations through the public Session binding', async () => {
    const b = await bench()
    await b.scoped.send('hello')
    await b.scoped.updateQueue('item-1' as never, { kind: 'remove' })
    await b.scoped.cancel()
    await b.scoped.loadOlder()
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue', undefined, undefined)
    expect(b.updateQueue).toHaveBeenCalledWith('item-1', { kind: 'remove' })
    expect(b.cancel).toHaveBeenCalledOnce()
    expect(b.loadOlder).toHaveBeenCalledOnce()
    await b.runtime.dispose()
  })

  it('send forwards explicit steer and signal and resolves at prompt admission', async () => {
    const b = await bench()
    const signal = new AbortController().signal
    await b.scoped.send('插话消息', 'steer', signal)
    expect(b.prompt).toHaveBeenCalledTimes(1)
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: '插话消息' }], 'steer', signal, undefined)
    await b.runtime.dispose()
  })

  it('sendSession forwards mode and signal to a business submitter without ordinary fallback', async () => {
    const b = await bench()
    const sessionId = b.runtime.sessions.behavior('s1').sessionId
    const signal = new AbortController().signal
    const handler = vi.fn((_text: string, _imageIds: readonly unknown[], receivedSignal: AbortSignal | undefined, mode?: 'queue' | 'steer') => {
      expect(receivedSignal).toBe(signal)
      expect(mode).toBe('steer')
      return Promise.resolve({ kind: 'success' as const })
    })
    const dispose = b.root.submitHandlers.register(sessionId, handler)
    b.shell.setDraft('业务插话')
    b.shell.submit('steer')
    await vi.waitFor(() => { expect(handler).toHaveBeenCalledOnce() })
    expect(b.prompt).not.toHaveBeenCalled()
    dispose()
    await b.runtime.dispose()
  })

  it('matches a prepared outgoing row only by submission identity when serialized text changes', async () => {
    const b = await bench()
    const session = b.runtime.sessions.behavior('s1')
    b.root.beginOutgoing(session, '界面可见文本', [], 'submission-visible')

    await expect(b.root.sendSession(
      session,
      '带业务引用的序列化文本',
      [],
      'queue',
      undefined,
      'submission-visible',
    )).resolves.toEqual({ kind: 'success' })

    expect(b.beginOutgoing).toHaveBeenCalledOnce()
    expect(b.beginOutgoing).toHaveBeenCalledWith(
      'submission-visible',
      [{ type: 'text', text: '界面可见文本' }],
      'queue',
    )
    expect(b.prompt).toHaveBeenCalledWith(
      [{ type: 'text', text: '带业务引用的序列化文本' }],
      'queue',
      undefined,
      'submission-visible',
    )
    await b.runtime.dispose()
  })

  it('keeps identical outgoing text independent by submission identity', async () => {
    const b = await bench()
    const session = b.runtime.sessions.behavior('s1')
    b.root.beginOutgoing(session, '相同内容', [], 'submission-first')
    b.root.beginOutgoing(session, '相同内容', [], 'submission-second')

    await b.root.sendSession(session, '相同内容', [], 'queue', undefined, 'submission-second')
    await b.root.sendSession(session, '相同内容', [], 'queue', undefined, 'submission-first')

    expect(b.beginOutgoing).toHaveBeenCalledTimes(2)
    expect(b.prompt).toHaveBeenNthCalledWith(
      1,
      [{ type: 'text', text: '相同内容' }],
      'queue',
      undefined,
      'submission-second',
    )
    expect(b.prompt).toHaveBeenNthCalledWith(
      2,
      [{ type: 'text', text: '相同内容' }],
      'queue',
      undefined,
      'submission-first',
    )
    await b.runtime.dispose()
  })

  it('marks a business-resolved error on the outgoing row without calling the Host prompt', async () => {
    const b = await bench()
    const session = b.runtime.sessions.behavior('s1')
    const dispose = b.root.submitHandlers.register(session.sessionId, () => Promise.resolve({
      kind: 'error',
      text: '引用已经失效',
    }))
    b.root.beginOutgoing(session, '更新引用', [], 'submission-business-error')

    await expect(b.root.sendSession(
      session,
      '更新引用',
      [],
      'steer',
      undefined,
      'submission-business-error',
    )).resolves.toEqual({ kind: 'error', text: '引用已经失效' })

    expect(b.updateOutgoing).toHaveBeenCalledWith(
      'submission-business-error',
      'failed',
      '引用已经失效',
    )
    expect(b.prompt).not.toHaveBeenCalled()
    dispose()
    await b.runtime.dispose()
  })

  it('does not hold a later queue submission behind an unfinished admission', async () => {
    const b = await bench()
    const first = Promise.withResolvers<{ ok: true; value: { accepted: true } }>()
    b.prompt.mockImplementationOnce(() => first.promise)
    const session = b.runtime.sessions.behavior('s1')

    const firstSend = b.root.sendSession(session, '第一条', [], 'queue')
    await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
    const secondSend = b.root.sendSession(session, '第二条', [], 'queue')
    await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledTimes(2) })
    expect(b.prompt).toHaveBeenNthCalledWith(2, [{ type: 'text', text: '第二条' }], 'queue', undefined, expect.any(String))

    first.resolve({ ok: true, value: { accepted: true } })
    await expect(Promise.all([firstSend, secondSend])).resolves.toEqual([
      { kind: 'success' },
      { kind: 'success' },
    ])
    await b.runtime.dispose()
  })

  it('folds Session business failures into callback rejections', async () => {
    const b = await bench()
    b.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'busy', details: {} } } as never)
    await expect(b.scoped.send('x')).rejects.toThrow('conversation.send failed: agent-busy: busy')
    b.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'nope', details: {} } } as never)
    await expect(b.scoped.cancel()).rejects.toThrow('conversation.cancel failed: internal: nope')
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'internal', message: 'broken', details: {} },
    } as never)
    await expect(b.scoped.updateQueue('item-1' as never, { kind: 'steer' }))
      .rejects.toThrow('conversation.updateQueue failed: internal: broken')
    await b.runtime.dispose()
  })

  it('treats strict-steer races as converged Queue delivery', async () => {
    const b = await bench()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'steer-unavailable', message: 'closed', details: {} },
    } as never)
    await expect(b.scoped.updateQueue('item-1' as never, { kind: 'steer' })).resolves.toBeUndefined()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'queue-item-not-found', message: 'claimed', details: {} },
    } as never)
    await expect(b.scoped.updateQueue('item-2' as never, { kind: 'steer' })).resolves.toBeUndefined()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'queue-item-not-found', message: 'claimed', details: {} },
    } as never)
    await expect(b.scoped.updateQueue('item-3' as never, { kind: 'remove' }))
      .rejects.toThrow('conversation.updateQueue failed: queue-item-not-found: claimed')
    await b.runtime.dispose()
  })

  it('releases draft previews when their session scope is disposed', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:draft-1')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDraftImages([
        new File([new Uint8Array(4)], 'a.png', { type: 'image/png' }),
      ])
      if (attachment === undefined) throw new Error('draft attachment missing')
      b.root.input.for(b.runtime.sessions.scope('s1')!).addImages([attachment.id])
      await b.runtime.sessions.remove('s1')
      expect(b.root.draftImages([attachment.id])).toEqual([])
      expect(revoked).toHaveBeenCalledWith('blob:draft-1')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('validates every MIME type before allocating previews', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    expect(() => b.root.createDraftImages([
      new File([Uint8Array.of(1)], 'valid.png', { type: 'image/png' }),
      new File([Uint8Array.of(2)], 'invalid.svg', { type: 'image/svg+xml' }),
    ])).toThrow(UnsupportedImageMediaTypeError)
    expect(created).not.toHaveBeenCalled()
    created.mockRestore()
    await b.runtime.dispose()
  })

  it('invalidates pending historical image loads when the rendered session is released', async () => {
    const read = Promise.withResolvers<Awaited<ReturnType<SessionFace['readAttachment']>>>()
    const b = await bench(() => read.promise)
    const sessionId = b.runtime.sessions.behavior('s1').sessionId
    const attachment = {
      attachmentId: AttachmentId('image-1'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } as const
    const pending = b.root.resolveImage(sessionId, attachment)
    b.root.releaseSessionImages(sessionId)
    read.resolve({ ok: true, value: { attachment, data: Uint8Array.of(1) } })
    await expect(pending).rejects.toThrow('historical image scope was released')
    await b.runtime.dispose()
  })

  it('fails loudly from the root scope, on an unbound session, or without SessionRuntime', async () => {
    const b = await bench()
    await expect(b.root.send('x')).rejects.toThrow(/requires a session scope/)
    await b.runtime.sessions.remove('s1')
    await expect(b.scoped.send('x')).rejects.toThrow(/resolved no binding/)
    await b.runtime.dispose()
    // No SessionRuntime at all: a bare context (the runtime always provides one).
    const bare = new Context()
    await bare.plugin(ConversationController, {
      input: new InputHub(bare, makeTranslate(zh, {})),
      blocks: new ComposerBlockRegistry(),
    }).await()
    const orphan = bare.get('conversation') as ConversationController
    await expect(orphan.send('x')).rejects.toThrow(/sessions service unavailable/)
  })
})

describe('InputHub queue steering (empty-draft accelerated Enter)', () => {
  const row = (id: string): QueuedMessage => ({
    id: id as never,
    messageId: `message-${id}` as never,
    placement: 'queued',
    content: [{ type: 'text', text: id }],
    preview: id,
    text: id,
  })

  it('steers every queued row in FIFO order and leaves steering rows alone', async () => {
    const b = await bench()
    await b.runtime.sessions.updateSnapshot('s1', (draft) => {
      draft.queue = [row('q-1'), { ...row('q-2'), placement: 'steering' }, row('q-3')]
    })
    b.shell.steerQueue()
    await vi.waitFor(() => {
      expect(b.updateQueue).toHaveBeenCalledTimes(2)
    })
    expect(b.updateQueue).toHaveBeenNthCalledWith(1, 'q-1', { kind: 'steer' })
    expect(b.updateQueue).toHaveBeenNthCalledWith(2, 'q-3', { kind: 'steer' })
    expect(b.shell.notices.getSnapshot()).toBeNull()
    await b.runtime.dispose()
  })

  it('converges silently when the turn closes or a row is claimed mid-steer', async () => {
    const b = await bench()
    await b.runtime.sessions.updateSnapshot('s1', (draft) => {
      draft.queue = [row('q-1'), row('q-2')]
    })
    // The turn closes before the second row: the flush stops, silently.
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'steer-unavailable', message: 'closed', details: {} },
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => { expect(b.updateQueue).toHaveBeenCalledTimes(1) })
    expect(b.shell.notices.getSnapshot()).toBeNull()

    // A row the host already claimed (e.g. a repeated empty-draft chord):
    // the duplicate strict steer is a silent no-op.
    await b.runtime.sessions.updateSnapshot('s1', (draft) => {
      draft.queue = [row('q-3')]
    })
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'queue-item-not-found', message: 'claimed', details: {} },
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => { expect(b.updateQueue).toHaveBeenCalledTimes(2) })
    expect(b.shell.notices.getSnapshot()).toBeNull()
    await b.runtime.dispose()
  })

  it('surfaces one notice on a genuine steer failure and stops', async () => {
    const b = await bench()
    await b.runtime.sessions.updateSnapshot('s1', (draft) => {
      draft.queue = [row('q-1'), row('q-2')]
    })
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'internal', message: 'broken', details: {} },
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => {
      expect(b.shell.notices.getSnapshot()).toEqual(
        expect.objectContaining({ level: 'error', text: '插话发送失败，请重试。' }),
      )
    })
    expect(b.updateQueue).toHaveBeenCalledTimes(1)
    await b.runtime.dispose()
  })

  it('no-ops without queued rows', async () => {
    const b = await bench()
    b.shell.steerQueue()
    expect(b.updateQueue).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })
})
