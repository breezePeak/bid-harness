// Web e2e scenario: S5 native writing question composer.
// Verifies that entering S5 (chapter_writing/waiting_user) mounts the Host-owned
// resident question composer with the canonical writing requirements prompt and options,
// saves user decisions reliably, and handles refresh / dismiss correctly.
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  BidWorkspace,
  checkpointBidProjectState,
  BID_WRITING_ENTRY_PROJECTION_KEY,
  type WritingRequest,
} from '@deepseek-ai/dsh-bid'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
import { seedProjectArtifacts } from '../../../packages/bid/bid/tests/fixtures/project-session.ts'

const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))

describe('web e2e: S5 native writing requirements question', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent
  let workspace: BidWorkspace

  beforeAll(async () => {
    // 启动包含 bid preset 的 web scaffold
    scaffold = await launchWebScaffold({
      agentPresets: { roots: [{ path: SHIPPED_PRESETS, trust: 'system' }], default: 'bid' },
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

    // 等待 Bid 面板就绪并获取 agent
    await page.getByRole('region', { name: '技术标生成' }).waitFor({ timeout: 20_000 })
    const foundAgent = scaffold.ctx.agents.list().find(candidate => resolveSessionPreset(candidate.session) === 'bid' && candidate.session.header.cwd !== undefined)
    if (foundAgent?.session.header.cwd === undefined) throw new Error('Missing Bid agent workspace')
    agent = foundAgent
    workspace = new BidWorkspace(agent.session.header.cwd)
    await seedProjectArtifacts(workspace)
    // 移除 S5 生成产物，使项目处于刚刚完成 S4 待进入 S5 提问的状态
    await rm(join(workspace.projectRoot, 'chapters/writing-plan.json'), { force: true })
    await rm(join(workspace.projectRoot, 'chapters/writing-request.json'), { force: true })
    await rm(join(workspace.projectRoot, 'chapters/execution-log.json'), { force: true })
    await rm(join(workspace.projectRoot, 'chapters/manifest.json'), { force: true })
    await rm(join(workspace.projectRoot, 'chapters/sections'), { recursive: true, force: true })

    // 初始化交互消息，使会话脱离 blank 状态
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '开始技术标正文编写' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // 等待后台初始化操作完全排空
    const host = scaffold.ctx.bid as unknown as { inFlight: Map<unknown, unknown> }
    for (let i = 0; i < 150 && host.inFlight.size > 0; i++) {
      await new Promise(r => setTimeout(r, 100))
    }
  }, 120_000)

  afterAll(async () => {
    expect(tripwire?.pageErrors ?? []).toEqual([])
    await browser?.close()
    await scaffold?.close()
  })

  it('S5 waiting_user 状态拉起原生提问组件并呈现正确的题干与选项', async () => {
    onTestFailed(() => saveFailureShot(page, 's5-writing-question'))

    // 发布进入 S5 waiting_user 状态
    const state = await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'waiting_user' })
    agent.session.append('bid.project.resumed', {
      workflow: state.workflow,
      run: state.run,
      lastRun: state.last_run,
      revision: state.revision,
    })

    // 提问卡片应由 BidStagePanel 自动向 Host 请求并在页面中浮现
    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: 20_000 })

    // 验证题干与选项文本真实渲染
    await expect.poll(() => composer.getByText('开始正文编写前，是否还有其他整体写作要求？').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(() => composer.getByText('没有，开始编写').count(), { timeout: 10_000 }).toBeGreaterThan(0)

    // 输入区 textarea 存在
    const customInput = composer.getByRole('textbox')
    await expect.poll(async () => customInput.isVisible(), { timeout: 5000 }).toBe(true)
  })

  it('用户提交多行自定义要求后，界面与后台均可靠持久化', async () => {
    onTestFailed(() => saveFailureShot(page, 's5-writing-question-custom'))

    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: 10_000 })
    const customInput = composer.getByRole('textbox')

    const customRequirements = '正文按行业规范撰写\n重点展开质量控制措施'
    await customInput.fill(customRequirements)
    expect(await customInput.inputValue()).toBe(customRequirements)

    // 点击提交按钮
    const submitBtn = composer.locator('footer button').last()
    await submitBtn.click()

    // 提交后提问卡片应关闭
    await composer.waitFor({ state: 'detached', timeout: 15_000 })

    // 轮询验证文件持久化落盘
    await expect.poll(async () => {
      try {
        const record = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
        return record.state
      } catch {
        return null
      }
    }, { timeout: 10_000 }).toBe('answered')

    const record = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
    expect(record.answer?.kind).toBe('custom')
    expect(record.answer?.custom).toBe(customRequirements)
    expect(record.continuation).toBe('allowed')
  })

  it('用户点击“没有，开始编写”后组件关闭并推进', async () => {
    onTestFailed(() => saveFailureShot(page, 's5-writing-question-none'))

    // 清理旧回答记录以重新触发提问
    await rm(join(workspace.projectRoot, 'chapters/writing-request.json'), { force: true })
    const host = scaffold.ctx.bid as unknown as { inFlight: Map<unknown, unknown> }
    for (let i = 0; i < 150 && host.inFlight.size > 0; i++) {
      await new Promise(r => setTimeout(r, 100))
    }
    const currentEntry = scaffold.ctx.sessionProjections.snapshot(agent.session).values[BID_WRITING_ENTRY_PROJECTION_KEY]
    if (currentEntry === null || currentEntry === undefined) throw new Error('Missing writing entry projection')
    const reopenRes = await scaffold.ctx.bid.requestWritingRequirements(agent.session, {
      mode: 'reopen',
      expected: currentEntry.expected,
    })
    expect(reopenRes).toMatchObject({ ok: true })

    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: 20_000 })

    // 选择“没有，开始编写”选项
    const option = composer.getByRole('radio', { name: '没有，开始编写' })
    await option.click()

    // 提交选择
    const submitBtn = composer.locator('footer button').last()
    if (await submitBtn.isVisible() && await submitBtn.isEnabled()) {
      await submitBtn.click()
    }

    // 提问卡片关闭
    await composer.waitFor({ state: 'detached', timeout: 15_000 })

    // 轮询验证后台持久化落盘
    await expect.poll(async () => {
      try {
        const record = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
        return record.state
      } catch {
        return null
      }
    }, { timeout: 10_000 }).toBe('answered')

    const record = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')) as WritingRequest
    expect(record.answer?.kind).toBe('no_additional_requirements')
    expect(record.answer?.selected).toContain('没有，开始编写')
    expect(record.continuation).toBe('allowed')
  })
})
