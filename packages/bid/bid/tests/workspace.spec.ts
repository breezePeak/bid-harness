import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BidWorkspace, safeFileName, within } from '../src/index.ts'

describe('BidWorkspace', () => {
  it('keeps imports isolated, parses UTF-8, and only exposes relative inventory paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bid-'))
    const bid = new BidWorkspace(root, 'session_1')
    const [file] = await bid.import([{ name: '公司资料.txt', type: 'text/plain', bytes: new TextEncoder().encode('企业资料') }])
    expect(file.parseStatus).toBe('success')
    expect(await readFile(file.absoluteParsedPath!, 'utf8')).toBe('企业资料')
    await expect(bid.messageInventory('编写技术标')).resolves.toContain('.bid-harness/sessions/session_1/input/公司资料.txt')
  })

  it('rejects traversal, reserved names, unsupported files, and empty files', async () => {
    expect(() => safeFileName('../x.pdf')).toThrow('bid-invalid-file-name')
    expect(() => safeFileName('CON.txt')).toThrow('bid-reserved-file-name')
    expect(() => within('C:\\workspace', '../secret')).toThrow('bid-path-traversal')
    const bid = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-bid-')), 'session_2')
    await expect(bid.import([{ name: 'x.exe', bytes: new Uint8Array([1]) }])).rejects.toThrow('bid-unsupported-file-type')
    await expect(bid.import([{ name: 'x.txt', bytes: new Uint8Array() }])).rejects.toThrow('bid-empty-file')
  })
})
