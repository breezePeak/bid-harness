/** 真实 Web 装配重放持久 Word 导出终态；文件生成由 Bid Host 回放覆盖。 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { BidWorkspace, bidProjectTaskState, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { seedProjectArtifacts } from '../../../packages/bid/bid/tests/fixtures/project-session.ts'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/bid-docx-export-notice', import.meta.url))

it('Word 导出完成与失败写入聊天时间线，刷新后仍显示结果和文件位置', async () => {
  const scaffold = await launchWebScaffold({
    agentPresets: {
      roots: [{ path: fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url)), trust: 'system' }],
      default: 'bid',
    },
  })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  const tripwire = watchConsole(page)
  try {
    onTestFailed(() => saveFailureShot(page, 'bid-docx-export-notice'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('region', { name: '技术标生成' }).waitFor()
    const agent = scaffold.ctx.agents.list().find(candidate => resolveSessionPreset(candidate.session) === 'bid')
    if (agent?.session.header.cwd === undefined) throw new Error('缺少标书会话工作区')
    const workspace = new BidWorkspace(agent.session.header.cwd)
    await seedProjectArtifacts(workspace)
    const state = await checkpointBidProjectState(workspace, { stage: 'docx_export', status: 'completed', run: null })
    agent.session.append('bid.project.resumed', { revision: state.revision, state: bidProjectTaskState(state) })
    const base = { operationId: 'web-export', templateId: null, startedAt: 1, updatedAt: 2 }
    const filePath = join(workspace.outputRoot, 'bid-chat-result.docx')
    agent.session.append('bid.docx_export.changed', { operation: {
      ...base, updatedAt: 3, status: 'completed', phase: 'finalizing', message: 'Word 导出完成',
      path: 'output/bid-chat-result.docx', filePath, warnings: [],
    } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByRole('tab', { name: '对话', exact: true }).click()
    const notices = page.locator('[data-chat-flow-kind="bid-docx-export-notice"]')
    await notices.first().getByText('Word 导出完成', { exact: true }).waitFor()
    expect(await notices.first().innerText()).toContain(filePath)
    expect(await page.getByTestId('bid-docx-export-plan').count()).toBe(0)

    agent.session.append('bid.docx_export.changed', { operation: {
      ...base, operationId: 'web-export-failed', startedAt: 4, updatedAt: 5,
      status: 'failed', phase: 'exporting', message: 'Word 导出失败', error: '生成的 Word 文件结构无效。',
    } })
    await scaffold.ctx.sessions.flush(agent.session)
    await notices.last().getByText('Word 导出失败，未完成', { exact: true }).waitFor()
    expect(await notices.count()).toBe(2)

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('tab', { name: '对话', exact: true }).click()
    await notices.last().getByText('Word 导出失败，未完成', { exact: true }).waitFor()
    expect(await notices.first().innerText()).toContain(filePath)
    const completed = await captureStableAria(page,
      '[data-chat-flow-kind="bid-docx-export-notice"]:has-text("Word 导出完成")', scaffold.workspaceCwd)
    const failed = await captureStableAria(page,
      '[data-chat-flow-kind="bid-docx-export-notice"]:has-text("Word 导出失败")', scaffold.workspaceCwd)
    if (scaffold.mode === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ui.expected.md'), [
      '## 完成', completed.replaceAll('\\', '/'), '## 失败', failed.replaceAll('\\', '/'),
    ].join('\n\n'), scaffold.mode)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
