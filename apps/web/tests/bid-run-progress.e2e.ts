import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BidWorkspace, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))

describe('web e2e: Bid 后台 Run 进度', () => {
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
    if (found === undefined || found.session.header.cwd === undefined) throw new Error('Missing Bid agent workspace')
    agent = found
    const workspace = new BidWorkspace(found.session.header.cwd)
    const state = await checkpointBidProjectState(workspace, { stage: 'tender_analysis', status: 'running' })
    agent.session.append('bid.project.resumed', { revision: state.revision, runtime: state.runtime })
  }, 120_000)

  afterAll(async () => {
    expect(tripwire?.pageErrors ?? []).toEqual([])
    await browser?.close()
    await scaffold?.close()
  })

  it('在空草稿显示后台 Stop，并在输入后恢复发送与阶段计划', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-run-progress'))
    agent.session.append('bid.run.started', {
      run: {
        runId: 'web-progress', interactionSessionId: String(agent.session.id), executionSessionId: 'execution',
        stage: 'tender_analysis', epoch: 1, baseProjectRevision: 1, controlRevision: 1,
        work: {
          kind: 'stage_execution', workId: 'web-progress-work', stage: 'tender_analysis',
          requestRef: 'web-progress', requestSha256: 'a'.repeat(64), inputFingerprint: 'web-progress',
        },
        status: 'running', startedAt: 1, updatedAt: 1,
      },
    })
    agent.session.append('bid.run.progress', {
      runId: 'web-progress', epoch: 1, stage: 'tender_analysis',
      progress: { phase: 'collecting', summary: '正在提取招标信息与原文依据', completed: 2, total: 5, updatedAt: 2 },
    })

    await page.getByText('计划 · S2 招标分析').waitFor({ timeout: 10_000 })
    await page.getByText('1 已完成 · 1 正在进行 · 1 待处理').waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: /计划 · S2 招标分析/ }).click()
    await page.getByText('整理项目、技术、评分与合规信息').waitFor({ timeout: 10_000 })
    expect(await page.getByText('后台任务：S2 · 招标信息提取').count()).toBe(0)
    await page.getByRole('button', { name: '停止' }).waitFor({ timeout: 10_000 })
    const input = page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
    await input.fill('请说明当前进度')
    await page.getByRole('button', { name: '发送' }).waitFor({ timeout: 10_000 })
  })
})
