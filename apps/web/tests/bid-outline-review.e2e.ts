/** Real browser and Host draft persistence with deterministic S3/S4 stage artifacts. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { BidWorkspace, checkpointBidProjectState, createScoringResponsePointCatalog, type OutlineArtifact } from '@deepseek-ai/dsh-bid'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'
import { seedProjectArtifacts } from '../../../packages/bid/bid/tests/fixtures/project-session.ts'

async function dragSection(page: Page, title: string, target: string): Promise<void> {
  const originalTitles = await page.getByLabel('技术标目录', { exact: true }).locator('input').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value))
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
  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2)
  expect(await page.getByLabel('技术标目录', { exact: true }).locator('input').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value))).toEqual(originalTitles)
  expect(await destination.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  await expect.poll(async () => destination.evaluate(element => getComputedStyle(element, '::after').borderBottomWidth)).toBe('2px')
  await saveFailureShot(page, 'bid-outline-review-drag')
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2)
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
    await seedProjectArtifacts(workspace)
    const publish = async (runtime: Parameters<typeof checkpointBidProjectState>[1]) => {
      const state = await checkpointBidProjectState(workspace, runtime)
      agent.session.append('bid.project.resumed', { revision: state.revision, runtime })
    }
    await publish({ stage: 'tender_analysis', status: 'waiting_user' })
    await page.getByRole('tab', { name: '招标详情', exact: true }).waitFor()
    const tenderConfirmation = page.getByRole('region', { name: '招标详情', exact: true }).getByRole('button', { name: '确认技术标分析', exact: true })
    await tenderConfirmation.waitFor()
    const tenderButtonBox = await tenderConfirmation.boundingBox()
    expect(tenderButtonBox).not.toBeNull()
    expect(await page.getByRole('region', { name: '技术标生成' }).getByRole('button', { name: '确认技术标分析', exact: true }).count()).toBe(0)
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
        section('REMOVED', '原附录', null, 3),
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
    expect(await page.getByRole('tab', { name: '招标详情', exact: true }).count()).toBe(1)
    expect(await page.getByRole('tab', { name: '目录详情', exact: true }).count()).toBe(0)
    expect(await page.getByRole('tab', { name: '审核项', exact: true }).count()).toBe(1)
    const outlineButtonBox = await page.getByRole('region', { name: '审核项', exact: true }).getByRole('button', { name: '使用该目录', exact: true }).boundingBox()
    expect(outlineButtonBox).not.toBeNull()
    expect(Math.abs(outlineButtonBox!.y - tenderButtonBox!.y)).toBeLessThan(35)
    expect(outlineButtonBox!.x).toBeGreaterThan(1000)
    const dock = page.getByRole('region', { name: '技术标生成' })
    expect(await dock.getByRole('button', { name: '使用该目录', exact: true }).count()).toBe(0)
    expect(await dock.getByLabel('修改目录', { exact: true }).count()).toBe(0)
    await saveFailureShot(page, 'bid-outline-review-before')
    await dragSection(page, '交付验收', 'A before')
    await expect.poll(async () => (JSON.parse(await readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8')) as { outline: OutlineArtifact }).outline.sections.find(item => item.id === 'B')?.order).toBe(1)
    const confirmed = (await scaffold.ctx.bid.getOutlineDraft(agent.session)).outline
    await writeFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), JSON.stringify(confirmed))
    await writeFile(join(workspace.projectRoot, 'outline/outline.json'), JSON.stringify({
      ...confirmed, sections: [...confirmed.sections.filter(item => item.id !== 'REMOVED'), section('NEW', '运维保障', null, 3),
        ...Array.from({ length: 20 }, (_, index) => section(`EXTRA-${index}`, `补充章节 ${index + 1}`, null, index + 4))],
    }))
    await publish({ stage: 'evidence_mapping', status: 'running' })
    await page.getByRole('tab', { name: '目录详情', exact: true }).click()
    await page.getByLabel('B 标题', { exact: true }).waitFor()
    expect(await page.getByLabel('NEW 标题', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('tab', { name: '审核项', exact: true }).count()).toBe(0)
    const evidence = { schema_version: 10, section_mappings: [{
      section_id: 'B', local_materials: [], web_materials: [], missing_topics: ['验收清单'], writing_dimensions: ['验收标准'],
    }] }
    await writeFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), JSON.stringify(evidence))
    await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_user' })
    await scaffold.ctx.bid.getOutlineDraft(agent.session)
    await page.getByText('S4 · 深化目录与材料审核', { exact: true }).waitFor()
    await page.getByText('S3 已确认目录 · 只读', { exact: true }).waitFor()
    await page.getByLabel('EXTRA-19 标题', { exact: true }).waitFor()
    await dragSection(page, '交付验收', 'A inside')
    await expect.poll(async () => (JSON.parse(await readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8')) as { outline: OutlineArtifact }).outline.sections.find(item => item.id === 'B')?.parent_id).toBe('A')
    await page.getByLabel('B 标题', { exact: true }).locator('..').click()
    await page.getByLabel('当前章节详情').getByText('验收标准', { exact: true }).waitFor()
    expect(await page.getByLabel('S3 已确认目录').locator('[draggable="true"]').count()).toBe(0)
    expect(await page.getByLabel('S3 已确认目录').locator('[aria-current="true"]').textContent()).toContain('交付验收')
    expect(await page.getByLabel('A 标题', { exact: true }).count()).toBe(1)
    const left = page.getByLabel('S3 已确认目录', { exact: true })
    const right = page.getByLabel('技术标目录', { exact: true })
    const outerScroll = page.locator('[data-conversation-scroll]')
    const outerTop = await outerScroll.evaluate(element => element.scrollTop)
    await right.getByRole('button', { name: '折叠 技术方案', exact: true }).click()
    expect(await right.getByLabel('B 标题', { exact: true }).count()).toBe(0)
    await left.getByRole('button', { name: '交付验收', exact: true }).click()
    await right.getByLabel('B 标题', { exact: true }).waitFor()
    expect(await right.locator('[aria-current="true"]').getAttribute('data-section-id')).toBe('B')
    const selectedRow = right.locator('[aria-current="true"]')
    const selectedBorder = await selectedRow.evaluate(element => getComputedStyle(element).borderLeftColor)
    expect(await left.locator('[aria-current="true"]').evaluate(element => getComputedStyle(element).borderLeftColor)).toBe(selectedBorder)
    await selectedRow.hover()
    expect(await selectedRow.evaluate(element => getComputedStyle(element).borderLeftColor)).toBe(selectedBorder)
    expect(await selectedRow.evaluate(element => getComputedStyle(element).borderLeftWidth)).toBe('2px')
    await page.getByRole('heading', { name: 'S4 当前目录', exact: true }).hover()
    expect(await selectedRow.evaluate(element => getComputedStyle(element).borderLeftColor)).toBe(selectedBorder)
    await right.getByLabel('B 标题', { exact: true }).focus()
    await right.getByRole('button', { name: '编辑 交付验收', exact: true }).focus()
    expect(await selectedRow.evaluate(element => getComputedStyle(element).borderLeftColor)).toBe(selectedBorder)
    await left.getByRole('button', { name: '原附录', exact: true }).click()
    expect(await right.locator('[aria-current="true"]').count()).toBe(0)
    expect(await page.getByLabel('REMOVED 目的', { exact: true }).evaluate(element => (element as HTMLTextAreaElement).readOnly)).toBe(true)
    await right.getByLabel('EXTRA-19 标题', { exact: true }).locator('..').click()
    expect(await left.locator('[aria-current="true"]').count()).toBe(0)
    await page.getByText('S3 中无对应章节', { exact: true }).waitFor()
    await left.getByRole('button', { name: '交付验收', exact: true }).click()
    const linkedBounds = await right.locator('[data-section-id="B"]').evaluate((element) => {
      const row = element.getBoundingClientRect()
      const container = element.parentElement!.getBoundingClientRect()
      return { top: row.top, bottom: row.bottom, containerTop: container.top, containerBottom: container.bottom }
    })
    expect(linkedBounds.top).toBeGreaterThanOrEqual(linkedBounds.containerTop)
    expect(linkedBounds.bottom).toBeLessThanOrEqual(linkedBounds.containerBottom)
    expect(linkedBounds.containerBottom).toBeLessThanOrEqual((await dock.boundingBox())!.y)
    expect(await outerScroll.evaluate(element => element.scrollTop)).toBe(outerTop)
    const linkedScrollTop = await right.locator('[data-section-id="B"]').evaluate(element => element.parentElement!.scrollTop)
    await left.getByRole('button', { name: '交付验收', exact: true }).click()
    expect(await right.locator('[data-section-id="B"]').evaluate(element => element.parentElement!.scrollTop)).toBe(linkedScrollTop)
    expect(await page.getByLabel('本章变化').innerText()).toMatchInlineSnapshot(`
      "本章变化
      ↕ 结构调整

      1 交付验收 → 1.1 技术方案 / 交付验收"
    `)
    await saveFailureShot(page, 'bid-outline-review-s4')
    await page.reload()
    await page.getByText('S3 已确认目录 · 只读', { exact: true }).waitFor()
    await expect.poll(async () => page.getByLabel('B 章节编号', { exact: true }).textContent()).toBe('1.1')
    await page.getByLabel('NEW 标题', { exact: true }).locator('..').hover()
    await page.getByRole('button', { name: '编辑 运维保障', exact: true }).click()
    await page.getByLabel('NEW 标题', { exact: true }).fill('运维服务')
    await page.getByLabel('当前章节详情').getByRole('heading').first().click()
    await expect.poll(async () => (JSON.parse(await readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8')) as { outline: OutlineArtifact }).outline.sections.find(item => item.id === 'NEW')?.title).toBe('运维服务')
    await page.getByLabel('NEW 标题', { exact: true }).locator('..').hover()
    await page.getByRole('button', { name: '删除 运维服务', exact: true }).click()
    await expect.poll(async () => (JSON.parse(await readFile(join(workspace.projectRoot, 'outline/draft.json'), 'utf8')) as { outline: OutlineArtifact }).outline.sections.some(item => item.id === 'NEW')).toBe(false)
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'outline/initial-confirmed-outline.json'), 'utf8'))).toEqual(confirmed)
    expect(JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/evidence-map.json'), 'utf8'))).toEqual(evidence)
    const finalOutline = (await scaffold.ctx.bid.getOutlineDraft(agent.session)).outline
    await writeFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), JSON.stringify(finalOutline))
    await publish({ stage: 'chapter_writing', status: 'running' })
    await page.getByRole('tab', { name: '目录详情', exact: true }).click()
    await page.getByText('最终目录已确认 / 只读', { exact: true }).waitFor()
    await page.getByRole('heading', { name: 'S4 最终确认目录', exact: true }).waitFor()
    await left.getByRole('button', { name: '交付验收', exact: true }).click()
    expect(await right.locator('[aria-current="true"]').getAttribute('data-section-id')).toBe('B')
    await page.getByLabel('当前章节详情').getByText('验收标准', { exact: true }).waitFor()
    expect(await page.getByLabel('目录差异汇总').textContent()).toContain('结构调整')
    expect(await right.locator('[draggable="true"]').count()).toBe(0)
    await page.getByRole('tab', { name: '正文详情', exact: true }).click()
    await page.getByText('已有正文。', { exact: true }).waitFor()
    await writeFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), '# 章节更新\n\n实时更新的正文。\n')
    await page.getByText('实时更新的正文。', { exact: true }).waitFor()
    await publish({ stage: 'docx_export', status: 'completed' })
    await page.reload()
    for (const label of ['招标详情', '目录详情', '正文详情']) {
      await page.getByRole('tab', { name: label, exact: true }).waitFor()
    }
    await page.getByRole('tab', { name: '招标详情', exact: true }).click()
    await page.getByRole('region', { name: '招标详情', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '确认技术标分析', exact: true }).count()).toBe(0)
    await page.getByRole('tab', { name: '目录详情', exact: true }).click()
    await page.getByText('最终目录已确认 / 只读', { exact: true }).waitFor()
    await left.getByRole('button', { name: '交付验收', exact: true }).click()
    await page.getByLabel('当前章节详情').getByText('验收标准', { exact: true }).waitFor()
    await page.getByLabel('B 标题', { exact: true }).waitFor()
    expect(await page.getByLabel('B 标题', { exact: true }).evaluate(element => (element as HTMLInputElement).readOnly)).toBe(true)
    expect(await page.getByRole('button', { name: '使用该目录', exact: true }).count()).toBe(0)
    await page.getByRole('tab', { name: '正文详情', exact: true }).click()
    await page.getByText('实时更新的正文。', { exact: true }).waitFor()
    await saveFailureShot(page, 'bid-details-final')
  } catch (error) {
    await saveFailureShot(page, 'bid-outline-review-failure')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
  }
})

it('S4 经真实确认进入 S5 后，BidDetails 从持久化最终版本恢复三列及关联内容', async () => {
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
    const workspace = new BidWorkspace(agent.session.header.cwd)
    const outline = await seedProjectArtifacts(workspace)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '确认最终技术标目录' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const baseline = { ...outline, sections: outline.sections.map(section => ({ ...section, title: 'S3 技术方案', must_answer: ['初步交付要求'] })) }
    const finalOutline = { ...outline, sections: outline.sections.map(section => ({ ...section, title: 'S4 技术方案', must_answer: ['明确交付核验流程'] })) }
    for (const [path, value] of Object.entries({
      'outline/initial-confirmed-outline.json': baseline,
      'outline/outline.json': finalOutline,
      'outline/quality-report.json': { schema_version: 3, scope: 'technical_bid', checked_requirement_ids: ['REQ-1'], checked_scoring_ids: ['SCORE-1'], checked_scoring_response_point_ids: ['RP-000001'], reviewed_section_ids: ['SEC-1'], issues: [] },
      'analysis/web-evidence-sources.json': { schema_version: 2, stage: 'evidence_mapping', sources: [] },
    })) await writeFile(join(workspace.projectRoot, path), JSON.stringify(value))
    await rm(join(workspace.projectRoot, 'outline/confirmed-outline.json'))
    const state = await checkpointBidProjectState(workspace, { stage: 'evidence_mapping', status: 'waiting_user' })
    agent.session.append('bid.project.resumed', { revision: state.revision, runtime: state.runtime })
    await page.getByRole('tab', { name: '目录详情', exact: true }).click()
    await page.getByText('S4 · 深化目录与材料审核', { exact: true }).waitFor()
    await page.getByRole('button', { name: '使用该目录', exact: true }).click()
    await expect.poll(() => agent.session.events.some(event => event.type === 'bid.user_confirmation.received' && event.data.stage === 'evidence_mapping')).toBe(true)
    await expect.poll(async () => JSON.parse(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')) as unknown).toEqual(finalOutline)
    await expect.poll(async () => (await scaffold.ctx.bid.getDetails(agent.session)).outlinePresentation?.source).toBe('final_confirmed')
    await page.getByRole('tab', { name: '正文详情', exact: true }).waitFor()
    await page.getByRole('tab', { name: '目录详情', exact: true }).click()
    await page.getByText('最终目录已确认 / 只读', { exact: true }).waitFor()
    const assertDetails = async () => {
      await page.getByRole('tab', { name: '目录详情', exact: true }).click()
      const left = page.getByLabel('S3 已确认目录', { exact: true })
      const right = page.getByLabel('技术标目录', { exact: true })
      await left.getByRole('button', { name: 'S3 技术方案', exact: true }).waitFor()
      expect(await right.getByLabel('SEC-1 标题', { exact: true }).inputValue()).toBe('S4 技术方案')
      await page.getByRole('heading', { name: 'S4 最终确认目录', exact: true }).waitFor()
      await page.getByText('最终目录已确认 / 只读', { exact: true }).waitFor()
      expect(await page.getByLabel('目录差异汇总').textContent()).toContain('编写要求更新 1')
      expect(await page.getByLabel('本章变化').textContent()).toContain('明确交付核验流程')
      expect(await page.getByLabel('当前章节详情').textContent()).toContain('待补充实施材料')
      expect(await page.getByRole('button', { name: /使用该目录|编辑 S4|删除 S4|拖动 S4/ }).count()).toBe(0)
      expect(await right.locator('[draggable="true"]').count()).toBe(0)
    }
    await assertDetails()
    await page.getByRole('tab', { name: '正文详情', exact: true }).waitFor()
    await page.getByRole('tab', { name: '招标详情', exact: true }).click()
    await assertDetails()
    await page.reload()
    await assertDetails()
    const callsBefore = agent.session.events.filter(event => event.type === 'tool/call').length
    await scaffold.ctx.bid.getDetails(agent.session)
    expect(agent.session.events.filter(event => event.type === 'tool/call')).toHaveLength(callsBefore)
  } catch (error) {
    await saveFailureShot(page, 'bid-confirmation-details-failure')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
  }
})
