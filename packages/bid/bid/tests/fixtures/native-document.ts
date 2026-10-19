/** 含重复段落、表格、共享图片、题注、书签和分节的真实原稿。 */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { js2xml } from 'xml-js'
import { Document, Packer, Paragraph, TextRun, ImageRun, Header, Footer, Table, TableRow, TableCell, Bookmark, ExternalHyperlink, SimpleField } from 'docx'
import { promptFileRefSchema } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import { docxDescendants, indexDocxDocument, type DocxBlockRef } from '../../src/docx-document-index.ts'
import { readDocxXml } from '../../src/docx-template.ts'
import { renderFlowchartImage } from '../../src/flowchart-image.ts'
import { bindFlowchartModelInputs } from '../../src/flowchart.ts'
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
/** @returns 原 Word 字节、版本、对象索引和精确段落选择器。 */
export async function nativeDocumentFixture() {
  const [definition] = bindFlowchartModelInputs('original', [{ title: '设备检查', purpose: '原稿维护流程',
    nodes: [{ type: 'start', text: '设备' }, { type: 'process', text: '检查' }, { type: 'end', text: '记录' }],
    edges: [{ from_position: 0, to_position: 1 }, { from_position: 1, to_position: 2 }] }])
  if (definition === undefined) throw new Error('缺少原图定义')
  const rendered = await renderFlowchartImage(definition)
  const png = rendered.png
  const image = () => new Paragraph({ children: [new ImageRun({ type: 'png', data: png,
    transformation: { width: 180, height: Math.round(180 * rendered.height / rendered.width) } })] })
  const packed = await Packer.toBuffer(new Document({ sections: [{
    properties: { page: { size: { width: 12000, height: 16000 }, margin: { left: 1000, right: 1000 } } },
    headers: { default: new Header({ children: [new Paragraph('原页眉')] }) },
    footers: { default: new Footer({ children: [new Paragraph('原页脚')] }) },
    children: [new Paragraph('重复原文'), image(), new Paragraph({ children: [new TextRun('图 '), new SimpleField('SEQ Figure \\* ARABIC', '1'), new TextRun(' 原题注')] }),
      new Paragraph({ children: [new Bookmark({ id: '原书签', children: [new TextRun('保留书签')] }),
        new ExternalHyperlink({ link: 'https://example.com/', children: [new TextRun('保留链接')] })] }),
      new Table({ width: { size: 3000, type: 'dxa' }, columnWidths: [3000],
        rows: [new TableRow({ children: [new TableCell({ width: { size: 3000, type: 'dxa' }, children: [new Paragraph('表格段落')] })] })] })],
  }, { properties: { page: { size: { width: 12000, height: 16000 }, margin: { left: 2000, right: 2000 } } },
    children: [new Paragraph('重复原文'), image(), new Paragraph('允许删除'), new Paragraph({ pageBreakBefore: true, text: '跨页检查位置' }),
      new Paragraph('维护记录：检查设备状态，确认通道畅通，记录本次检查结果。'),
      new Paragraph('后续处理：发现异常时安排复核，复核完成后保存记录。本页为原稿的维护记录附页。')],
  }] }))
  const zip = await JSZip.loadAsync(packed)
  const parts = await readDocxXml(packed)
  for (const [index, node] of docxDescendants(parts['word/document.xml']!, 'docPr').entries()) node.attributes!.id = String(index + 1)
  zip.file('word/document.xml', js2xml(parts['word/document.xml']!, { compact: false }))
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const ref = promptFileRefSchema.parse({ attachmentId: `file:${hash('原稿')}`, version: hash(bytes) })
  const index = await indexDocxDocument(bytes, ref)
  const select = (text: string, occurrence = 0): DocxBlockRef => index.blocks.filter(block => block.kind === 'paragraph' && block.text === text)[occurrence]!.ref
  return { bytes, ref, index, png, select }
}

/**
 * 验证原 Word 的全部正文节点与非正文 ZIP 部件仍逐字保留。
 * @param before 上传原件。
 * @param after 下载的配图成稿。
 * @returns 字节未变的 ZIP 部件清单。
 */
export async function assertNativeDocumentPreserved(before: Buffer, after: Buffer): Promise<string[]> {
  const original = await JSZip.loadAsync(before)
  const result = await JSZip.loadAsync(after)
  const unchanged: string[] = []
  for (const entry of Object.values(original.files)) {
    if (entry.dir || ['word/document.xml', 'word/_rels/document.xml.rels'].includes(entry.name)) continue
    assert(result.file(entry.name) !== null, `原 ZIP 部件丢失：${entry.name}`)
    assert((await entry.async('nodebuffer')).equals(await result.file(entry.name)!.async('nodebuffer')), `原 ZIP 部件被修改：${entry.name}`)
    unchanged.push(entry.name)
  }
  const bodies = await Promise.all([before, after].map(async bytes =>
    docxDescendants((await readDocxXml(bytes))['word/document.xml']!, 'body')[0]!.elements!
      .filter(element => element.type === 'element').map(element => js2xml(element, { compact: false }))))
  let position = 0
  for (const node of bodies[0]!) {
    const found = bodies[1]!.indexOf(node, position)
    assert(found >= 0, '原正文节点被删除、修改或重排')
    position = found + 1
  }
  return unchanged
}
