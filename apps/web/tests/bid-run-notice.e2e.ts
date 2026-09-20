import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))

describe('web e2e: Bid Run 错误提示', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let agent: Agent
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      agentPresets: { roots: [{ path: SHIPPED_PRESETS, trust: 'system' }], default: 'bid' },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 900 } })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('region', { name: '技术标生成' }).waitFor({ timeout: 20_000 })
    const found = scaffold.ctx.agents.list().find(candidate => resolveSessionPreset(candidate.session) === 'bid')
    if (found === undefined) throw new Error('Missing Bid agent')
    agent = found
  }, 120_000)

  afterAll(async () => {
    expect(tripwire?.pageErrors ?? []).toEqual([])
    await browser?.close()
    await scaffold?.close()
  })

  it('默认只显示一行重要错误，点击后显示完整诊断', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-run-notice'))
    const message = 'BID_STAGE_VALIDATION_FAILED；当前阶段结果未通过校验。；CHAPTER_REVIEW_TEXT_INVALID: 覆盖记录文本必须匹配当前章节 canonical 条目。'
    agent.session.append('bid.run.notice', {
      noticeId: 'run:web-error-disclosure:suspended',
      supersedesTurn: null,
      runId: 'web-error-disclosure',
      stage: 'chapter_writing',
      kind: 'interrupted',
      severity: 'error',
      message,
    })

    const alert = page.getByRole('alert').filter({ hasText: '阶段运行失败' })
    await alert.waitFor({ timeout: 10_000 })
    const disclosure = alert.getByRole('button')
    expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(await disclosure.textContent()).toContain('BID_STAGE_VALIDATION_FAILED；当前阶段结果未通过校验。')
    expect(await page.getByText(message, { exact: true }).count()).toBe(0)

    await disclosure.click()
    expect(await disclosure.getAttribute('aria-expanded')).toBe('true')
    await page.getByText(message, { exact: true }).waitFor()
  })
})
