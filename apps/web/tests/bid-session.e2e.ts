// Web e2e scenario: the dedicated Bid action carries a real browser-selected
// document through Host admission, workspace intake, stage events, projection,
// persistence, and reload without routing file bytes through session.prompt.
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-bid'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss,
  launchWebScaffold,
  watchConsole,
  type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspaceZh,
  saveFailureShot,
  ZH_BROWSER_LOCALE,
} from './support.ts'

/** The shipped roster, including the Host-recognized `bid` preset. */
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const INTAKE_FIXTURE = fileURLToPath(new URL(
  '../../../packages/client/ui-bid/tests/fixtures/tender-notice.md',
  import.meta.url,
))
const INTAKE_FILE_NAME = 'tender-notice.md'

interface ListedSession {
  readonly sessionId: string
  readonly agentPreset?: string
}

/** Read the sole Session in this scenario from the Host list projection. */
async function listedSession(baseUrl: string): Promise<ListedSession | undefined> {
  const response = await fetch(`${baseUrl}/api/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'bid-session-live', method: 'session.list', payload: {},
    }),
  })
  const body = await response.json() as {
    result: { value?: { items: ListedSession[] } }
  }
  return body.result.value?.items[0]
}

function bidStageLifecycle(events: readonly SessionEvent[]): Array<{
  type: 'bid.stage.started' | 'bid.stage.completed' | 'bid.stage.failed'
  stage: string
  status: string
}> {
  return events.flatMap((event) => {
    if (event.type !== 'bid.stage.started'
      && event.type !== 'bid.stage.completed'
      && event.type !== 'bid.stage.failed') return []
    return [{ type: event.type, stage: event.data.stage, status: event.data.status }]
  })
}

describe('web e2e: Bid file intake', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      agentPresets: { roots: [{ path: SHIPPED_PRESETS, trust: 'system' }], default: 'standard' },
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1680, height: 1000 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('uploads a Markdown tender through the Host and restores the advanced stage', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-session'))
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)

    const standard = await listedSession(scaffold.baseUrl)
    expect(standard?.agentPreset).toBe('standard')
    expect(await page.getByRole('region', { name: '技术标生成' }).count()).toBe(0)

    const urlBeforeSelection = page.url()
    await page.getByRole('button', { name: '标准模式' }).click()
    await page.getByRole('menuitem', { name: /标书模式/ }).click()

    await expect.poll(async () => (await listedSession(scaffold.baseUrl))?.agentPreset, {
      timeout: 15_000,
    }).toBe('bid')
    const bid = await listedSession(scaffold.baseUrl)
    expect(bid?.sessionId).toBe(standard?.sessionId)
    expect(page.url()).toBe(urlBeforeSelection)

    const panel = page.getByRole('region', { name: '技术标生成' })
    await panel.waitFor({ timeout: 15_000 })
    await panel.getByText('文件接入', { exact: true }).waitFor()
    await page.getByText('请上传本次招标文件', { exact: true }).waitFor()
    await page.getByText('等待处理', { exact: true }).first().waitFor()

    let promptPosts = 0
    let uploadPosts = 0
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      const path = new URL(request.url()).pathname
      if (path === '/api/session.prompt') promptPosts += 1
      if (path === '/api/bid/uploadFiles') uploadPosts += 1
    })

    const chooserReady = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '选择招标文件' }).click()
    const chooser = await chooserReady
    await chooser.setFiles(INTAKE_FIXTURE)

    await page.getByText(INTAKE_FILE_NAME, { exact: true }).waitFor()
    await page.getByRole('button', { name: '上传并解析' }).waitFor()
    expect(await page.getByText('请上传本次招标文件', { exact: true }).count()).toBe(1)

    const uploadResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/bid/uploadFiles'
    ))
    await page.getByRole('button', { name: '上传并解析' }).click()
    await page.getByText('正在上传并解析文件', { exact: true }).waitFor({ timeout: 15_000 })
    await panel.getByText('文件接入', { exact: true }).waitFor({ timeout: 15_000 })
    expect((await uploadResponse).status()).toBe(200)

    await page.getByText('文件接入完成，等待招标分析', { exact: true })
      .waitFor({ timeout: 30_000 })
    await panel.getByText('招标分析', { exact: true }).waitFor({ timeout: 15_000 })
    await panel.getByText('等待处理', { exact: true }).waitFor({ timeout: 15_000 })

    expect(uploadPosts).toBe(1)
    expect(promptPosts).toBe(0)

    if (bid?.sessionId === undefined) throw new Error('Bid session id is unavailable')
    const sessionId = SessionId(bid.sessionId)
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`Bid session ${sessionId} has no live Agent`)
    expect(bidStageLifecycle(agent.session.events)).toEqual([
      { type: 'bid.stage.started', stage: 'file_intake', status: 'running' },
      { type: 'bid.stage.completed', stage: 'file_intake', status: 'completed' },
    ])

    const sessionCwd = agent.session.header.cwd
    if (sessionCwd === undefined) throw new Error('Bid session has no workspace cwd')
    const sessionRoot = join(sessionCwd, '.bid-harness', 'sessions', sessionId)
    const manifestPath = join(sessionRoot, 'manifest.json')
    expect((await stat(manifestPath)).isFile()).toBe(true)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      version: number
      files: Array<{
        originalName: string
        inputPath: string
        documentPath: string | null
        chunksPath: string | null
        chunkIndexPath: string | null
        parseStatus: string
      }>
    }
    expect(manifest.version).toBe(3)
    expect(manifest.files).toHaveLength(1)
    const imported = manifest.files[0]
    const documentPath = imported?.documentPath
    const chunksPath = imported?.chunksPath
    const chunkIndexRelativePath = imported?.chunkIndexPath
    if (imported === undefined
      || documentPath === null
      || documentPath === undefined
      || chunksPath === null
      || chunksPath === undefined
      || chunkIndexRelativePath === null
      || chunkIndexRelativePath === undefined) {
      throw new Error('Bid manifest has no complete imported Markdown record')
    }
    expect(imported).toMatchObject({
      originalName: INTAKE_FILE_NAME,
      inputPath: `input/${INTAKE_FILE_NAME}`,
      parseStatus: 'success',
    })
    const fixtureBytes = await readFile(INTAKE_FIXTURE)
    expect(await readFile(join(sessionRoot, imported.inputPath))).toEqual(fixtureBytes)
    expect(await readFile(join(sessionRoot, documentPath))).toEqual(fixtureBytes)

    const chunkIndexPath = join(sessionRoot, chunkIndexRelativePath)
    expect((await stat(chunkIndexPath)).isFile()).toBe(true)
    const chunkIndex = JSON.parse(await readFile(chunkIndexPath, 'utf8')) as {
      chunk_count: number
      chunks: Array<{ path: string }>
    }
    expect(chunkIndex.chunk_count).toBeGreaterThan(0)
    expect(chunkIndex.chunks).toHaveLength(chunkIndex.chunk_count)
    for (const chunk of chunkIndex.chunks) {
      expect((await stat(join(sessionRoot, chunksPath, chunk.path))).isFile()).toBe(true)
    }

    const persisted = await scaffold.ctx.sessionPersistence.readFrom(sessionId, 0)
    expect(bidStageLifecycle(persisted.events)).toEqual([
      { type: 'bid.stage.started', stage: 'file_intake', status: 'running' },
      { type: 'bid.stage.completed', stage: 'file_intake', status: 'completed' },
    ])

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('region', { name: '技术标生成' }).waitFor({ timeout: 15_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByText('文件接入完成，等待招标分析', { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByRole('region', { name: '技术标生成' })
      .getByText('招标分析', { exact: true }).waitFor({ timeout: 15_000 })
    expect((await listedSession(scaffold.baseUrl))?.sessionId).toBe(sessionId)
    expect(uploadPosts).toBe(1)
    expect(promptPosts).toBe(0)

    expect(consoleErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
