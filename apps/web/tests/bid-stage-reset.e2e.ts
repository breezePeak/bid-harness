/** 真实 S1 命令清空项目与浏览器上传状态；重连历史保留重置后的新选择。 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type WebSocketRoute } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { BidWorkspace, bidProjectTaskState, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { readBuiltInDocxTemplateBytes, saveDocxTemplate } from '../../../packages/bid/bid/src/docx-format-store.ts'
import { seedConversation, seedProjectArtifacts } from '../../../packages/bid/bid/tests/fixtures/project-session.ts'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/bid-stage-reset', import.meta.url))

it('同 S1 重置清空资料、模板及失败反馈，重连不清除新选择', async () => {
  const scaffold = await launchWebScaffold({
    agentPresets: {
      roots: [{ path: fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url)), trust: 'system' }],
      default: 'bid',
    },
  })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  const tripwire = watchConsole(page)
  let socket: WebSocketRoute | undefined
  let socketConnections = 0
  await page.routeWebSocket('**/api/events.*', (route) => {
    socketConnections += 1
    socket = route
    route.connectToServer()
  })
  try {
    onTestFailed(() => saveFailureShot(page, 'bid-stage-reset'))
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    const panel = page.getByRole('region', { name: '技术标生成' })
    await panel.waitFor()
    const agent = scaffold.ctx.agents.list().find(candidate => resolveSessionPreset(candidate.session) === 'bid')
    if (agent?.session.header.cwd === undefined) throw new Error('缺少标书会话工作区')
    const workspace = new BidWorkspace(agent.session.header.cwd)
    await seedProjectArtifacts(workspace)
    for (const path of ['flowcharts', 'output']) {
      await mkdir(join(workspace.projectRoot, path), { recursive: true })
      await writeFile(join(workspace.projectRoot, path, 'previous.txt'), '旧项目产物')
    }
    const originalPath = join(workspace.root, 'original-tender.md')
    await writeFile(originalPath, '用户原文件')
    const builtInTemplate = await readBuiltInDocxTemplateBytes()
    const template = await saveDocxTemplate(workspace, { revision: 0, name: '旧项目模板.docx', bytes: builtInTemplate })
    await scaffold.ctx.bid.saveDocxFormat(agent.session, template.templateId, {
      revision: template.state.revision, userConfirmed: { 'body.size': 14 },
    })
    await scaffold.ctx.bid.saveDocxFormat(agent.session, null, { revision: 0, userConfirmed: { 'page.left': 25 } })
    const initial = await checkpointBidProjectState(workspace, { stage: 'file_intake', status: 'waiting_user', run: null })
    agent.session.append('bid.project.resumed', { revision: initial.revision, state: bidProjectTaskState(initial) })
    seedConversation(agent.session)
    await scaffold.ctx.sessions.flush(agent.session)
    const reloadWarningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, reloadWarningStart)
    await page.getByRole('tab', { name: '对话', exact: true }).click()
    const templateButton = panel.getByRole('button', { name: '导入模板', exact: true })
    await expect.poll(() => templateButton.getAttribute('title')).toContain('旧项目模板.docx')

    const tenderChooser = page.waitForEvent('filechooser')
    await panel.getByRole('button', { name: '招标文件', exact: true }).click()
    await (await tenderChooser).setFiles({ name: '旧招标资料.md', mimeType: 'text/markdown', buffer: Buffer.from('旧招标资料') })
    const templateChooser = page.waitForEvent('filechooser')
    await templateButton.click()
    await (await templateChooser).setFiles({
      name: '失败模板.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('无效 DOCX'),
    })
    await panel.getByRole('button', { name: '上传并解析', exact: true }).click()
    await panel.getByRole('alert').getByText(/文件不是有效的 DOCX ZIP/u).waitFor()
    expect(await panel.getByRole('list', { name: '已选择文件' }).getByRole('listitem').count()).toBe(2)
    expect(await panel.getByText('正在解析 Word 模板…', { exact: true }).count()).toBe(1)
    const failed = await captureStableAria(page, 'section[aria-label="技术标生成"]', scaffold.workspaceCwd)

    const history = [...agent.session.events]
    const command = await scaffold.ctx.commands.execute(agent, '/bid-reset-s1', [], new AbortController().signal)
    expect(command?.result).toEqual({ kind: 'success', text: '资料上传阶段重置已应用。当前状态：file_intake / waiting_user。' })
    await scaffold.ctx.sessions.flush(agent.session)
    await expect.poll(() => templateButton.getAttribute('title')).toBe('用于正文页数估算与排版；模板不会进入招标资料库')
    await expect.poll(() => panel.getByRole('list', { name: '已选择文件' }).count()).toBe(0)
    await page.getByText('资料上传阶段重置已应用。当前状态：file_intake / waiting_user。', { exact: true }).waitFor()
    expect(await panel.getByRole('alert').count()).toBe(0)
    expect(await panel.getByText('正在解析 Word 模板…', { exact: true }).count()).toBe(0)
    expect(await panel.getByText('请添加本项目资料', { exact: true }).count()).toBe(1)
    expect(await panel.getByRole('button', { name: '上传并解析', exact: true }).isDisabled()).toBe(true)
    for (const path of ['input', 'corpus', 'manifest.json', 'word-export', 'analysis', 'outline', 'chapters', 'flowcharts', 'output']) {
      await expect(access(join(workspace.projectRoot, path))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect((await scaffold.ctx.bid.getDocxTemplateLibrary(agent.session)).templates).toEqual([])
    expect((await scaffold.ctx.bid.getDocxFormat(agent.session, null)).state.userConfirmed).toEqual({})
    expect(await readFile(originalPath, 'utf8')).toBe('用户原文件')
    expect(await readBuiltInDocxTemplateBytes()).toEqual(builtInTemplate)
    expect(agent.session.events.slice(0, history.length)).toEqual(history)
    const reset = await captureStableAria(page, 'section[aria-label="技术标生成"]', scaffold.workspaceCwd)

    const freshTenderChooser = page.waitForEvent('filechooser')
    await panel.getByRole('button', { name: '招标文件', exact: true }).click()
    await (await freshTenderChooser).setFiles({ name: '新招标资料.md', mimeType: 'text/markdown', buffer: Buffer.from('新招标资料') })
    const freshTemplateChooser = page.waitForEvent('filechooser')
    await templateButton.click()
    await (await freshTemplateChooser).setFiles({
      name: '新项目模板.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: builtInTemplate,
    })
    const queue = panel.getByRole('list', { name: '已选择文件' })
    await queue.getByText('新项目模板.docx', { exact: true }).waitFor()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connectionsBefore = socketConnections
      const connectionWarningStart = tripwire.warnings.length
      if (socket === undefined) throw new Error('缺少浏览器事件连接')
      const historyResponse = page.waitForResponse(response => response.request().postData()?.includes('"method":"session.history"') === true)
      await socket.close({ code: 1012, reason: 'S1 重连历史回归' })
      await expect.poll(() => socketConnections).toBeGreaterThan(connectionsBefore)
      const history = await historyResponse
      expect(history.ok()).toBe(true)
      await history.finished()
      await page.getByText('资料上传阶段重置已应用。当前状态：file_intake / waiting_user。', { exact: true }).waitFor()
      await expect.poll(() => panel.getByRole('button', { name: '上传并解析', exact: true }).isEnabled()).toBe(true)
      acknowledgeReloadConnectionLoss(tripwire, connectionWarningStart)
      expect(await queue.getByRole('listitem').count()).toBe(2)
      expect(await queue.getByText('新招标资料.md', { exact: true }).count()).toBe(1)
      expect(await queue.getByText('新项目模板.docx', { exact: true }).count()).toBe(1)
    }
    const reconnected = await captureStableAria(page, 'section[aria-label="技术标生成"]', scaffold.workspaceCwd)
    if (scaffold.mode === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ui.expected.md'), [
      '## 重置前的失败队列', failed, '## 同阶段重置后', reset, '## 重连后的新选择', reconnected,
    ].join('\n\n'), scaffold.mode)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } catch (error: unknown) {
    await saveFailureShot(page, 'bid-stage-reset')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
