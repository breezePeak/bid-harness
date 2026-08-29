// Web e2e scenario: a Bid Session remains an ordinary DSH Session while the
// Host-owned preset identity and projection add the Bid input-dock surface.
// File selection is deliberately browser-local in this task: no prompt or
// upload route is called, and no stage transition is simulated.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspaceZh,
  saveFailureShot,
  ZH_BROWSER_LOCALE,
} from './support.ts'

/** The shipped roster, including the Host-recognized `bid` preset. */
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const PANEL_EXPECTED = join(
  fileURLToPath(new URL('./snapshots/bid-session', import.meta.url)),
  'panel.expected.md',
)
const MODE = webSnapshotMode()

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

describe('web e2e: Bid Session shell', () => {
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

  it('selects Bid mode and keeps PDF selection local to the unchanged Session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-session'))
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)

    const standard = await listedSession(scaffold.baseUrl)
    expect(standard?.agentPreset).toBe('standard')
    expect(await page.getByRole('heading', { name: '技术标生成' }).count()).toBe(0)

    const urlBeforeSelection = page.url()
    await page.getByRole('button', { name: '标准模式' }).click()
    await page.getByRole('menuitem', { name: /标书模式/ }).click()

    await expect.poll(async () => (await listedSession(scaffold.baseUrl))?.agentPreset, {
      timeout: 15_000,
    }).toBe('bid')
    const bid = await listedSession(scaffold.baseUrl)
    expect(bid?.sessionId).toBe(standard?.sessionId)
    expect(page.url()).toBe(urlBeforeSelection)

    await page.getByRole('heading', { name: '技术标生成' }).waitFor({ timeout: 15_000 })
    for (const stage of ['文件接入', '招标分析', '证据映射', '目录生成', '目录确认']) {
      await page.getByText(stage, { exact: true }).waitFor()
    }
    await page.getByText('请上传本次招标文件', { exact: true }).waitFor()
    await page.getByText('等待处理', { exact: true }).first().waitFor()
    const panelSnapshot = await captureStableAria(
      page,
      '[aria-labelledby="bid-stage-title"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(PANEL_EXPECTED, panelSnapshot, MODE)

    let promptPosts = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/session.prompt') {
        promptPosts += 1
      }
    })

    const chooserReady = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传招标文件' }).click()
    const chooser = await chooserReady
    await chooser.setFiles({
      name: '招标文件.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% browser-local Bid fixture\n'),
    })

    await page.getByText('招标文件.pdf', { exact: true }).waitFor()
    expect(await page.getByText('请上传本次招标文件', { exact: true }).count()).toBe(1)
    expect(await page.getByText('处理完成', { exact: true }).count()).toBe(0)
    await page.waitForTimeout(100)
    expect(promptPosts).toBe(0)
    expect(consoleErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
