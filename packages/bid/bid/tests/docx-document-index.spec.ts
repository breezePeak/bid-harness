/** 原稿索引从真实 ZIP/XML 绑定重复文字、表格与分节，拒绝旧版本锚点。 */
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { expect, it } from 'vitest'
import { promptFileRefSchema } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import { indexDocxDocument, resolveDocxBlock } from '../src/docx-document-index.ts'
import { readDocxXml } from '../src/docx-template.ts'

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

async function document() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一部分</w:t></w:r></w:p>
    <w:p><w:r><w:t>相同段落</w:t></w:r></w:p>
    <w:p><w:pPr><w:sectPr><w:pgSz w:w="12000" w:h="16000"/><w:pgMar w:left="1000" w:right="1000"/><w:cols w:num="2" w:space="600"/></w:sectPr></w:pPr></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第二部分</w:t></w:r></w:p>
    <w:p><w:r><w:t>相同段落</w:t></w:r></w:p>
    <w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="5000"/></w:tblGrid><w:tr>
      <w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>相同段落</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>SEQ 图</w:instrText><w:t>图 1</w:t></w:r></w:p></w:tc>
    </w:tr></w:tbl>
    <w:sectPr><w:pgSz w:w="12000" w:h="16000"/><w:pgMar w:left="2000" w:right="2000"/></w:sectPr>
  </w:body></w:document>`)
  zip.file('word/header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>相同段落</w:t></w:r></w:p></w:hdr>')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  return { bytes, ref: promptFileRefSchema.parse({ attachmentId: `file:${hash('索引测试原件')}`, version: hash(bytes) }) }
}

it('相同文字按版本和节点唯一定位，区分标题、单元格、双栏及只读页眉', async () => {
  const { bytes, ref } = await document()
  const index = await indexDocxDocument(bytes, ref)
  const repeated = index.blocks.filter(block => block.kind === 'paragraph' && block.text === '相同段落')
  expect(repeated).toHaveLength(4)
  expect(new Set(repeated.map(block => JSON.stringify([block.ref.part, block.ref.node_path]))).size).toBe(4)
  expect(repeated.slice(0, 3).map(block => block.heading_path)).toEqual([['第一部分'], ['第二部分'], ['第二部分']])
  expect(repeated.map(block => block.available_width_twips)).toEqual([4700, 8000, 2784, null])
  expect(repeated[2]?.location).toContain('表格单元格')
  expect(repeated[3]).toMatchObject({ writable: false, ref: { part: 'word/header1.xml' } })
  expect(index.blocks.find(block => block.kind === 'paragraph' && block.text === '图 1')?.limitations.join()).toContain('复杂字段')
  const parts = await readDocxXml(bytes)
  const anchor = repeated[1]!.ref
  const resolved = resolveDocxBlock(parts[anchor.part]!, anchor)
  resolved.node.attributes = { 'w:rsidR': 'changed' }
  expect(() => resolveDocxBlock(parts[anchor.part]!, anchor)).toThrow('BID_DOCX_BLOCK_CHANGED')
  await expect(indexDocxDocument(bytes, { ...ref, version: hash('another-version') })).rejects.toThrow('BID_DOCX_VERSION_CHANGED')
})
