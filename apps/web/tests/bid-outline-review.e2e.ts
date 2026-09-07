/** Real browser and Host draft persistence with deterministic S3/S4 stage artifacts. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { BidWorkspace, checkpointBidProjectState, createScoringResponsePointCatalog, type OutlineArtifact } from '@deepseek-ai/dsh-bid'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

async function dragSection(page: Page, title: string, target: string): Promise<void> {
  const source = await page.getByRole('button', { name: `拖动 ${title}`, exact: true }).boundingBox()
  if (source === null) throw new Error('Missing section drag handle')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(source.x + source.width / 2 + 15, source.y + source.height / 2 + 15, { steps: 5 })
  const destination = page.getByLabel(target, { exact: true })
  await destination.waitFor()
  const box = await destination.boundingBox()
  if (box === null) throw new Error('Missing outline drop target')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
}

it('S3/S4 真实目录拖拽保存、基线对比和刷新恢复', async () => {
  const scaffold = await launchWebScaffold({
    agentPresets: { roots: [{ path: fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url)), trust: 'system' }], default: 'standard' },
  })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  try {
    await page.goto(scaffold.baseUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: '标准模式' }).click()
    await page.getByRole('menuitem', { name: /标书模式/ }).click()
    await page.getByRole('region', { name: '技术标生成' }).waitFor()
    const agent = scaffold.ctx.agents.list().find(candidate => resolveSessionPreset(candidate.session) === 'bid')
    if (agent?.session.header.cwd === undefined) throw new Error('Missing Bid agent workspace')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '审核技术标目录' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const workspace = new BidWorkspace(agent.session.header.cwd)
    const section = (id: string, title: string, parent_id: string | null, order: number) => ({
      id, title, parent_id, order, level: parent_id === null ? 1 : 2, purpose: `${title}的交付安排`, writable: true,
      must_answer: [`${title}如何落地`], requirement_ids: [], scoring_ids: [], compliance_ids: [], origin: 'generated' as const,
      scoring_response_point_ids: [], scoring_response_points: [], suggested_tables: [], suggested_figures: [], writing_notes: [],
    })
    const outline: OutlineArtifact = {
      schema_version: 3, scope: 'technical_bid', document_title: '目录审核示例', global_compliance_ids: [],
      sections: [
        { ...section('A', '技术方案', null, 1), writable: false, must_answer: [], summary: '说明架构与实施安排。' },
        section('A1', '系统架构', 'A', 1), section('A2', '实施安排', 'A', 2), section('B', '交付验收', null, 2),
      ],
    }
    const scoring = { schema_version: 1 as const, scoring_items: [] }
    const artifacts: Record<string, unknown> = {
      'outline/outline.json': outline,
      'analysis/requirements.json': { schema_version: 1, requirements: [] },
      'analysis/scoring.json': scoring,
      'analysis/compliance.json': { schema_version: 1, compliance_items: [] },
      'analysis/scoring-response-points.json': createScoringResponsePointCatalog(scoring, { schema_version: 1, points: [] }),
    }
    for (const [path, value] of Object.entries(artifacts)) {
      await mkdir(join(workspace.projectRoot, path.split('/')[0]!), { recursive: true })
      await writeFile(join(workspace.projectRoot, path), JSON.stringify(value))
    }
    await checkpointBidProjectState(workspace, { stage: 'outline_generation', status: 'waiting_user' })
    await scaffold.ctx.bid.getOutlineDraft(agent.session)
    await page.getByText('S3 · 初步技术标目录审核', { exact: true }).waitFor()
    await saveFailureShot(page, 'bid-outline-review-before')
    await dragSection(page, '交付验收', 'A before')
    await expect.poll(async () => (JSON.parse(await readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8')) as { outline: OutlineArtifact }).outline.sections.find(item => item.id === 'B')?.order).toBe(1)
    const confirmed = (await scaffold.ctx.bid.getOutlineDraft(agent.session)).outline
    await writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), JSON.stringify(confirmed))
    await writeFile(join(workspace.projectRoot, 'outline/outline.json'), JSON.stringify({
      ...confirmed, sections: [...confirmed.sections, section('NEW', '运维保障', null, 3)],
    }))
    const evidence = { schema_version: 10, section_mappings: [{
      section_id: 'B', local_materials: [], web_materials: [], missing_topics: ['验收清单'], writing_dimensions: ['验收标准'],
    }] }
    await writeFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), JSON.stringify(evidence))
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_user' })
    await scaffold.ctx.bid.getOutlineDraft(agent.session)
    await page.getByText('S4 · 深化目录与材料审核', { exact: true }).waitFor()
    await page.getByText('S3 章节数量 4', { exact: true }).waitFor()
    await dragSection(page, '交付验收', 'A inside')
    await expect.poll(async () => (JSON.parse(await readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8')) as { outline: OutlineArtifact }).outline.sections.find(item => item.id === 'B')?.parent_id).toBe('A')
    await page.getByLabel('B 标题', { exact: true }).click()
    await page.getByLabel('当前章节详情').getByText('验收标准', { exact: true }).waitFor()
    expect(await page.getByLabel('S3 已确认目录').locator('[draggable="true"]').count()).toBe(0)
    expect(await page.getByLabel('S3 已确认目录').locator('[aria-current="true"]').textContent()).toContain('交付验收')
    await page.getByLabel('只看变化', { exact: true }).check()
    expect(await page.getByLabel('A 标题', { exact: true }).count()).toBe(1)
    await saveFailureShot(page, 'bid-outline-review-s4')
    await page.reload()
    await page.getByText('S3 章节数量 4', { exact: true }).waitFor()
    await expect.poll(async () => page.getByLabel('B 章节编号', { exact: true }).textContent()).toBe('1.3')
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), 'utf8'))).toEqual(confirmed)
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8'))).toEqual(evidence)
  } catch (error) {
    await saveFailureShot(page, 'bid-outline-review-failure')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
  }
})
