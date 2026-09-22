import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { BidWorkspace, bidProjectTaskState, checkpointBidProjectState, type BidRunData } from '@deepseek-ai/dsh-bid'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'
import { seedProjectArtifacts } from '../../../packages/bid/bid/tests/fixtures/project-session.ts'

const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))

class PendingReplyAdapter extends LlmAdapter {
  readonly started = Promise.withResolvers<undefined>()

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('模型请求缺少取消信号')
    signal.throwIfAborted()
    this.started.resolve(undefined)
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    signal.throwIfAborted()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('web e2e: Bid 后台 Run 进度', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let agent: Agent
  let run: BidRunData
  let tripwire: ReturnType<typeof watchConsole>
  const adapter = new PendingReplyAdapter()

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      modelAdapter: adapter,
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
    run = {
      runId: 'web-progress', interactionSessionId: String(agent.session.id), executionSessionId: 'execution',
      epoch: 1, baseProjectRevision: 0,
      work: {
        kind: 'stage_execution', workId: 'web-progress-work', stage: 'tender_analysis',
        requestRef: 'web-progress', requestSha256: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64),
      },
      startedAt: 1, updatedAt: 1,
    }
    const state = await checkpointBidProjectState(workspace, { stage: 'tender_analysis', status: 'running', run })
    agent.session.append('bid.project.resumed', { revision: state.revision, state: bidProjectTaskState(state) })
  }, 120_000)

  afterAll(async () => {
    expect(tripwire?.pageErrors ?? []).toEqual([])
    await browser?.close()
    await scaffold?.close()
  })

  it('在空草稿显示后台 Stop，并在输入后恢复发送与阶段计划', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-run-progress'))
    agent.session.append('bid.run.started', { run })
    agent.session.append('bid.run.progress', {
      runId: 'web-progress', epoch: 1, stage: 'tender_analysis',
      progress: { phase: 'collecting', summary: '正在提取招标信息与原文依据', completed: 2, total: 5, updatedAt: 2 },
    })

    await page.getByText('计划 · S2 招标分析').waitFor({ timeout: 10_000 })
    await page.getByText('1 已完成 · 1 正在进行 · 1 待处理').waitFor({ timeout: 10_000 })
    await page.getByText('整理项目、技术、评分与合规信息').waitFor({ timeout: 10_000 })
    const planToggle = page.getByRole('button', { name: /计划 · S2 招标分析/ })
    expect(await planToggle.getAttribute('aria-expanded')).toBe('true')
    await planToggle.click()
    expect(await page.getByText('整理项目、技术、评分与合规信息').count()).toBe(0)
    await planToggle.click()
    await page.getByText('整理项目、技术、评分与合规信息').waitFor({ timeout: 10_000 })
    expect(await page.getByText('后台任务：S2 · 招标信息提取').count()).toBe(0)
    await page.getByRole('button', { name: '停止' }).waitFor({ timeout: 10_000 })
    const input = page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]')
    await input.fill('请说明当前进度')
    await page.getByRole('button', { name: '发送' }).waitFor({ timeout: 10_000 })
  })

  it('S3 目录复核显示五步计划，刷新后恢复进度且没有组件加载错误', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-s3-plan'))
    run = {
      ...run,
      runId: 'web-s3-progress',
      epoch: 2,
      work: { ...run.work, stage: 'outline_generation', workId: 'web-s3-work' },
      progress: { phase: 'reviewing', summary: '目录质量复核', updatedAt: 3 },
    }
    const workspace = new BidWorkspace(agent.session.header.cwd!)
    const state = await checkpointBidProjectState(workspace, { stage: 'outline_generation', status: 'running', run })
    agent.session.append('bid.project.resumed', { revision: state.revision, state: bidProjectTaskState(state) })

    const plan = page.getByRole('region', { name: '计划 · S3 初步目录生成' })
    await plan.waitFor({ timeout: 10_000 })
    expect(await plan.getByRole('listitem').allTextContents()).toEqual([
      '评分响应点分析', '生成初步技术标目录', '确定性校验', '目录质量复核', '最终校验',
    ])
    expect(await plan.locator('[data-status="completed"]').count()).toBe(3)
    expect(await plan.locator('[data-status="in_progress"]').textContent()).toBe('目录质量复核')
    expect(await plan.locator('[data-status="pending"]').textContent()).toBe('最终校验')

    await page.locator('textarea:enabled[placeholder="描述你想要构建的内容"]').fill('')
    await page.reload({ waitUntil: 'load' })
    await plan.waitFor({ timeout: 10_000 })
    expect(await plan.getByRole('listitem').count()).toBe(5)
    expect(await plan.locator('[data-status="in_progress"]').textContent()).toBe('目录质量复核')
    await page.getByRole('button', { name: '停止' }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('后台阶段显示停止按钮时，点击也中断正在进行的聊天回复', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-stop-reply'))
    await seedProjectArtifacts(new BidWorkspace(agent.session.header.cwd!))
    await page.locator('[data-composer-card] textarea').fill('')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '说明当前进度' }], source: { kind: 'user' } }))
    await adapter.started.promise
    try {
      await page.getByRole('button', { name: /^停止(?:生成)?$/ }).click()
      await expect.poll(() => agent.status, { timeout: 5000 }).toBe('idle')
      expect(agent.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
        data: { reason: { kind: 'aborted' } },
      })
      await expect.poll(() => page.getByRole('button', { name: /^停止(?:生成)?$/ }).count()).toBe(0)
    } finally {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      await agent.whenIdle()
    }
  })

  it('S4 运行和挂起共用计划表头统计，状态颜色与动画跟随 Host', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-s4-summary'))
    const workspace = new BidWorkspace(agent.session.header.cwd!)
    await seedProjectArtifacts(workspace)
    await writeFile(join(workspace.projectRoot, 'analysis/evidence-mapping-log.json'), JSON.stringify({
      schema_version: 5, max_concurrency: 2, observed_max_concurrency: 2,
      tasks: ['completed', 'completed', 'completed', 'running', 'running', 'pending', 'pending', 'pending', 'pending', 'pending'].map((status, index) => ({
        task_id: `MAP-${String(index + 1)}`, title: `研究任务 ${String(index + 1)}`,
        phase: index < 8 ? 'initial' : 'final_check', status, attempts: [], final_child_session_id: null,
      })),
    }))
    run = { ...run, runId: 'web-s4-progress', epoch: 3,
      work: { ...run.work, stage: 'evidence_mapping', workId: 'web-s4-work' },
      progress: { phase: 'mapping', summary: '逐章节资料研究与映射', updatedAt: 4 },
    }
    const active = await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'running', run })
    agent.session.append('bid.project.resumed', { revision: active.revision, state: bidProjectTaskState(active) })
    const plan = page.getByTestId('bid-stage-plan')
    await plan.getByTitle('进行中 2', { exact: true }).waitFor({ timeout: 15_000 })
    expect(await plan.getByTitle('已完成 3', { exact: true }).count()).toBe(1)
    expect(await plan.getByTitle('未开始 5', { exact: true }).count()).toBe(1)
    const executing = plan.getByTitle('进行中 2', { exact: true })
    expect(await executing.evaluate(element => getComputedStyle(element).animationName)).not.toBe('none')
    const colors = await Promise.all(['已完成 3', '进行中 2', '未开始 5'].map(text =>
      plan.getByTitle(text, { exact: true }).evaluate(element => getComputedStyle(element).color)))
    expect(new Set(colors).size).toBe(3)
    for (const [index, token] of ['--dsw-alias-state-success-primary', '--dsw-alias-brand-primary', '--dsw-alias-label-tertiary'].entries()) {
      const expected = await plan.evaluate((element, name) => {
        const probe = document.createElement('span')
        probe.style.color = `var(${name})`
        element.append(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      }, token)
      expect(colors[index]).toBe(expected)
    }
    expect(await plan.getByRole('status').textContent()).toBe('10/3/2/530%')
    await executing.hover()
    expect(await executing.getAttribute('title')).toBe('进行中 2')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await executing.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    const runningSnapshot = await captureStableAria(page, '[data-testid="bid-stage-plan"]', scaffold.workspaceCwd)
    const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    await plan.screenshot({ path: join(artifacts, 'bid-s4-summary-running.png') })

    await plan.getByRole('button', { expanded: true }).click()
    const stopped = await checkpointBidProjectState(workspace, {
      stage: 'evidence_mapping', status: 'suspended', run: { ...run, cause: 'user_stop' },
    })
    agent.session.append('bid.project.resumed', { revision: stopped.revision, state: bidProjectTaskState(stopped) })
    await plan.getByTitle('待恢复 2', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await plan.getByRole('button', { expanded: false }).count()).toBe(1)
    expect(await plan.getByTitle('待恢复 2', { exact: true }).evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    expect(await page.locator('[data-bid-progress]').count()).toBe(0)
    await plan.getByRole('button', { expanded: false }).click()
    const stoppedSnapshot = await captureStableAria(page, '[data-testid="bid-stage-plan"]', scaffold.workspaceCwd)
    await plan.screenshot({ path: join(artifacts, 'bid-s4-summary-stopped.png') })
    await page.setViewportSize({ width: 640, height: 900 })
    expect(await plan.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await plan.screenshot({ path: join(artifacts, 'bid-s4-summary-narrow.png') })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const snapshots = fileURLToPath(new URL('./snapshots/bid-run-progress', import.meta.url))
    if (scaffold.mode === 'refresh') await mkdir(snapshots, { recursive: true })
    await compareOrRefreshGolden(join(snapshots, 's4-summary.expected.md'), [
      '## 运行中', runningSnapshot, '## 已停止', stoppedSnapshot,
    ].join('\n\n'), scaffold.mode)
  })
})
