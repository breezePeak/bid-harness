/** 普通 Composer 上传、独立任务和持久交付链接经过真实浏览器及 Host。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { BidWorkspace, readBidProjectState } from '@deepseek-ai/dsh-bid'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { scriptedVerificationCall } from '../../../packages/bid/bid/tests/fixtures/task-verifier.ts'
import { nativeDocumentFixture } from '../../../packages/bid/bid/tests/fixtures/native-document.ts'
import { resolveBidToolAuthorization } from '../../../packages/bid/bid/src/bid-tool-authorization.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

class TaskEntryAdapter extends LlmAdapter {
  readonly pending: Array<{ name: string; args: object }> = []
  main?: Agent
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const verification = text.split('\n').find(line => line.startsWith('核验输入：'))
    let call: { name: string; args: object } | undefined
    let response = '可以直接聊天、处理附件或执行独立任务。'
    if (verification !== undefined) call = scriptedVerificationCall(
      JSON.parse(verification.slice('核验输入：'.length)) as Parameters<typeof scriptedVerificationCall>[0], options.messages)
    else if (!options.tools?.length) response = JSON.stringify({ status: 'pass', reason: '实际标签与连线完整。' })
    else if (this.main !== undefined && options.sessionId === this.main.id && resolveBidToolAuthorization(this.main) !== undefined) {
      call = this.pending.shift()
    }
    yield { type: 'block-start', index: 0, blockType: call === undefined ? 'text' : 'tool-call' }
    yield { type: 'block-end', index: 0, block: call === undefined ? { type: 'text', text: response }
      : { type: 'tool-call', id: CallId(verification === undefined ? call.name : 'verification'), name: call.name, arguments: JSON.stringify(call.args) } }
    yield { type: 'finish', reason: { kind: call === undefined ? 'stop' : 'tool-calls' } }
  }
}

it('空会话聊天、普通 Word 附件和独立流程图下载在重载后保持可用', async () => {
  const adapter = new TaskEntryAdapter()
  const scaffold = await launchWebScaffold({ modelAdapter: adapter,
    agentPresets: { roots: [{ path: fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url)), trust: 'system' }], default: 'bid' } })
  const browser = await chromium.launch()
  const evidence = join(REPO_ROOT, '.artifacts', 'bid-task-refactor-demo')
  await mkdir(evidence, { recursive: true })
  try {
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
    const console = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await expect.poll(() => scaffold.ctx.agents.list().some(agent => resolveSessionPreset(agent.session) === 'bid')).toBe(true)
    const agent = scaffold.ctx.agents.list().find(agent => resolveSessionPreset(agent.session) === 'bid')!
    adapter.main = agent
    const send = async (text: string) => {
      await page.locator('[data-composer-card] textarea').fill(text)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
    }
    expect(await page.getByRole('region', { name: '技术标生成' }).count()).toBe(0)
    await send('你好，介绍一下当前能处理的任务。')
    await page.getByText('可以直接聊天、处理附件或执行独立任务。', { exact: true }).waitFor()
    const original = await nativeDocumentFixture()
    await page.getByLabel('选择附件', { exact: true }).setInputFiles({ name: '成稿.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: original.bytes })
    await page.locator('[data-composer-card]').getByText('成稿.docx', { exact: true }).waitFor()
    await send('请保留这份原稿，暂时不要解析。')
    await expect.poll(() => agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && 'fileRefs' in event.data.source)).toBe(true)
    await agent.whenIdle()
    await page.getByRole('list', { name: '消息附件' }).getByText('成稿.docx', { exact: true }).waitFor()
    expect(agent.session.events.some(event => event.type === 'bid.run.started')).toBe(false)
    const workspace = new BidWorkspace(agent.session.header.cwd!)
    expect((await readBidProjectState(workspace))?.workflow ?? null).toBeNull()
    await expect(readFile(workspace.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' })
    adapter.pending.push({ name: 'bid_project_inspect', args: { query: { object: 'files' } } },
      { name: 'bid_run_task', args: { task: { goal: '绘制接收和交付流程图', scope: { kind: 'project' }, steps: [{
        description: '绘制并检查流程图', scope: { source: 'task' }, call: { capability: 'flowchart.create', input: {
          title: '接收交付流程', purpose: '说明接收、处理和交付', nodes: [{ type: 'start', text: '接收' }, { type: 'process', text: '处理' }, { type: 'end', text: '交付' }],
          edges: [{ from_position: 0, to_position: 1 }, { from_position: 1, to_position: 2 }],
        } },
      }] } } })
    await send('只画一张接收、处理、交付的流程图，不修改 Word。')
    const files = page.getByRole('list', { name: '本次任务交付文件' })
    await files.waitFor({ timeout: 90_000 })
    expect(await files.getByRole('link', { name: '下载', exact: true }).count()).toBe(3)
    const png = files.getByRole('listitem').filter({ hasText: '.png' })
    const download = page.waitForEvent('download')
    await png.getByRole('link', { name: '下载', exact: true }).click()
    const received = await download
    expect(received.suggestedFilename()).toContain('.png')
    const path = await received.path()
    expect((await readFile(path)).subarray(1, 4).toString()).toBe('PNG')
    await page.reload({ waitUntil: 'load' })
    await files.waitFor({ timeout: 20_000 })
    await page.getByRole('list', { name: '消息附件' }).getByText('成稿.docx', { exact: true }).waitFor()
    expect(await files.getByRole('link', { name: '下载', exact: true }).count()).toBe(3)
    await page.screenshot({ path: join(evidence, '浏览器任务交付.png'), fullPage: true })
    expect(console.pageErrors).toEqual([])
  } catch (error) {
    await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(evidence, '浏览器失败现场.png'), fullPage: true })
    await writeFile(join(evidence, '浏览器失败事件.json'), JSON.stringify(adapter.main?.session.events, null, 2))
    throw error
  } finally { await browser.close(); await scaffold.close() }
}, 150_000)
