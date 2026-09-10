import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultDocxFormatState, formatFields } from '../src/docx-format.ts'
import { readDocxFormat } from '../src/docx-format-store.ts'
import { clearPageEstimateCache, estimateReviewPages } from '../src/page-estimate.ts'
import type { BidWorkspace } from '../src/index.ts'

const defaults = { font: '宋体', bodySize: 24, headingSize: 32 }

async function workspace(): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'bid-page-estimate-'))
  return { root, projectRoot: root, config: defaults } as BidWorkspace
}

function values(overrides = {}) {
  return { ...defaultDocxFormatState(formatFields(defaults)).resolved, ...overrides }
}

describe('Word page estimate', () => {
  it('先汇总父节点和全文再取整，父节点包含自身概述及全部后代', async () => {
    const project = await workspace()
    const sections = [
      { section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: false, markdown: '父章节概述。' },
      { section_id: 'one', parent_id: 'root', number: '1.1', depth: 2, title: '一', writable: true, markdown: '甲。' },
      { section_id: 'two', parent_id: 'root', number: '1.2', depth: 2, title: '二', writable: true, markdown: '乙。' },
    ] as const
    const estimate = await estimateReviewPages(project, '技术标', sections, values())
    const root = estimate.sections.get('root')!
    const one = estimate.sections.get('one')!
    const two = estimate.sections.get('two')!
    expect(root.pages).toBeGreaterThan(one.pages + two.pages)
    expect(Math.ceil(estimate.total)).toBe(1)
    expect(Math.ceil(one.pages) + Math.ceil(two.pages)).toBe(2)
    expect(root.incomplete).toBe(false)
  })

  it('正文、格式或图片版本变化前复用缓存，变化后不复用旧快照', async () => {
    clearPageEstimateCache()
    const project = await workspace()
    const base = [{ section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: true, markdown: '已生成正文。' }] as const
    const initial = await readDocxFormat(project)
    const first = await estimateReviewPages(project, '技术标', base, initial.values)
    expect(await estimateReviewPages(project, '技术标', base, initial.values)).toBe(first)
    const revised = await estimateReviewPages(project, '技术标', [{ ...base[0], markdown: '修订后的正文。' }], values())
    const reformatted = await estimateReviewPages(project, '技术标', base, values({ 'body.size': 18 }))
    expect(revised).not.toBe(first)
    expect(reformatted).not.toBe(first)
  })

  it('较早估算完成后不覆盖较新的内容快照', async () => {
    clearPageEstimateCache()
    const project = await workspace()
    const old = estimateReviewPages(project, '技术标', [{ section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: true, markdown: '旧正文。' }], values())
    const current = await estimateReviewPages(project, '技术标', [{ section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: true, markdown: '新正文。' }], values())
    await old
    expect(await estimateReviewPages(project, '技术标', [{ section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: true, markdown: '新正文。' }], values())).toBe(current)
  })

  it('只统计已有正文，缺失叶节使父章节标记为仅统计已生成内容', async () => {
    const estimate = await estimateReviewPages(await workspace(), '技术标', [
      { section_id: 'root', parent_id: null, number: '1', depth: 1, title: '方案', writable: false, markdown: '概述。' },
      { section_id: 'ready', parent_id: 'root', number: '1.1', depth: 2, title: '已生成', writable: true, markdown: '正文。' },
      { section_id: 'pending', parent_id: 'root', number: '1.2', depth: 2, title: '待生成', writable: true, markdown: '' },
    ], values())
    expect(estimate.sections.get('root')).toMatchObject({ hasContent: true, incomplete: true })
    expect(estimate.total).toBeGreaterThan(0)
  })
})
