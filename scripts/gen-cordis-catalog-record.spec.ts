/** Generated Cordis regions preserve surrounding prose and localize available Chinese links. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localizePageRegion, REGION_BEGIN, REGION_END, spliceRegion } from './gen-cordis-catalog.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('spliceRegion', () => {
  it('replaces exactly the cordis-surface region', () => {
    const doc = `# T\n\nprose\n\n${REGION_BEGIN}\nold\n${REGION_END}\ntail\n`
    expect(spliceRegion(doc, `${REGION_BEGIN}\nnew\n${REGION_END}`))
      .toBe(`# T\n\nprose\n\n${REGION_BEGIN}\nnew\n${REGION_END}\ntail\n`)
  })

  it('fails loud on a page carrying only some other generator\'s region', () => {
    // Another generator's markers satisfy the generic region grammar but must
    // never be overwritten by THIS generator's splice.
    const foreign = '# T\n\n<!-- BEGIN GENERATED other-surface (other-gen.ts) — do not edit between markers -->\ntheirs\n<!-- END GENERATED other-surface -->\n'
    expect(() => spliceRegion(foreign, `${REGION_BEGIN}\nnew\n${REGION_END}`))
      .toThrow('expected exactly 1 cordis-surface region, found 0 BEGIN/0 END')
  })

  it('fails loud on duplicate cordis-surface markers', () => {
    const doubled = `${REGION_BEGIN}\na\n${REGION_END}\n${REGION_BEGIN}\nb\n${REGION_END}\n`
    expect(() => spliceRegion(doubled, `${REGION_BEGIN}\nnew\n${REGION_END}`))
      .toThrow('found 2 BEGIN/2 END')
  })
})

describe('localizePageRegion', () => {
  it('changes links with an existing Chinese Markdown target for the Chinese generated region', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordis-region-locale-'))
    roots.push(root)
    mkdirSync(join(root, 'docs/subsystems'), { recursive: true })
    mkdirSync(join(root, 'packages'), { recursive: true })
    writeFileSync(join(root, 'docs/subsystems/target.md'), '# Target\n')
    writeFileSync(join(root, 'docs/subsystems/target.zh.md'), '# 目标\n')
    writeFileSync(join(root, 'docs/subsystems/excluded.md'), '# Excluded\n')
    writeFileSync(join(root, 'docs/subsystems/excluded.zh.md'), '# 排除\n')
    writeFileSync(join(root, 'packages/outside.md'), '# Outside\n')
    writeFileSync(join(root, 'packages/outside.zh.md'), '# 范围外\n')
    const region = `${REGION_BEGIN}\n[Target](target.md#api) [Excluded](excluded.md) [Outside](../../packages/outside.md)\n${REGION_END}`

    expect(localizePageRegion(region, 'docs/subsystems/page.md', root)).toBe(region)
    expect(localizePageRegion(region, 'docs/subsystems/page.zh.md', root)).toBe(
      `${REGION_BEGIN}\n[Target](target.zh.md#api) [Excluded](excluded.zh.md) [Outside](../../packages/outside.zh.md)\n${REGION_END}`,
    )
  })
})
