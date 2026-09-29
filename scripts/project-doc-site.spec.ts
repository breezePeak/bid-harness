/** 中文文档站的发布清单与投影回归。 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { docsPages, landingLink, localeCollections, orderedPages, sectionSpec, type DocsPage } from '../website/docs.ts'
import { llmsTxt, projectedPageContent, rewriteMarkdown } from './project-doc-site.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('中文文档站', () => {
  it('只发布存在的中文正文和中文路由', () => {
    const repo = resolve(import.meta.dirname, '..')
    expect(docsPages.length).toBeGreaterThan(70)
    expect(docsPages.every(page => page.locale === 'root' && page.contentLocale === 'zh-CN')).toBe(true)
    expect(docsPages.every(page => !page.route.startsWith('en/') && existsSync(join(repo, page.source)))).toBe(true)
    expect(new Set(docsPages.map(page => page.route)).size).toBe(docsPages.length)
  })

  it('导航与侧栏从中文发布清单生成', () => {
    expect(localeCollections.root).toEqual(['zh-guide', 'zh-develop', 'zh-reference'])
    expect(landingLink('root', 'zh-guide')).toBe('/guide/quickstart')
    expect(orderedPages('root', 'zh-guide')[0]?.section).toBe('入门')
    expect(sectionSpec('root', '执行与工具').collapsed).toBe(true)
  })

  it('把现有英文正文的路径别名指向中文页面', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'dsh-zh-site-'))
    roots.push(repoRoot)
    mkdirSync(join(repoRoot, 'docs'), { recursive: true })
    writeFileSync(join(repoRoot, 'docs/source.zh.md'), '[目标](target.md#api)\n')
    writeFileSync(join(repoRoot, 'docs/target.md'), '# Target\n')
    const pages: DocsPage[] = [{
      locale: 'root', contentLocale: 'zh-CN', source: 'docs/target.zh.md', sourceAliases: ['docs/target.md'],
      route: 'guide/target.md', label: '目标', sidebar: 'zh-guide', section: '入门', order: 1,
    }]
    expect(rewriteMarkdown('[目标](target.md#api)\n', {
      sourcePath: 'docs/source.zh.md', locale: 'root', route: 'guide/source.md', pages, repoRoot, repositoryRef: 'master',
    })).toBe('[目标](./target.md#api)\n')
  })

  it('投影时移除旧正文的语言切换行', () => {
    const page = docsPages.find(candidate => candidate.route === 'guide/providers.md')
    expect(page).toBeDefined()
    expect(projectedPageContent('# 配置\n\n[English](providers.md) | 中文\n\n正文。\n', page!))
      .toBe('# 配置\n\n正文。\n')
  })

  it('llms.txt 只列中文页面', () => {
    const index = llmsTxt({ base: '/', title: '文档', description: '中文文档' })
    expect(index).toContain('/guide/quickstart.md')
    expect(index).not.toContain('## English')
    expect(index).not.toContain('/en/')
  })
})
