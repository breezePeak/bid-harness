/** 固定 Word→PDF 页定位样例；从仓库根运行 node --import tsx/esm packages/bid/bid/tests/fixtures/generate-table-page-anchors.ts 重建。 */
import { writeFile } from 'node:fs/promises'
import { Document, Packer, Paragraph, Table, TableCell, TableRow, WidthType } from 'docx'
import { renderDocxPdf } from '../../src/docx-pdf.ts'

const texts = ['目录：项目、内容、负责人', '其他表：问题等级、项目、内容、负责人', '前一节流程图']
const table = new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [1800, 1800, 1800, 1800], rows: [
  ['复核、关闭条件', '首接与分析', '响应、处理与阶段反馈口径', '项目 内容 负责人'],
  ['一般协调问题', '驻场登记', '升级路径', '内容'],
].map(row => new TableRow({ children: row.map(text => new TableCell({
  width: { size: 1800, type: WidthType.DXA }, children: [new Paragraph(text)],
})) })) })
const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
  ...texts.map((text, index) => new Paragraph({ text, pageBreakBefore: index > 0 })),
  new Paragraph({ text: '目标表', pageBreakBefore: true }), table, new Paragraph({ text: '续表', pageBreakBefore: true }),
] }] }))
await writeFile(new URL('./table-page-anchors.pdf', import.meta.url), await renderDocxPdf(bytes))
