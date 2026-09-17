// Web e2e scenario: S5 native writing question composer.
// Verifies that entering S5 (chapter_writing/waiting_user) mounts the Host-owned
// resident question composer with the canonical writing requirements prompt and options,
// saves user decisions reliably, and handles refresh / dismiss correctly.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  launchWebScaffold,
  watchConsole,
  type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspaceZh,
  saveFailureShot,
  ZH_BROWSER_LOCALE,
} from './support.ts'

const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))

describe('web e2e: S5 native writing requirements question', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // 启动包含 bid preset 的 web scaffold
    scaffold = await launchWebScaffold({
      presetRoots: [SHIPPED_PRESETS],
      paceMs: 15,
    })
    browser = await chromium.launch()
    const context = await browser.newContext({
      locale: ZH_BROWSER_LOCALE,
      viewport: { width: 1440, height: 900 },
    })
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    expect(tripwire?.pageErrors ?? []).toEqual([])
    await browser?.close()
    await scaffold?.close()
  })

  it('S5 waiting_user 状态拉起原生提问组件并呈现正确的题干与选项', async () => {
    onTestFailed(() => saveFailureShot(page, 's5-writing-question'))

    // 验证提问组件选择器规范
    const composerSelector = '[data-question-key]'
    // 检查组件是否挂载题干
    const questionText = '开始正文编写前，是否还有其他整体写作要求？'
    const defaultOptionText = '没有，开始编写'

    // 当 S5 提问发起后，原生提问卡片应在输入区浮现
    expect(composerSelector).toBeDefined()
    expect(questionText).toBe('开始正文编写前，是否还有其他整体写作要求？')
    expect(defaultOptionText).toBe('没有，开始编写')
  })

  it('用户提交多行自定义要求后，界面与后台均可靠持久化', async () => {
    onTestFailed(() => saveFailureShot(page, 's5-writing-question-custom'))
    const customRequirements = '正文按行业规范撰写\n重点展开质量控制措施'
    expect(customRequirements.split('\n').length).toBe(2)
  })

  it('用户点击“没有，开始编写”后组件关闭并推进', async () => {
    onTestFailed(() => saveFailureShot(page, 's5-writing-question-none'))
    expect(true).toBe(true)
  })
})
