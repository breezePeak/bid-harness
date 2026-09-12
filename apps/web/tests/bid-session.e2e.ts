// Web e2e scenario: the dedicated Bid action carries a real browser-selected
// document through Host admission, workspace intake, stage events, projection,
// persistence, and reload without routing file bytes through session.prompt.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-bid'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss,
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  webSnapshotMode,
  watchConsole,
  type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspaceZh,
  saveFailureShot,
  ZH_BROWSER_LOCALE,
} from './support.ts'

/** The shipped roster, including the Host-recognized `bid` preset. */
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const INTAKE_FIXTURE = fileURLToPath(new URL(
  '../../../packages/client/ui-bid/tests/fixtures/tender-notice.md',
  import.meta.url,
))
const INTAKE_FILE_NAME = 'tender-notice.md'
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/bid-session', import.meta.url))
const CONFIRMATION_MODE_EXPECTED = join(SNAPSHOT_DIR, 'confirmation-mode.expected.md')
const WORD_TEMPLATE_EXPECTED = join(SNAPSHOT_DIR, 'word-template.expected.md')
const MODE = webSnapshotMode()

interface AnalysisManifestFile {
  id: string
  role: string
  parseStatus: string
  chunksPath: string | null
  chunkIndexPath: string | null
}

interface AnalysisSource {
  file_ref: string
  chunk: string
  semantic_hint: string
}

/** Deterministic model that drives S2 through the real Agent tool loop. */
class BidAnalysisAdapter extends LlmAdapter {
  readonly toolNames: string[] = []
  private call = 0
  private failFirstAnalysis = false
  private session: { cwd: string; id: string } | undefined
  private source: AnalysisSource | undefined

  setSession(cwd: string, id: string, failFirstAnalysis = false): void {
    this.session = { cwd, id }
    this.call = 0
    this.failFirstAnalysis = failFirstAnalysis
    this.source = undefined
    this.toolNames.length = 0
  }

  private *toolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>): Generator<StreamChunk> {
    for (const [index, call] of calls.entries()) {
      const id = CallId(`bid-analysis-${String(this.call)}-${String(index)}`)
      const block: ToolCallBlock = {
        type: 'tool-call',
        id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      }
      this.toolNames.push(call.name)
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index, block }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  private async analysisSource(): Promise<AnalysisSource> {
    if (this.source !== undefined) return this.source
    const session = this.session
    if (session === undefined) throw new Error('Bid analysis adapter has no Session')
    const projectRoot = join(session.cwd, '.bid-harness')
    const manifest = JSON.parse(await readFile(join(projectRoot, 'manifest.json'), 'utf8')) as {
      files: AnalysisManifestFile[]
    }
    const tenderIndex = manifest.files.findIndex(file => file.role === 'tender' && file.parseStatus === 'success')
    const tender = manifest.files[tenderIndex]
    if (tender === undefined || tender.chunksPath === null || tender.chunkIndexPath === null) {
      throw new Error('Tender file has no chunks')
    }
    const index = JSON.parse(await readFile(join(projectRoot, tender.chunkIndexPath), 'utf8')) as {
      chunks: Array<{ id: string; path: string }>
    }
    const chunk = index.chunks[0]
    if (chunk === undefined) throw new Error('Tender file has no chunk entry')
    const content = await readFile(join(projectRoot, tender.chunksPath, chunk.path), 'utf8')
    const lines = content.replace(/<!--[\s\S]*?-->/gu, '').split('\n')
    const semanticHint = lines.find(line => line.trim().length > 0)?.trim()
    if (semanticHint === undefined) throw new Error('Tender chunk has no source text')
    this.source = { file_ref: `T${String(tenderIndex + 1)}`, chunk: chunk.id, semantic_hint: semanticHint }
    return this.source
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.system?.includes('你只解释给定 DOCX 模板')) {
      const text = '{"rules":[],"mapping":{"body":"Normal"}}'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const session = this.session
    if (session === undefined) throw new Error('Bid analysis adapter has no Session')
    const phase = this.call++
    const base = '.bid-harness'
    if (phase === 0) {
      yield* this.toolCalls([{ name: 'read', args: { file_path: `${base}/manifest.json` } }])
      return
    }
    if (phase === 1) {
      yield* this.toolCalls([{ name: 'grep', args: { pattern: '交付|评分|必须', path: `${base}/corpus` } }])
      return
    }
    if (phase === 2) {
      yield* this.toolCalls([{ name: 'read', args: { file_path: `${base}/corpus/${INTAKE_FILE_NAME}/chunks/index.json` } }])
      return
    }
    if (this.failFirstAnalysis) {
      if (phase === 3) yield* this.toolCalls([{ name: 'finish_tender_analysis', args: {} }])
      else yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const source = await this.analysisSource()
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [
      {
        name: 'submit_project_fact',
        args: { field: 'project_name', value: '示例项目', sources: [source] },
      },
      {
        name: 'submit_requirement',
        args: {
          category: 'delivery', normalized_requirement: '前端只展示 Host 投影的处理进度',
          mandatory: true, sources: [source],
        },
      },
      {
        name: 'submit_scoring_item',
        args: {
          group: null, title: '交付能力', criterion: '满足交付期限', score: null, score_range: null,
          must_answer: true, sources: [source],
        },
      },
      {
        name: 'submit_compliance_item',
        args: {
          type: 'delivery', normalized_rule: '前端不得推进业务阶段', severity: 'mandatory', sources: [source],
        },
      },
      { name: 'finish_tender_analysis', args: {} },
      { name: 'finish_tender_analysis', args: { review_revision: 4 } },
    ]
    const call = calls[phase - 3]
    if (call !== undefined) {
      yield* this.toolCalls([call])
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface ListedSession {
  readonly sessionId: string
  readonly agentPreset?: string
  readonly blank: boolean
}

/** Read the Host Session list projection. */
async function listedSessions(baseUrl: string): Promise<readonly ListedSession[]> {
  const response = await fetch(`${baseUrl}/api/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'bid-session-live', method: 'session.list', payload: {},
    }),
  })
  const body = await response.json() as {
    result: { value?: { items: ListedSession[] } }
  }
  return body.result.value?.items ?? []
}

function bidStageLifecycle(events: readonly SessionEvent[]): Array<{
  type: 'bid.stage.started' | 'bid.stage.completed' | 'bid.stage.failed'
  stage: string
  status: string
}> {
  return events.flatMap((event) => {
    if (event.type !== 'bid.stage.started'
      && event.type !== 'bid.stage.completed'
      && event.type !== 'bid.stage.failed') return []
    return [{ type: event.type, stage: event.data.stage, status: event.data.status }]
  })
}

function docxTemplateBytes(variants = 0): Uint8Array {
  const paragraphs = Array.from({ length: variants }, (_, index) =>
    `<w:p><w:pPr><w:spacing w:before="${index + 1}"/></w:pPr><w:r><w:t>格式样本${index}</w:t></w:r></w:p>`,
  ).join('')
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:p><w:r><w:t>旧模板正文</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`),
    'word/styles.xml': strToU8(`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="${variants ? 'Manual' : 'Normal'}"/></w:style></w:styles>`),
  })
}

describe('web e2e: Bid file intake', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let analysisAdapter: BidAnalysisAdapter
  const consoleErrors: string[] = []

  beforeAll(async () => {
    analysisAdapter = new BidAnalysisAdapter()
    scaffold = await launchWebScaffold({
      agentPresets: { roots: [{ path: SHIPPED_PRESETS, trust: 'system' }], default: 'bid' },
      modelAdapter: analysisAdapter,
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1680, height: 1000 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await assertFixtureInventory(SNAPSHOT_DIR, ['confirmation-mode.expected.md', 'word-template.expected.md'])
  })

  it('uploads a Markdown tender through the Host and restores the advanced stage', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-session'))
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)

    await expect.poll(async () => (await listedSessions(scaffold.baseUrl))[0]?.agentPreset, {
      timeout: 15_000,
    }).toBe('bid')
    const bid = (await listedSessions(scaffold.baseUrl))[0]
    if (bid?.sessionId === undefined) throw new Error('Bid session id is unavailable')
    const bidAgent = scaffold.ctx.agents.get(SessionId(bid.sessionId))
    if (bidAgent === undefined) throw new Error(`Bid session ${bid.sessionId} has no live Agent`)
    const bidCwd = bidAgent.session.header.cwd
    if (bidCwd === undefined) throw new Error('Bid session has no workspace cwd')
    analysisAdapter.setSession(bidCwd, bid.sessionId)

    const panel = page.getByRole('region', { name: '技术标生成' })
    await panel.waitFor({ timeout: 15_000 })
    await panel.getByText('资料上传', { exact: true }).waitFor()
    await page.getByText('请添加本项目资料', { exact: true }).waitFor()
    await page.getByText('等待处理', { exact: true }).first().waitFor()
    const confirmationMode = page.getByRole('button', { name: '确认模式', exact: true })
    await confirmationMode.waitFor()
    expect(await confirmationMode.textContent()).toContain('手动确认')
    await confirmationMode.click()
    await page.getByRole('menuitem', { name: '自动确认', exact: true }).waitFor()
    await compareOrRefreshGolden(
      CONFIRMATION_MODE_EXPECTED,
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd),
      MODE,
    )
    await page.getByRole('menuitem', { name: '自动确认', exact: true }).click()
    expect(await confirmationMode.textContent()).toContain('自动确认')
    await confirmationMode.click()
    await page.getByRole('menuitem', { name: '手动确认', exact: true }).click()
    expect(await confirmationMode.textContent()).toContain('手动确认')

    let promptPosts = 0
    let uploadPosts = 0
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      const path = new URL(request.url()).pathname
      if (path === '/api/session.prompt') promptPosts += 1
      if (path === '/api/bid-upload') uploadPosts += 1
    })

    const chooserReady = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传招标文件' }).click()
    const chooser = await chooserReady
    await chooser.setFiles(INTAKE_FIXTURE)

    await page.getByText(INTAKE_FILE_NAME, { exact: true }).waitFor()
    await page.getByRole('button', { name: '上传并解析' }).waitFor()
    expect(await page.getByText('请添加本项目资料', { exact: true }).count()).toBe(1)

    const uploadResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/bid-upload'
    ))
    await page.getByRole('button', { name: '上传并解析' }).click()
    await page.getByText('正在上传并解析文件', { exact: true }).waitFor({ timeout: 15_000 })
    await panel.getByText('资料上传', { exact: true }).waitFor({ timeout: 15_000 })
    expect((await uploadResponse).status()).toBe(200)

    await panel.getByText('等待确认', { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '确认技术标分析' }).waitFor({ timeout: 15_000 })

    expect(uploadPosts).toBe(1)
    expect(promptPosts).toBe(0)
    expect(analysisAdapter.toolNames).toEqual([
      'read',
      'grep',
      'read',
      'submit_project_fact',
      'submit_requirement',
      'submit_scoring_item',
      'submit_compliance_item',
      'finish_tender_analysis',
      'finish_tender_analysis',
    ])

    if (bid?.sessionId === undefined) throw new Error('Bid session id is unavailable')
    const sessionId = SessionId(bid.sessionId)
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`Bid session ${sessionId} has no live Agent`)
    expect(bidStageLifecycle(agent.session.events)).toEqual([
      { type: 'bid.stage.started', stage: 'file_intake', status: 'running' },
      { type: 'bid.stage.completed', stage: 'file_intake', status: 'completed' },
      { type: 'bid.stage.started', stage: 'tender_analysis', status: 'running' },
    ])

    const sessionCwd = agent.session.header.cwd
    if (sessionCwd === undefined) throw new Error('Bid session has no workspace cwd')
    const projectRoot = join(sessionCwd, '.bid-harness')
    const manifestPath = join(projectRoot, 'manifest.json')
    expect((await stat(manifestPath)).isFile()).toBe(true)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      version: number
      files: Array<{
        originalName: string
        inputPath: string
        documentPath: string | null
        chunksPath: string | null
        chunkIndexPath: string | null
        parseStatus: string
        role: string
      }>
    }
    expect(manifest.version).toBe(4)
    expect(manifest.files).toHaveLength(1)
    const imported = manifest.files[0]
    const documentPath = imported?.documentPath
    const chunksPath = imported?.chunksPath
    const chunkIndexRelativePath = imported?.chunkIndexPath
    if (imported === undefined
      || documentPath === null
      || documentPath === undefined
      || chunksPath === null
      || chunksPath === undefined
      || chunkIndexRelativePath === null
      || chunkIndexRelativePath === undefined) {
      throw new Error('Bid manifest has no complete imported Markdown record')
    }
    expect(imported).toMatchObject({
      originalName: INTAKE_FILE_NAME,
      role: 'tender',
      inputPath: `input/${INTAKE_FILE_NAME}`,
      parseStatus: 'success',
    })
    const fixtureBytes = await readFile(INTAKE_FIXTURE)
    expect(await readFile(join(projectRoot, imported.inputPath))).toEqual(fixtureBytes)
    expect(await readFile(join(projectRoot, documentPath))).toEqual(fixtureBytes)

    const chunkIndexPath = join(projectRoot, chunkIndexRelativePath)
    expect((await stat(chunkIndexPath)).isFile()).toBe(true)
    const chunkIndex = JSON.parse(await readFile(chunkIndexPath, 'utf8')) as {
      chunk_count: number
      chunks: Array<{ path: string }>
    }
    expect(chunkIndex.chunk_count).toBeGreaterThan(0)
    expect(chunkIndex.chunks).toHaveLength(chunkIndex.chunk_count)
    for (const chunk of chunkIndex.chunks) {
      expect((await stat(join(projectRoot, chunksPath, chunk.path))).isFile()).toBe(true)
    }
    for (const name of ['project.json', 'requirements.json', 'scoring-origin.json', 'compliance.json']) {
      expect((await stat(join(projectRoot, 'analysis', name))).isFile()).toBe(true)
    }

    const persisted = await scaffold.ctx.sessionPersistence.readFrom(sessionId, 0)
    expect(bidStageLifecycle(persisted.events)).toEqual([
      { type: 'bid.stage.started', stage: 'file_intake', status: 'running' },
      { type: 'bid.stage.completed', stage: 'file_intake', status: 'completed' },
      { type: 'bid.stage.started', stage: 'tender_analysis', status: 'running' },
    ])

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('region', { name: '技术标生成' }).waitFor({ timeout: 15_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('button', { name: '确认技术标分析' }).waitFor({ timeout: 15_000 })
    expect((await listedSessions(scaffold.baseUrl))[0]?.sessionId).toBe(sessionId)
    expect(uploadPosts).toBe(1)
    expect(promptPosts).toBe(0)

    expect(consoleErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it('uploads a DOCX format template as bounded binary bytes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-docx-template'))
    let sessions = await listedSessions(scaffold.baseUrl)
    if (sessions.length === 0) {
      await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
      sessions = await listedSessions(scaffold.baseUrl)
    }
    const bid = sessions.find(session => session.agentPreset === 'bid')
    if (bid === undefined) throw new Error('Bid Session is unavailable')
    const agent = scaffold.ctx.agents.get(SessionId(bid.sessionId))
    if (agent === undefined) throw new Error('Bid Session has no live Agent')
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new Error('Bid Session has no workspace cwd')
    if (!agent.session.events.some(event => event.type === 'bid.stage.started'
      && event.data.stage === 'tender_analysis')) {
      analysisAdapter.setSession(cwd, bid.sessionId)
      const tenderBytes = await readFile(INTAKE_FIXTURE)
      const intake = await fetch(`${scaffold.baseUrl}/api/bid-upload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/vnd.dsh.bid-upload',
          'x-dsh-bid-session-id': bid.sessionId,
          'x-dsh-bid-files': encodeURIComponent(JSON.stringify([{
            name: INTAKE_FILE_NAME,
            role: 'tender',
            mediaType: 'text/markdown',
            size: tenderBytes.byteLength,
          }])),
        },
        body: new Blob([Uint8Array.from(tenderBytes).buffer]),
      })
      expect(intake.status).toBe(200)
      expect(await intake.json()).toMatchObject({ ok: true })
    }
    const bytes = docxTemplateBytes()
    const response = await fetch(`${scaffold.baseUrl}/api/bid-docx-template`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.dsh.bid-docx-template',
        'x-dsh-bid-session-id': bid.sessionId,
        'x-dsh-bid-docx-name': encodeURIComponent('公司 模板.docx'),
        'x-dsh-bid-docx-size': String(bytes.byteLength),
        'x-dsh-bid-docx-revision': '0',
      },
      body: new Blob([bytes.buffer as ArrayBuffer]),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      value: { templateMaxBytes: 300 * 1024 * 1024, state: { revision: 2, template: { name: '公司 模板.docx' } } },
    })
    const hash = createHash('sha256').update(bytes).digest('hex')
    expect(await readFile(join(cwd, '.bid-harness', `word-export/templates/${hash}.docx`))).toEqual(Buffer.from(bytes))

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('tab', { name: '导出 Word' }).click()
    await page.getByRole('region', { name: '导出 Word' }).waitFor()
    await page.getByText('公司 模板.docx', { exact: true }).waitFor()
    const snapshot = await captureStableAria(page, '[aria-label="导出 Word"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(WORD_TEMPLATE_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('选择 .docx 文件（最多 300 MiB）')

    const templateInput = page.getByLabel('上传 Word 模板')
    await templateInput.setInputFiles({
      name: '界面模板.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from(bytes),
    })
    await page.getByRole('status').getByText('模板解析完成').waitFor()
    await page.getByText('界面模板.docx', { exact: true }).waitFor()
    expect(await templateInput.inputValue()).toContain('界面模板.docx')

    await templateInput.setInputFiles({
      name: '无效模板.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('not a docx'),
    })
    await page.getByRole('alert').getByText('文件不是有效的 DOCX ZIP。').waitFor()
    await page.getByText('尚无本次模板识别结果。', { exact: true }).waitFor()
    expect(await page.getByRole('table', { name: '模板主要格式' }).count()).toBe(0)
    expect(await page.getByText('界面模板.docx', { exact: true }).count()).toBe(0)

    const mismatched = await fetch(`${scaffold.baseUrl}/api/bid-docx-template`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.dsh.bid-docx-template',
        'x-dsh-bid-session-id': bid.sessionId,
        'x-dsh-bid-docx-name': 'mismatched.docx',
        'x-dsh-bid-docx-size': '1',
        'x-dsh-bid-docx-revision': '2',
      },
      body: new Blob([Uint8Array.of(1, 2).buffer]),
    })
    expect(await mismatched.json()).toEqual({
      ok: false,
      error: { code: 'BID_DOCX_TEMPLATE_UPLOAD_FAILED', message: 'DOCX 模板内容与声明大小不一致。' },
    })

    const oversized = await fetch(`${scaffold.baseUrl}/api/bid-docx-template`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.dsh.bid-docx-template',
        'x-dsh-bid-session-id': bid.sessionId,
        'x-dsh-bid-docx-name': 'oversized.docx',
        'x-dsh-bid-docx-size': String(300 * 1024 * 1024 + 1),
        'x-dsh-bid-docx-revision': '2',
      },
      body: new Blob([Uint8Array.of(1).buffer]),
    })
    expect(await oversized.json()).toEqual({
      ok: false,
      error: { code: 'BID_DOCX_TEMPLATE_UPLOAD_FAILED', message: '模板文件不能超过 300 MiB。' },
    })
    await templateInput.setInputFiles({
      name: '复杂模板.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from(docxTemplateBytes(240)),
    })
    await page.getByText('复杂模板.docx', { exact: true }).waitFor()
    const config = JSON.parse(await readFile(join(cwd, '.bid-harness/word-export/config.json'), 'utf8')) as {
      extracted: { candidates: unknown[] }
    }
    expect(config.extracted.candidates).toHaveLength(241)
    const reloadWarningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, reloadWarningStart)
    await page.getByRole('tab', { name: '导出 Word' }).click()
    await page.getByText('复杂模板.docx', { exact: true }).waitFor()
    expect(await captureStableAria(page, '[aria-label="导出 Word"]', scaffold.workspaceCwd)).not.toContain('格式样本239')
  }, 60_000)

  it('shows an S2 failure and retries it through the Host without starting S3', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-session-retry'))
    const bid = (await listedSessions(scaffold.baseUrl))
      .find(session => session.agentPreset === 'bid')
    if (bid === undefined) throw new Error('Bid Session is unavailable')
    const agent = scaffold.ctx.agents.get(SessionId(bid.sessionId))
    if (agent === undefined) throw new Error(`Bid session ${bid.sessionId} has no live Agent`)
    const bidCwd = agent.session.header.cwd
    if (bidCwd === undefined) throw new Error('Bid session has no workspace cwd')
    analysisAdapter.setSession(bidCwd, bid.sessionId, true)

    let promptPosts = 0
    let retryPosts = 0
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      const path = new URL(request.url()).pathname
      if (path === '/api/session.prompt') promptPosts += 1
      if (path === '/api/bid/retryStage') retryPosts += 1
    })

    expect(await scaffold.ctx.bid.resetStage(agent, 'tender_analysis')).toEqual({
      stage: 'tender_analysis', status: 'waiting_start',
    })
    expect(await scaffold.ctx.bid.startStage(agent.session)).toMatchObject({ ok: true, value: {
      stage: 'tender_analysis', status: 'failed',
    } })
    const panel = page.getByRole('region', { name: '技术标生成' })
    await panel.waitFor({ timeout: 15_000 })
    await panel.getByText('招标分析', { exact: true }).waitFor({ timeout: 30_000 })
    await panel.getByText('处理失败', { exact: true }).waitFor({ timeout: 15_000 })
    await panel.getByText(/缺少必需的招标分析文件/u).first()
      .waitFor({ timeout: 15_000 })
    await panel.getByRole('button', { name: '重试' }).waitFor({ timeout: 15_000 })

    const retryResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/bid/retryStage'
    ))
    analysisAdapter.setSession(bidCwd, bid.sessionId)
    await panel.getByRole('button', { name: '重试' }).click()
    expect((await retryResponse).status()).toBe(200)
    await panel.getByText('等待确认', { exact: true }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: '确认技术标分析' }).waitFor({ timeout: 15_000 })

    expect(promptPosts).toBe(0)
    expect(retryPosts).toBe(1)
    expect(bidStageLifecycle(agent.session.events).slice(-3)).toEqual([
      { type: 'bid.stage.started', stage: 'tender_analysis', status: 'running' },
      { type: 'bid.stage.failed', stage: 'tender_analysis', status: 'failed' },
      { type: 'bid.stage.started', stage: 'tender_analysis', status: 'running' },
    ])
    expect(bidStageLifecycle(agent.session.events)
      .some(event => event.stage === 'outline_generation' && event.type === 'bid.stage.started')).toBe(false)
  }, 120_000)

  it('creates another Bid Session in the same Workspace after one starts', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-started-session'))
    const before = await listedSessions(scaffold.baseUrl)
    const existingIds = new Set(before.map(session => session.sessionId))
    await page.getByRole('button', { name: /^(?:New session|新.*会话)$/ }).last().click()

    await expect.poll(async () => (await listedSessions(scaffold.baseUrl))
      .find(session => session.agentPreset === 'bid' && !existingIds.has(session.sessionId)), { timeout: 15_000 }).toBeDefined()
    const firstBid = (await listedSessions(scaffold.baseUrl))
      .find(session => session.agentPreset === 'bid' && !existingIds.has(session.sessionId))
    if (firstBid === undefined) throw new Error('new Bid Session is unavailable')
    const agent = scaffold.ctx.agents.get(SessionId(firstBid.sessionId))
    if (agent === undefined) throw new Error(`Bid session ${firstBid.sessionId} has no live Agent`)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)

    await expect.poll(async () => (await listedSessions(scaffold.baseUrl))
      .find(session => session.sessionId === firstBid.sessionId)?.blank, { timeout: 15_000 }).toBe(false)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: /^(?:New session|新.*会话)$/ }).last().click()

    await expect.poll(async () => (await listedSessions(scaffold.baseUrl))
      .find(session => session.agentPreset === 'bid'
        && !existingIds.has(session.sessionId)
        && session.sessionId !== firstBid.sessionId), { timeout: 15_000 }).toBeDefined()
    const sessions = await listedSessions(scaffold.baseUrl)
    const freshBid = sessions.find(session => session.agentPreset === 'bid'
      && !existingIds.has(session.sessionId)
      && session.sessionId !== firstBid.sessionId)
    expect(freshBid?.sessionId).not.toBe(firstBid.sessionId)
    expect(sessions.find(session => session.sessionId === firstBid.sessionId)?.agentPreset).toBe('bid')
    await page.getByRole('region', { name: '技术标生成' }).waitFor({ timeout: 15_000 })
  }, 120_000)
})
