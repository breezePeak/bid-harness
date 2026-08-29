import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
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

    const entry = await readFile(`${BID_PACKAGE}src/control-plane.ts`, 'utf8')
    const contract = await readFile(`${BID_PACKAGE}src/control-plane-contract.ts`, 'utf8')
    expect(entry.match(/from ['"]([^'"]+)['"]/g)).toEqual([
      "from './control-plane-contract.ts'",
      "from './control-plane-contract.ts'",
    ])
    expect(contract).not.toMatch(/from ['"]|node:|\b(?:docx|xlsx|mammoth|pdfjs-dist)\b/)
  })
})
