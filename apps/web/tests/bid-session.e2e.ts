// Web e2e scenario: the dedicated Bid action carries a real browser-selected
// document through Host admission, workspace intake, stage events, projection,
// persistence, and reload without routing file bytes through session.prompt.
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-bid'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss,
  launchWebScaffold,
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

interface AnalysisManifestFile {
  id: string
  role: string
  parseStatus: string
  chunksPath: string | null
  chunkIndexPath: string | null
}

/** Deterministic model that drives S2 through the real Agent tool loop. */
class BidAnalysisAdapter extends LlmAdapter {
  readonly toolNames: string[] = []
  private call = 0
  private failFirstAnalysis = false
  private session: { cwd: string; id: string } | undefined

  setSession(cwd: string, id: string, failFirstAnalysis = false): void {
    this.session = { cwd, id }
    this.call = 0
    this.failFirstAnalysis = failFirstAnalysis
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

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const session = this.session
    if (session === undefined) throw new Error('Bid analysis adapter has no Session')
    this.call += 1
    const phase = (this.call - 1) % 3
    const base = '.bid-harness'
    if (phase === 0) {
      yield* this.toolCalls([
        { name: 'read', args: { file_path: `${base}/manifest.json` } },
        { name: 'grep', args: { pattern: '交付|评分|必须', path: `${base}/corpus` } },
        { name: 'read', args: { file_path: `${base}/corpus/${INTAKE_FILE_NAME}/chunks/index.json` } },
      ])
      return
    }
    if (phase === 1) {
      const failThisAttempt = this.failFirstAnalysis
      this.failFirstAnalysis = false
      const projectRoot = join(session.cwd, '.bid-harness')
      const manifest = JSON.parse(await readFile(join(projectRoot, 'manifest.json'), 'utf8')) as {
        files: AnalysisManifestFile[]
      }
      const tenderFiles = manifest.files.filter(file => file.role === 'tender' && file.parseStatus === 'success')
      const sources = await Promise.all(tenderFiles.map(async (file) => {
        if (file.chunksPath === null || file.chunkIndexPath === null) throw new Error('Tender file has no chunks')
        const index = JSON.parse(await readFile(join(projectRoot, file.chunkIndexPath), 'utf8')) as {
          chunks: Array<{ path: string }>
        }
        const chunk = index.chunks[0]
        if (chunk === undefined) throw new Error('Tender file has no chunk entry')
        const chunkPath = `${file.chunksPath}/${chunk.path}`
        const lines = (await readFile(join(projectRoot, chunkPath), 'utf8')).split('\n')
        const rawText = lines.find(line => line.trim().length > 0)?.trim()
        if (rawText === undefined) throw new Error('Tender chunk has no source text')
        return {
          ref: { file_id: file.id, chunk: chunkPath, line_start: 1, line_end: lines.length },
          rawText,
        }
      }))
      const refs = sources.map(source => source.ref)
      const ref = refs[0]
      const rawText = sources[0]?.rawText
      if (ref === undefined || rawText === undefined) throw new Error('Bid analysis needs a tender source')
      const documents = {
        'project.json': {
          schema_version: 1, project_name: '示例项目', tender_name: '示例招标', purchaser: null, owner: null,
          project_scope: ['完成项目交付'], technical_scope: [], delivery_scope: ['按期交付'],
          source_refs: refs, analyzed_tender_files: tenderFiles.map(file => file.id),
        },
        'requirements.json': {
          schema_version: 1,
          requirements: [{
            id: 'REQ-1', category: 'delivery',
            raw_text: rawText,
            normalized_requirement: '前端只展示 Host 投影的处理进度',
            mandatory: true, source_refs: [ref],
          }],
        },
        'scoring.json': {
          schema_version: 1,
          scoring_items: [{
            id: 'SCORE-1', parent: null, group: null, title: '交付能力',
            raw_text: rawText,
            criterion: '满足交付期限', score: null, score_range: null, must_answer: true, source_refs: [ref],
          }],
        },
        'compliance.json': {
          schema_version: 1,
          compliance_items: [{
            id: 'COMP-1', type: 'delivery', raw_text: rawText,
            normalized_rule: '前端不得推进业务阶段',
            severity: 'mandatory', source_refs: [ref],
          }],
        },
      }
      yield* this.toolCalls(Object.entries(documents).map(([name, document]) => ({
        name: 'write',
        args: {
          file_path: `${base}/analysis/${name}`,
          content: failThisAttempt && name === 'requirements.json'
            ? '{ invalid json'
            : `${JSON.stringify(document, null, 2)}\n`,
        },
      })))
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
      agentPresets: { roots: [{ path: SHIPPED_PRESETS, trust: 'system' }], default: 'standard' },
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
  })

  it('uploads a Markdown tender through the Host and restores the advanced stage', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-session'))
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)

    const standard = (await listedSessions(scaffold.baseUrl))[0]
    expect(standard?.agentPreset).toBe('standard')
    expect(await page.getByRole('region', { name: '技术标生成' }).count()).toBe(0)

    const urlBeforeSelection = page.url()
    await page.getByRole('button', { name: '标准模式' }).click()
    await page.getByRole('menuitem', { name: /标书模式/ }).click()

    await expect.poll(async () => (await listedSessions(scaffold.baseUrl))[0]?.agentPreset, {
      timeout: 15_000,
    }).toBe('bid')
    const bid = (await listedSessions(scaffold.baseUrl))[0]
    expect(bid?.sessionId).toBe(standard?.sessionId)
    expect(page.url()).toBe(urlBeforeSelection)
    if (bid?.sessionId === undefined) throw new Error('Bid session id is unavailable')
    const bidAgent = scaffold.ctx.agents.get(SessionId(bid.sessionId))
    if (bidAgent === undefined) throw new Error(`Bid session ${bid.sessionId} has no live Agent`)
    const bidCwd = bidAgent.session.header.cwd
    if (bidCwd === undefined) throw new Error('Bid session has no workspace cwd')
    analysisAdapter.setSession(bidCwd, bid.sessionId)

    const panel = page.getByRole('region', { name: '技术标生成' })
    await panel.waitFor({ timeout: 15_000 })
    await panel.getByText('文件接入', { exact: true }).waitFor()
    await page.getByText('请添加本项目资料', { exact: true }).waitFor()
    await page.getByText('等待处理', { exact: true }).first().waitFor()

    let promptPosts = 0
    let uploadPosts = 0
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      const path = new URL(request.url()).pathname
      if (path === '/api/session.prompt') promptPosts += 1
      if (path === '/api/bid/uploadFiles') uploadPosts += 1
    })

    const chooserReady = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '添加项目资料' }).click()
    const chooser = await chooserReady
    await chooser.setFiles(INTAKE_FIXTURE)

    await page.getByText(INTAKE_FILE_NAME, { exact: true }).waitFor()
    await page.getByRole('button', { name: '上传并解析' }).waitFor()
    expect(await page.getByText('请添加本项目资料', { exact: true }).count()).toBe(1)

    const uploadResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/bid/uploadFiles'
    ))
    await page.getByRole('button', { name: '上传并解析' }).click()
    await page.getByText('正在上传并解析文件', { exact: true }).waitFor({ timeout: 15_000 })
    await panel.getByText('文件接入', { exact: true }).waitFor({ timeout: 15_000 })
    expect((await uploadResponse).status()).toBe(200)

    await panel.getByText('证据映射', { exact: true }).waitFor({ timeout: 15_000 })
    await panel.getByText('等待处理', { exact: true }).waitFor({ timeout: 15_000 })

    expect(uploadPosts).toBe(1)
    expect(promptPosts).toBe(0)
    expect(analysisAdapter.toolNames).toEqual(['read', 'grep', 'read', 'write', 'write', 'write', 'write'])

    if (bid?.sessionId === undefined) throw new Error('Bid session id is unavailable')
    const sessionId = SessionId(bid.sessionId)
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`Bid session ${sessionId} has no live Agent`)
    expect(bidStageLifecycle(agent.session.events)).toEqual([
      { type: 'bid.stage.started', stage: 'file_intake', status: 'running' },
      { type: 'bid.stage.completed', stage: 'file_intake', status: 'completed' },
      { type: 'bid.stage.started', stage: 'tender_analysis', status: 'running' },
      { type: 'bid.stage.completed', stage: 'tender_analysis', status: 'completed' },
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
    for (const name of ['project.json', 'requirements.json', 'scoring.json', 'compliance.json']) {
      expect((await stat(join(projectRoot, 'analysis', name))).isFile()).toBe(true)
    }

    const persisted = await scaffold.ctx.sessionPersistence.readFrom(sessionId, 0)
    expect(bidStageLifecycle(persisted.events)).toEqual([
      { type: 'bid.stage.started', stage: 'file_intake', status: 'running' },
      { type: 'bid.stage.completed', stage: 'file_intake', status: 'completed' },
      { type: 'bid.stage.started', stage: 'tender_analysis', status: 'running' },
      { type: 'bid.stage.completed', stage: 'tender_analysis', status: 'completed' },
    ])

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('region', { name: '技术标生成' }).waitFor({ timeout: 15_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('region', { name: '技术标生成' })
      .getByText('证据映射', { exact: true }).waitFor({ timeout: 15_000 })
    expect((await listedSessions(scaffold.baseUrl))[0]?.sessionId).toBe(sessionId)
    expect(uploadPosts).toBe(1)
    expect(promptPosts).toBe(0)

    expect(consoleErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it('shows an S2 failure and retries it through the Host without starting S3', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-session-retry'))
    await page.getByRole('button', { name: /^(?:New session|新.*会话)$/ }).last().click()
    await page.getByRole('button', { name: '标准模式' }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '标准模式' }).click()
    await page.getByRole('menuitem', { name: /标书模式/ }).click()

    await expect.poll(async () => (await listedSessions(scaffold.baseUrl))
      .find(session => session.agentPreset === 'bid' && session.blank), { timeout: 15_000 }).toBeDefined()
    const bid = (await listedSessions(scaffold.baseUrl))
      .find(session => session.agentPreset === 'bid' && session.blank)
    if (bid === undefined) throw new Error('fresh Bid Session is unavailable')
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

    const panel = page.getByRole('region', { name: '技术标生成' })
    await panel.waitFor({ timeout: 15_000 })
    const chooserReady = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '添加项目资料' }).click()
    const chooser = await chooserReady
    await chooser.setFiles(INTAKE_FIXTURE)
    const uploadResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/bid/uploadFiles'
    ))
    await page.getByRole('button', { name: '上传并解析' }).click()
    expect((await uploadResponse).status()).toBe(200)

    await panel.getByText('招标分析', { exact: true }).waitFor({ timeout: 30_000 })
    await panel.getByText('处理失败', { exact: true }).waitFor({ timeout: 15_000 })
    await panel.getByText(/失败原因：.*TENDER_ANALYSIS_ARTIFACT_INVALID/u)
      .waitFor({ timeout: 15_000 })
    await panel.getByRole('button', { name: '重试' }).waitFor({ timeout: 15_000 })

    const retryResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/bid/retryStage'
    ))
    await panel.getByRole('button', { name: '重试' }).click()
    expect((await retryResponse).status()).toBe(200)
    await panel.getByText('证据映射', { exact: true }).waitFor({ timeout: 30_000 })
    await panel.getByText('等待处理', { exact: true }).waitFor({ timeout: 15_000 })

    expect(promptPosts).toBe(0)
    expect(retryPosts).toBe(1)
    expect(bidStageLifecycle(agent.session.events)).toEqual([
      { type: 'bid.stage.started', stage: 'file_intake', status: 'running' },
      { type: 'bid.stage.completed', stage: 'file_intake', status: 'completed' },
      { type: 'bid.stage.started', stage: 'tender_analysis', status: 'running' },
      { type: 'bid.stage.failed', stage: 'tender_analysis', status: 'failed' },
      { type: 'bid.stage.started', stage: 'tender_analysis', status: 'running' },
      { type: 'bid.stage.completed', stage: 'tender_analysis', status: 'completed' },
    ])
    expect(bidStageLifecycle(agent.session.events)
      .some(event => event.stage === 'evidence_mapping' && event.type === 'bid.stage.started')).toBe(false)
  }, 120_000)

  it('moves a started standard Session to a new Bid Session in the same Workspace', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bid-started-session'))
    await page.getByRole('button', { name: /^(?:New session|新.*会话)$/ }).last().click()
    await page.getByRole('button', { name: '标准模式' }).waitFor({ timeout: 15_000 })

    await expect.poll(async () => (await listedSessions(scaffold.baseUrl))
      .find(session => session.agentPreset === 'standard' && session.blank), { timeout: 15_000 }).toBeDefined()
    const standardSession = (await listedSessions(scaffold.baseUrl))
      .find(session => session.agentPreset === 'standard' && session.blank)
    if (standardSession === undefined) throw new Error('fresh standard Session is unavailable')
    const agent = scaffold.ctx.agents.get(SessionId(standardSession.sessionId))
    if (agent === undefined) throw new Error(`standard Session ${standardSession.sessionId} has no live Agent`)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)

    await expect.poll(async () => (await listedSessions(scaffold.baseUrl))
      .find(session => session.sessionId === standardSession.sessionId)?.blank, { timeout: 15_000 }).toBe(false)
    await page.getByRole('button', { name: '标准模式' }).click()
    await page.getByRole('menuitem', { name: /标书模式/ }).click()

    await expect.poll(async () => (await listedSessions(scaffold.baseUrl))
      .find(session => session.agentPreset === 'bid' && session.blank), { timeout: 15_000 }).toBeDefined()
    const sessions = await listedSessions(scaffold.baseUrl)
    const freshBid = sessions.find(session => session.agentPreset === 'bid' && session.blank)
    expect(freshBid?.sessionId).not.toBe(standardSession.sessionId)
    expect(sessions.find(session => session.sessionId === standardSession.sessionId)?.agentPreset).toBe('standard')
    await page.getByRole('region', { name: '技术标生成' }).waitFor({ timeout: 15_000 })
  }, 120_000)
})
