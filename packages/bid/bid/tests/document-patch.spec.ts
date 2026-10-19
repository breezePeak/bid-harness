/** 原 Word 补丁保留复杂原稿，精确绑定重复段落与共享图片实例。 */
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { expect, it } from 'vitest'
import { patchDocxDocument } from '../src/document-patch.ts'
import { docxAttribute, docxDescendants, docxNodeText } from '../src/docx-document-index.ts'
import { readDocxXml } from '../src/docx-template.ts'
import { nativeDocumentFixture, assertNativeDocumentPreserved } from './fixtures/native-document.ts'
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

it('原稿保留核对接受新增配图，拒绝原段落丢失和页眉字节变化', async () => {
  const f = await nativeDocumentFixture()
  const patched = await patchDocxDocument(f.bytes, f.ref, [{ type: 'insert_figure', block_ref: f.select('维护记录：检查设备状态，确认通道畅通，记录本次检查结果。'),
    placement: 'after', image: f.png, title: '维护流程', caption: '维护流程' }])
  expect(await assertNativeDocumentPreserved(f.bytes, patched.bytes)).toContain('word/header1.xml')
  const removed = await patchDocxDocument(f.bytes, f.ref, [{ type: 'delete_object', block_ref: f.select('允许删除') }])
  await expect(assertNativeDocumentPreserved(f.bytes, removed.bytes)).rejects.toThrow('原正文节点被删除、修改或重排')
  const zip = await JSZip.loadAsync(patched.bytes)
  zip.file('word/header1.xml', (await zip.file('word/header1.xml')!.async('string')).replace('原页眉', '被改动'))
  await expect(assertNativeDocumentPreserved(f.bytes, await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('原 ZIP 部件被修改')
})

it('一次补丁先定位所有锚点，重复原文、表格、分节及原有复杂内容均保留', async () => {
  const f = await nativeDocumentFixture()
  const result = await patchDocxDocument(f.bytes, f.ref, [
    { type: 'insert_figure', block_ref: f.select('重复原文'), placement: 'after', image: f.png, title: '流程', caption: '图 99 流程图' },
    { type: 'insert_figure', block_ref: f.select('表格段落'), placement: 'after', image: f.png, title: '单元格图', caption: '单元格图' },
    { type: 'replace_block_text', block_ref: f.select('重复原文', 1), text: '只修改第二处' },
    { type: 'insert_paragraph', block_ref: f.select('跨页检查位置'), placement: 'before', text: '新增普通段落' },
    { type: 'delete_object', block_ref: f.select('允许删除') },
  ])
  const output = await readDocxXml(result.bytes)
  const paragraphs = docxDescendants(output['word/document.xml']!, 'p').map(docxNodeText)
  expect(paragraphs.filter(text => text === '重复原文')).toHaveLength(1)
  expect(paragraphs).toContain('只修改第二处')
  expect(paragraphs).toContain('新增普通段落')
  expect(paragraphs).not.toContain('允许删除')
  expect(paragraphs).toContain('保留书签保留链接')
  const beforeZip = await JSZip.loadAsync(f.bytes)
  const afterZip = await JSZip.loadAsync(result.bytes)
  for (const path of ['word/header1.xml', 'word/footer1.xml', 'word/styles.xml', 'word/settings.xml']) {
    expect(await afterZip.file(path)!.async('string')).toBe(await beforeZip.file(path)!.async('string'))
  }
  expect(docxDescendants(output['word/document.xml']!, 'sectPr')).toHaveLength(2)
  const ids = docxDescendants(output['word/document.xml']!, 'docPr').map(node => docxAttribute(node, 'id'))
  expect(new Set(ids).size).toBe(ids.length)
  const cell = docxDescendants(output['word/document.xml']!, 'tc')[0]!
  const extent = docxDescendants(cell, 'extent')[0]!
  expect(Number(docxAttribute(extent, 'cx'))).toBeLessThanOrEqual(2784 * 635)
  expect(result.changes).toHaveLength(5)
  expect(result.anchors.filter(anchor => anchor.kind === 'inserted').length).toBeGreaterThan(4)
  expect(paragraphs.filter(text => /^图 \d/u.test(text))).toEqual(['图 1 流程图', '图 2 原题注', '图 3 单元格图'])
  expect(paragraphs).toContain('图 2 原题注')
  expect(hash(f.bytes)).toBe(f.ref.version)
})

it('替换共享媒体中的一个图片实例，不覆盖原媒体和其他图片的关系', async () => {
  const f = await nativeDocumentFixture()
  const sharp = (await import('sharp')).default
  const next = await sharp({ create: { width: 360, height: 200, channels: 3, background: '#a33b22' } }).png().toBuffer()
  const images = f.index.blocks.filter(block => block.kind === 'image')
  const before = await readDocxXml(f.bytes)
  const originalRefs = docxDescendants(before['word/document.xml']!, 'blip').map(node => docxAttribute(node, 'embed'))
  expect(new Set(originalRefs).size).toBe(1)
  const result = await patchDocxDocument(f.bytes, f.ref, [{ type: 'replace_figure', block_ref: images[1]!.ref, image: next, title: '替换第二图' }])
  const after = await readDocxXml(result.bytes)
  const refs = docxDescendants(after['word/document.xml']!, 'blip').map(node => docxAttribute(node, 'embed'))
  expect(refs[0]).toBe(originalRefs[0])
  expect(refs[1]).not.toBe(refs[0])
  const zip = await JSZip.loadAsync(result.bytes)
  expect((await Promise.all(Object.keys(zip.files).filter(path => path.startsWith('word/media/') && !zip.files[path]!.dir)
    .map(path => zip.file(path)!.async('nodebuffer')))).some(bytes => bytes.equals(f.png))).toBe(true)
})

it('拒绝错版本、重复破坏性锚点、复杂段落压平和页眉修改', async () => {
  const f = await nativeDocumentFixture()
  await expect(patchDocxDocument(f.bytes, { ...f.ref, version: hash('错误版本') }, [
    { type: 'delete_object', block_ref: f.select('允许删除') },
  ])).rejects.toThrow('BID_DOCX_VERSION_CHANGED')
  await expect(patchDocxDocument(f.bytes, f.ref, [
    { type: 'delete_object', block_ref: f.select('允许删除') },
    { type: 'replace_block_text', block_ref: f.select('允许删除'), text: '不能复用' },
  ])).rejects.toThrow('BID_DOCX_OPERATION_OVERLAP')
  await expect(patchDocxDocument(f.bytes, f.ref, [
    { type: 'replace_block_text', block_ref: f.select('保留书签保留链接'), text: '不能压平' },
  ])).rejects.toThrow('BID_DOCX_COMPLEX_TEXT_UNSUPPORTED')
  await expect(patchDocxDocument(f.bytes, f.ref, [
    { type: 'replace_block_text', block_ref: f.index.blocks.find(block => block.text === '原页眉')!.ref, text: '不能修改' },
  ])).rejects.toThrow('BID_DOCX_TARGET_VERSION_INVALID')
})
