// @vitest-environment jsdom
/** Default selection and GPT connection edits use the existing settings and credential APIs. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { DefaultProviderEditor } from '../src/client/DefaultProviderEditor.tsx'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { settingsSchema } from './settings-schema.client.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const ok = <T,>(value: T) => ({ rpcId: 'test', result: { ok: true, value } })

describe('Provider settings', () => {
  it('persists the default provider/model pair together and clears an incompatible effort', async () => {
    const namespace = { ns: 'agent-default-model', value: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, revision: 4 } as SettingsNamespaceView
    const mutate = vi.fn(async () => ok(namespace))
    const saved = vi.fn()
    const api = { settings: { mutate }, llm: { models: vi.fn(async () => ok({ groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] },
      { id: 'gpt', name: 'GPT', models: [{ id: 'gpt-test', name: 'GPT Test' }] },
    ], failures: [] })) } }
    render(<DefaultProviderEditor namespace={namespace} api={api as never} writable onSaved={saved} />)
    await screen.findByRole('option', { name: 'GPT' })
    fireEvent.change(screen.getByLabelText('默认 Provider'), { target: { value: 'gpt' } })
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存默认 Provider' }))
    await waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
    expect(mutate).toHaveBeenCalledWith({ ns: 'agent-default-model', expectedRevision: 4, ops: [
      { op: 'set', path: ['provider'], value: 'gpt' },
      { op: 'set', path: ['model'], value: 'gpt-test' },
      { op: 'unset', path: ['reasoningEffort'] },
    ] })
  })

  it('edits GPT Base URL without overwriting its saved key or another Provider', async () => {
    const value = { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1', models: [{ id: 'gpt-test' }] }
    const schema = Schema.object({ apiKeyEnv: Schema.string().role('credential-ref'), baseURL: Schema.string(), models: Schema.array(Schema.object({ id: Schema.string().required() })) })
    const namespace: SettingsNamespaceView = { ns: 'llm-gpt', schema: schema.toJSON(), value, user: value, applies: 'live', secrets: [], revision: 2 }
    const mutate = vi.fn(async () => ok({ ...namespace, revision: 3 }))
    const set = vi.fn(async () => ok({}))
    const api = { settings: { mutate }, llm: {}, credentials: {
      describe: vi.fn(async () => ok({ credentials: { OPENAI_API_KEY: { configured: true, writable: true } } })), set,
    } }
    render(<ProviderEditor provider="gpt" displayName="GPT" namespace={namespace} schema={settingsSchema}
      settingsPath={[]} api={api as never} t={key => en[key]} readOnly={false} onClose={() => {}} />)
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    await waitFor(() => { expect(key.placeholder).toBe(en.keyStored) })
    expect(key.value).toBe('')
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'http://localhost:8317' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(mutate).toHaveBeenCalledWith({ ns: 'llm-gpt', expectedRevision: 2, ops: [{ op: 'set', path: ['baseURL'], value: 'http://localhost:8317' }] })
    expect(set).not.toHaveBeenCalled()
  })
})
