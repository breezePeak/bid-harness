import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const injected = vi.hoisted(() => ({ suffix: '', remaining: 0 }))

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      if (injected.remaining > 0 && args[0].endsWith(injected.suffix)) {
        injected.remaining--
        throw Object.assign(new Error('injected publication crash'), { code: 'EPERM' })
      }
      return actual.writeFileAtomic(...args)
    },
  }
})

import { publishBidBatch, reconcileBidPublications } from '../src/publication-batch.ts'

afterEach(() => {
  injected.suffix = ''
  injected.remaining = 0
})

describe('Bid PublicationBatch', () => {
  it('丢弃没有 commit intent 的 prepared batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-publication-prepared-'))
    const projectRoot = join(root, '.bid-harness')
    const transaction = join(projectRoot, '.publications', 'prepared-only')
    await mkdir(join(transaction, 'staged'), { recursive: true })
    await writeFile(join(transaction, 'staged', '000001'), 'new')
    await writeFile(join(transaction, 'manifest.json'), '{}')

    await reconcileBidPublications(root, projectRoot)

    await expect(readFile(join(projectRoot, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(projectRoot, '.publications'))).toEqual([])
  })

  it('commit intent 后部分替换失败时保留恢复记录并前滚为完整新版本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-publication-intent-'))
    const projectRoot = join(root, '.bid-harness')
    await mkdir(projectRoot, { recursive: true })
    const first = join(projectRoot, 'first.json')
    const second = join(projectRoot, 'second.json')
    await writeFile(first, 'old-first')
    await writeFile(second, 'old-second')
    injected.suffix = 'second.json'
    injected.remaining = 1

    await expect(publishBidBatch(root, projectRoot, async (lease) => {
      await lease.writeText(first, 'new-first')
      await lease.writeText(second, 'new-second')
    })).rejects.toThrow('injected publication crash')

    expect(await readFile(first, 'utf8')).toBe('new-first')
    expect(await readFile(second, 'utf8')).toBe('old-second')
    expect((await readdir(join(projectRoot, '.publications'))).length).toBe(1)

    await reconcileBidPublications(root, projectRoot)

    expect(await Promise.all([first, second].map(path => readFile(path, 'utf8'))))
      .toEqual(['new-first', 'new-second'])
    expect(await readdir(join(projectRoot, '.publications'))).toEqual([])
  })

  it('staging 回调失败时不产生 commit intent 或 canonical 写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-publication-stage-'))
    const projectRoot = join(root, '.bid-harness')
    await mkdir(projectRoot, { recursive: true })
    const target = join(projectRoot, 'result.txt')

    await expect(publishBidBatch(root, projectRoot, async (lease) => {
      await lease.writeText(target, 'uncommitted')
      throw new Error('candidate rejected')
    })).rejects.toThrow('candidate rejected')

    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(projectRoot, '.publications'))).toEqual([])
  })
})
