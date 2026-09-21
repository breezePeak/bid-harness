/** 真实浏览器把章节引用与图片作为同一条主对话消息发送。 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { BidWorkspace, checkpointBidProjectState } from '@deepseek-ai/dsh-bid'
import { seedConversation, seedProjectArtifacts } from '../../../packages/bid/bid/tests/fixtures/project-session.ts'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

/** 完成一轮并保留主 Agent 实际收到的多模态消息。 */
class BidComposerAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('段落引用与图片经普通富内容链路进入同一条主 Agent 消息', async () => {
  const adapter = new BidComposerAdapter()
  const scaffold = await launchWebScaffold({
    agentPresets: {
      roots: [{ path: fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url)), trust: 'system' }],
      default: 'bid',
    },
    modelAdapter: adapter,
  })
  const browser = await chromium.launch()
  try {
    const workspaceRoot = join(scaffold.workspaceCwd, 'workspace')
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const errors = watchConsole(page)
    let promptPosts = 0
    let revisionPosts = 0
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      const path = new URL(request.url()).pathname
      if (path === '/api/session.prompt') promptPosts++
      if (path === '/api/bid/reviseChapter') revisionPosts++
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
    const state = await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    agent.session.append('bid.project.resumed', { revision: state.revision, runtime: state.runtime })
    await scaffold.ctx.sessions.flush(agent.session)
    const directWorkbench = await (scaffold.ctx.bid as unknown as {
      getReviewWorkbench(session: Session): Promise<{ outline: readonly unknown[] }>
    }).getReviewWorkbench(agent.session)
    expect(directWorkbench.outline).toHaveLength(1)
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bid/getReviewWorkbench')
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    expect((await refreshed).status()).toBe(200)
    const reader = page.getByRole('main', { name: '正文阅读' })
    await reader.getByText('选中第一段。', { exact: true }).waitFor({ timeout: 10_000 }).catch(async (error: unknown) => {
      throw new Error(await page.locator('body').innerText(), { cause: error })
    })
    expect(await reader.getByText('选中第一段。', { exact: true }).evaluate((element) => {
      const style = getComputedStyle(element)
      return Number.parseFloat(style.textIndent) / Number.parseFloat(style.fontSize)
    })).toBe(2)
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
    await input.evaluate((element) => {
      const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'layout-reference.png', { type: 'image/png' }))
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }))
    })
    await composer.getByRole('img', { name: 'layout-reference.png' }).waitFor()
    await input.fill('仅细化选中段落的职责。')
    const settled = scaffold.whenTurnSettled()
    await input.press('Enter')
    await settled
    expect(promptPosts).toBe(1)
    expect(revisionPosts).toBe(0)
    expect(await input.inputValue()).toBe('')
    expect(await composer.getByText('选中段落 · 1 技术方案 · 2 段', { exact: true }).count()).toBe(0)
    expect(await composer.getByRole('img', { name: 'layout-reference.png' }).count()).toBe(0)
    const request = adapter.requests.at(-1)
    const user = request?.messages.findLast(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('仅细化选中段落的职责。')))
    if (user === undefined) throw new Error('主 Agent 未收到章节引用消息')
    expect(user.content.map(block => block.type)).toEqual(['image', 'text'])
    const textBlock = user.content.find(block => block.type === 'text')
    expect(textBlock?.type).toBe('text')
    if (textBlock?.type !== 'text') throw new Error('主 Agent 未收到章节引用文本')
    expect(textBlock.text).toContain('"kind":"bid_chapter_reference"')
    const imageBlock = user.content.find(block => block.type === 'image')
    expect(imageBlock?.type).toBe('image')
    if (imageBlock?.type !== 'image') throw new Error('主 Agent 未收到引用图片')
    expect(imageBlock.attachment.mediaType).toBe('image/png')
    expect(await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')).toBe(markdown)
    expect(errors.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
