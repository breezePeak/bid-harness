import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { BidImageSettings, type BidImageSettingsInjected } from '../src/client/BidImageSettings.tsx'

describe('标书作图设置注册', () => {
  it('按设置版本保存非敏感字段，晚声明和插件卸载正确移除卡片', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('conversationEvents', { register: () => () => {} } as never)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', {} as never)
    const config = { baseURL: 'https://stale.example/v1', effectiveBaseURL: 'https://cpa.example/v1', model: 'stale-model', credentialConfigured: true }
    const getImageGenerationConfig = vi.fn(async () => ({ ok: true, value: config }))
    const getImageGenerationModels = vi.fn(async () => ({ ok: true, value: ['image-one', 'image-two'] }))
    ctx.provide('remote', { bid: { getImageGenerationConfig, getImageGenerationModels } } as never)
    ctx.provide('remote.bid', {} as never)
    const section = { ns: 'bid-images', value: { baseURL: '', model: 'image-one' }, revision: 3 }
    const describeSettings = vi.fn(async () => ({ result: { ok: true, value: { writable: true, namespaces: [section] } } }))
    const mutate = vi.fn(async () => ({ result: { ok: true, value: { ...section, value: { baseURL: '', model: 'image-two' }, revision: 4 } } }))
    ctx.provide('connection', { api: { settings: { describe: describeSettings, mutate } } } as never)
    slots.register({ name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } } } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.section')).toHaveLength(0)
    const stop = slots.register({ name: 'root', priority: -1, children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const entry = slots.entries('settings.section')[0]!
    expect(entry.component).toBe(BidImageSettings)
    expect(resolveSlotLabel(entry.options.label)).toBe('标书作图')
    expect(getImageGenerationConfig).not.toHaveBeenCalled()
    const injected = (entry.inject as unknown as () => BidImageSettingsInjected)()
    await expect(injected.load()).resolves.toEqual({ ...config, ...section.value, revision: 3, writable: true })
    await expect(injected.getModels()).resolves.toEqual(['image-one', 'image-two'])
    await expect(injected.save({ baseURL: '', model: 'image-two' }, 3)).resolves.toMatchObject({ baseURL: '', model: 'image-two', revision: 4 })
    expect(mutate).toHaveBeenCalledWith({ ns: 'bid-images', expectedRevision: 3, ops: [
      { op: 'set', path: ['baseURL'], value: '' }, { op: 'set', path: ['model'], value: 'image-two' },
    ] })
    stop()
    expect(slots.entries('settings.section')).toHaveLength(0)
    slots.register({ name: 'root', priority: -1, children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    expect(slots.entries('settings.section')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
