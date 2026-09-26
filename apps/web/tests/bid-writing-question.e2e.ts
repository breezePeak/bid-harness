/** S5 空入口在默认手动确认模式下直接启动，不出现写作意见问答。 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  BidWorkspace,
  bidProjectTaskState,
  checkpointBidProjectState,
  type WritingPlan,
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

describe('web e2e: S5 直接开始写作', () => {
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
    const workspaceCwd = foundAgent?.session.header.cwd
    if (foundAgent === undefined || workspaceCwd === undefined) throw new Error('Missing Bid agent workspace')
    agent = foundAgent
    workspace = new BidWorkspace(workspaceCwd)
    await seedProjectArtifacts(workspace)
    // 空入口覆盖重置后由浏览器启动 S5 的路径。
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

  it('默认手动确认模式直接保存计划并启动 S5，不询问用户意见', async () => {
    onTestFailed(() => saveFailureShot(page, 's5-direct-writing'))

    const state = await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'waiting_user', run: null })
    agent.session.append('bid.project.resumed', {
      state: bidProjectTaskState(state),
      revision: state.revision,
    })
    await (scaffold.ctx.bid as unknown as {
      publishWritingEntryView(session: Agent['session']): Promise<void>
    }).publishWritingEntryView(agent.session)

    await expect.poll(() => agent.session.events.some(event =>
      event.type === 'bid.run.started' && event.data.run.work.stage === 'chapter_writing'),
    { timeout: 20_000 }).toBe(true)
    const plan = JSON.parse(await readFile(join(workspace.projectRoot, 'chapters/writing-plan.json'), 'utf8')) as WritingPlan
    expect(plan).toMatchObject({ confirmed: true, user_requirements: [], user_message_refs: [] })
    await expect(readFile(join(workspace.projectRoot, 'chapters/writing-request.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await page.getByText('开始正文编写前，是否还有其他整体写作要求？').count()).toBe(0)
    expect(await page.getByRole('button', { name: '填写写作要求', exact: true }).count()).toBe(0)
  })
})
