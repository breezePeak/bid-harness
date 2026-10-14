import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { docxAssetHash } from '../src/docx-render.ts'
import { DOCX_MAX_BODY_IMAGE_BYTES } from '../src/docx-image.ts'
import { chapterImageFixturePng } from './fixtures/chapter-image-png.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-docx-images-'))
  roots.push(root)
  const workspace = new BidWorkspace(root)
  await fs.mkdir(join(workspace.projectRoot, 'chapters/images'), { recursive: true })
  const png = await chapterImageFixturePng()
  const hash = createHash('sha256').update(png).digest('hex')
  const path = `chapters/images/${hash}.png`
  await fs.writeFile(join(workspace.projectRoot, path), png)
  return { workspace, png, path }
}

describe('Word 实际读取的生成图片', () => {
  it('接受内容摘要一致的图，并对引用式路径使用同一校验', async () => {
    const { workspace, path } = await fixture()
    const direct = await docxAssetHash(workspace, `![方案](${path})`)
    expect(await docxAssetHash(workspace, `![方案][image]\n\n[image]: ${path}`)).toBe(direct)
    expect(await docxAssetHash(workspace, `![方案](./${path})`)).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('实际读取时拒绝被替换的生成图片', async () => {
    const { workspace, png, path } = await fixture()
    await fs.writeFile(join(workspace.projectRoot, path), Buffer.concat([png, Buffer.from('changed')]))
    await expect(docxAssetHash(workspace, `![方案](${path})`)).rejects.toThrow('BID_IMAGE_CONTENT_CHANGED')
    await expect(docxAssetHash(workspace, `![方案](${path.replace('/images/', '/%69mages/')})`)).rejects.toThrow('BID_IMAGE_CONTENT_CHANGED')
  })

  it('文件在 stat 后增大时仍按实际读取字节执行全书限制', async () => {
    const { workspace } = await fixture()
    const path = join(workspace.projectRoot, 'large.png')
    await fs.writeFile(path, Buffer.alloc(DOCX_MAX_BODY_IMAGE_BYTES + 1))
    const declared = await fs.stat(path)
    declared.size = 1
    vi.mocked(fs.stat).mockResolvedValueOnce(declared)
    await expect(docxAssetHash(workspace, '![方案](large.png)')).rejects.toThrow('总大小不能超过 20 MiB')
  })
})
