/** 真实 Web 应用从项目文件读取父章节概述，并在正文阅读区切换父子章节。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { BidWorkspace, checkpointBidProjectState, outlineArtifactSha256 } from '@deepseek-ai/dsh-bid'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { seedConversation, seedProjectArtifacts } from '../../../packages/bid/bid/tests/fixtures/project-session.ts'
import { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/bid-branch-summary', import.meta.url))

it('父章节和嵌套父章节显示概述，刷新保留选择，叶章节继续显示正文及依据', async () => {
  const scaffold = await launchWebScaffold({
    agentPresets: {
      roots: [{ path: fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url)), trust: 'system' }],
      default: 'standard',
    },
  })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const errors = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: '标准模式' }).click()
    await page.getByRole('menuitem', { name: /标书模式/ }).click()
    await page.getByRole('region', { name: '技术标生成' }).waitFor()
    const agent = scaffold.ctx.agents.list().find(candidate => resolveSessionPreset(candidate.session) === 'bid')
    if (agent === undefined) throw new Error('缺少标书会话')
    seedConversation(agent.session)
    const workspace = new BidWorkspace(join(scaffold.workspaceCwd, 'workspace'))
    const outline = await seedProjectArtifacts(workspace)
    const leaf = outline.sections[0]!
    const branch = {
      ...leaf, writable: false, must_answer: [], requirement_ids: [], scoring_ids: [],
      scoring_response_point_ids: [], scoring_response_points: [],
    }
    const rootSummary = '本章介绍项目实施的总体安排，涵盖工作方案及技术交付内容，帮助读者了解各项任务之间的关系。'
    const nestedSummary = '本节说明技术方案的设计与交付安排，重点介绍实施方法和按期交付要求。'
    outline.sections = [
      { ...branch, id: 'SEC-ROOT', parent_id: null, level: 1, title: '项目实施方案', summary: rootSummary },
      { ...branch, id: 'SEC-WORK', parent_id: 'SEC-ROOT', level: 2, title: '工作方案', summary: nestedSummary },
      { ...leaf, parent_id: 'SEC-WORK', level: 3 },
    ]
    for (const path of ['outline/outline.json', 'outline/confirmed-outline.json']) {
      await writeFile(join(workspace.projectRoot, path), `${JSON.stringify(outline)}\n`)
    }
    for (const path of ['chapters/execution-log.json', 'chapters/manifest.json']) {
      const absolute = join(workspace.projectRoot, path)
      const artifact = JSON.parse(await readFile(absolute, 'utf8')) as { confirmed_outline_sha256: string }
      artifact.confirmed_outline_sha256 = outlineArtifactSha256(outline)
      await writeFile(absolute, `${JSON.stringify(artifact)}\n`)
    }
    const state = await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed' })
    agent.session.append('bid.project.resumed', { revision: state.revision, runtime: state.runtime })
    await scaffold.ctx.sessions.flush(agent.session)

    const reader = page.getByRole('main', { name: '正文阅读' })
    const navigation = page.getByRole('navigation', { name: '章节目录' })
    const references = page.getByRole('complementary', { name: '参考资料与审查' })
    await reader.getByText('已有正文。', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await navigation.getByRole('button', { name: '1 项目实施方案', exact: true }).isEnabled()).toBe(true)
    expect(await navigation.getByTitle('1 项目实施方案：章节概述', { exact: true }).count()).toBe(1)
    await navigation.getByRole('button', { name: '1 项目实施方案', exact: true }).click()
    await reader.getByText(rootSummary, { exact: true }).waitFor()
    expect(await references.getByText('无明确对应条款', { exact: true }).count()).toBe(0)
    expect(await references.getByText('无明确对应评分点', { exact: true }).count()).toBe(0)
    expect(await references.getByText('佐证支撑状态 (Evidence)', { exact: true }).count()).toBe(0)
    const rootSnapshot = await captureStableAria(page, '[role="main"][aria-label="正文阅读"]', scaffold.workspaceCwd)

    await navigation.getByRole('button', { name: '1.1 工作方案', exact: true }).click()
    await reader.getByText(nestedSummary, { exact: true }).waitFor()
    const refreshedChapter = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bid/getReviewChapter')
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await refreshedChapter
    await expect.poll(() => reader.innerText()).toContain(nestedSummary)
    const nestedSnapshot = await captureStableAria(page, '[role="main"][aria-label="正文阅读"]', scaffold.workspaceCwd)
    const referencesSnapshot = await captureStableAria(page, '[role="complementary"][aria-label="参考资料与审查"]', scaffold.workspaceCwd)
    const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'bid-branch-summary.png'), fullPage: true })

    await navigation.getByRole('button', { name: '1.1.1 技术方案', exact: true }).click()
    await reader.getByText('已有正文。', { exact: true }).waitFor()
    expect(await references.getByText('REQ-1', { exact: true }).count()).toBe(1)
    expect(await references.getByText('RP-000001', { exact: true }).count()).toBe(1)
    const leafSnapshot = await captureStableAria(page, '[role="main"][aria-label="正文阅读"]', scaffold.workspaceCwd)
    if (scaffold.mode === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'reader.expected.md'), [
      '## 父章节', rootSnapshot, '## 嵌套父章节', nestedSnapshot,
      '## 父章节参考资料区', referencesSnapshot, '## 叶章节', leafSnapshot,
    ].join('\n\n'), scaffold.mode)
    await assertFixtureInventory(SNAPSHOT_DIR, ['reader.expected.md'])
    expect(errors.pageErrors).toEqual([])
    expect(errors.warnings).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
