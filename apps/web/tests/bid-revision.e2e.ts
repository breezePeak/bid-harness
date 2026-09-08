/** 真实浏览器发送章节引用；Host 无法恢复 Writer 时保留引用及用户意见。 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { BidWorkspace, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { seedConversation, seedProjectArtifacts } from '../../../packages/bid/bid/tests/fixtures/project-session.ts'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

it('章节拖入和段落右键引用使用专用修订接口，失败不发送主 Agent', async () => {
  const scaffold = await launchWebScaffold({
    agentPresets: {
      roots: [{ path: fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url)), trust: 'system' }],
      default: 'bid',
    },
  })
  const browser = await chromium.launch()
  try {
    const workspaceRoot = join(scaffold.workspaceCwd, 'workspace')
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const errors = watchConsole(page)
    let promptPosts = 0
    const revisionBodies: string[] = []
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      const path = new URL(request.url()).pathname
      if (path === '/api/session.prompt') promptPosts++
      if (path === '/api/bid/reviseChapter') revisionBodies.push(request.postData() ?? '')
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('region', { name: '技术标生成' }).waitFor()
    const agent = scaffold.ctx.agents.list().find(candidate => resolveSessionPreset(candidate.session) === 'bid')
    if (agent === undefined) throw new Error('缺少标书会话')
    seedConversation(agent.session)
    const workspace = new BidWorkspace(workspaceRoot)
    await seedProjectArtifacts(workspace)
    const markdown = '# 1 技术方案\n\n首段保留。\n\n选中第一段。\n\n选中第二段。\n\n末段保留。\n'
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), markdown)
    const logPath = join(workspace.projectRoot, 'chapters/execution-log.json')
    const log = JSON.parse(await readFile(logPath, 'utf8')) as { sections: Array<{ final_writer_child_session_id: string | null }> }
    log.sections[0]!.final_writer_child_session_id = null
    await writeFile(logPath, JSON.stringify(log))
    const state = await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    agent.session.append('bid.project.resumed', { revision: state.revision, runtime: state.runtime })
    await scaffold.ctx.sessions.flush(agent.session)
    const reader = page.getByRole('main', { name: '正文阅读' })
    await reader.getByText('选中第一段。', { exact: true }).waitFor({ timeout: 10_000 }).catch(async (error: unknown) => {
      throw new Error(await page.locator('body').innerText(), { cause: error })
    })
    const composer = page.locator('[data-composer-card]')
    const input = composer.locator('textarea')
    await page.getByRole('navigation', { name: '章节目录' }).getByRole('button', { name: /技术方案/ }).dragTo(input)
    await composer.getByText('章节 · 1 技术方案', { exact: true }).waitFor()
    await composer.getByRole('button', { name: '移除章节引用' }).click()
    await reader.evaluate((element) => {
      const paragraphs = element.querySelectorAll('[data-markdown-paragraph]')
      const range = document.createRange()
      range.setStart(paragraphs[1]!.firstChild!, 1)
      range.setEnd(paragraphs[2]!.firstChild!, 3)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await reader.getByText('选中第一段。', { exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '添加到对话框' }).click()
    await composer.getByText('选中段落 · 1 技术方案 · 2 段', { exact: true }).waitFor()
    await input.fill('仅细化选中段落的职责。')
    await input.press('Enter')
    await expect.poll(() => revisionBodies.length).toBe(1)
    await page.getByText(/该章节缺少原编写会话/).waitFor()
    expect(revisionBodies[0]).toContain('paragraphs')
    expect(revisionBodies[0]).toContain('选中第一段。')
    expect(revisionBodies[0]).toContain('选中第二段。')
    expect(await input.inputValue()).toBe('仅细化选中段落的职责。')
    expect(await composer.getByText('选中段落 · 1 技术方案 · 2 段', { exact: true }).count()).toBe(1)
    expect(promptPosts).toBe(0)
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(markdown)
    expect(errors.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
