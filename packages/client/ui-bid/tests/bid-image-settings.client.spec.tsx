// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidImageSettings, type BidImageSettingsInjected, type BidImageSettingsView } from '../src/client/BidImageSettings.tsx'

afterEach(cleanup)

const view: BidImageSettingsView = {
  baseURL: '', effectiveBaseURL: 'https://cpa.example/v1', model: 'image-one',
  credentialConfigured: true, revision: 7, writable: true,
}

function props(patch: Partial<BidImageSettingsInjected> = {}): BidImageSettingsInjected {
  return { load: async () => view, getModels: async () => ['image-one', 'image-two'],
    save: async config => ({ ...view, ...config, revision: 8 }), ...patch }
}

describe('BidImageSettings', () => {
  it('显示 CPA 多个作图模型，只保存地址和选定模型，不提供密钥输入', async () => {
    const save = vi.fn(props().save)
    const { container } = render(<BidImageSettings {...props({ save })} />)
    const model = await screen.findByRole('combobox', { name: '作图模型' })
    await screen.findByRole('option', { name: 'image-two' })
    expect(screen.getByText('认证沿用 pp 已配置的密钥。')).toBeTruthy()
    expect(container.querySelector('input[type="password"]')).toBeNull()
    const address = screen.getByRole('textbox', { name: '作图接口地址' })
    expect(address.getAttribute('placeholder')).toBe(view.effectiveBaseURL)
    fireEvent.change(address, { target: { value: ' https://images.example/v1 ' } })
    fireEvent.change(model, { target: { value: 'image-two' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await screen.findByText('作图配置已保存。')
    expect(save).toHaveBeenCalledWith({ baseURL: 'https://images.example/v1', model: 'image-two' }, 7)
    fireEvent.change(model, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await waitFor(() => { expect(save).toHaveBeenLastCalledWith({ baseURL: 'https://images.example/v1', model: '' }, 8) })
  })

  it('保存失败保留编辑内容，模型目录失败仍可关闭新项目作图', async () => {
    render(<BidImageSettings {...props({ getModels: async () => { throw new Error('CPA 目录暂不可用') },
      save: async () => { throw new Error('设置版本已变化，请重新读取') } })} />)
    await screen.findByText(/CPA 目录暂不可用/u)
    await screen.findByText('认证沿用 pp 已配置的密钥。')
    fireEvent.change(screen.getByRole('textbox', { name: '作图接口地址' }), { target: { value: 'https://changed.example/v1' } })
    fireEvent.change(screen.getByRole('combobox', { name: '作图模型' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await screen.findByText('设置版本已变化，请重新读取')
    expect(screen.getByRole('textbox', { name: '作图接口地址' })).toHaveProperty('value', 'https://changed.example/v1')
    expect(screen.getByRole('combobox', { name: '作图模型' })).toHaveProperty('value', '')
  })

  it('只读连接不允许编辑地址或模型', async () => {
    render(<BidImageSettings {...props({ load: async () => ({ ...view, writable: false, credentialConfigured: false, error: 'pp 提供方尚未配置' }) })} />)
    await screen.findByText('当前连接不允许修改设置。')
    expect(screen.getByRole('textbox', { name: '作图接口地址' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('combobox', { name: '作图模型' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '保存配置' })).toHaveProperty('disabled', true)
    expect(screen.getByText(/pp 尚未配置可用密钥/u)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('pp 提供方尚未配置')
  })

  it('模型刷新只接受最新响应，配置读取失败可以重试', async () => {
    const first = Promise.withResolvers<string[]>()
    const load = vi.fn(props().load).mockRejectedValueOnce(new Error('配置读取失败'))
    const getModels = vi.fn(props().getModels).mockReturnValueOnce(first.promise)
    render(<BidImageSettings {...props({ load, getModels })} />)
    await screen.findByText('配置读取失败')
    fireEvent.click(screen.getByRole('button', { name: '重新读取配置' }))
    await screen.findByRole('option', { name: 'image-two' })
    await act(async () => { first.resolve(['迟到目录']); await first.promise })
    expect(screen.queryByRole('option', { name: '迟到目录' })).toBeNull()
  })
})
