import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { BID_RUNTIME_PROJECTION_KEY } from '@deepseek-ai/dsh-bid/control-plane'
import { INLINE_SAFE } from '../../tsdown.client.ts'

const BID_PACKAGE = fileURLToPath(new URL('../../../bid/bid/', import.meta.url))

describe('ui-bid client bundle contract', () => {
  it('admits only the browser-safe Bid control-plane subpath', () => {
    expect(INLINE_SAFE.test('@deepseek-ai/dsh-bid/control-plane')).toBe(true)
    expect(INLINE_SAFE.test('@deepseek-ai/dsh-bid')).toBe(false)
    expect(INLINE_SAFE.test('@deepseek-ai/dsh-bid/invariant')).toBe(false)
    expect(BID_RUNTIME_PROJECTION_KEY).toBe('bid.runtime')
  })

  it('publishes the subpath from a Node-free source graph', async () => {
    const manifest = JSON.parse(await readFile(`${BID_PACKAGE}package.json`, 'utf8')) as {
      exports: Record<string, { types?: string; default?: string }>
    }
    expect(manifest.exports['./control-plane']).toEqual({
      types: './lib/types/control-plane.d.ts',
      default: './lib/types/control-plane.js',
    })

    const pending = [`${BID_PACKAGE}src/control-plane.ts`]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const path = pending.pop()!
      if (visited.has(path)) continue
      visited.add(path)
      const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest)
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
        if (ts.isImportDeclaration(statement) && statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue
        const module = statement.moduleSpecifier
        if (module === undefined || !ts.isStringLiteral(module)) continue
        expect(module.text).not.toMatch(/^node:|^(?:docx|xlsx|mammoth|pdfjs-dist)$/u)
        if (module.text.startsWith('.')) pending.push(resolve(dirname(path), module.text))
        else expect(module.text).toBe('zod')
      }
    }
  })
})
