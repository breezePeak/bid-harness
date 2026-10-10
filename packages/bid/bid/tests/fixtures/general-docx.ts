/** 独立文件任务生成的 Word 必须包含真实 OOXML 正文。 */
import assert from 'node:assert/strict'
import JSZip from 'jszip'

/**
 * @param bytes 实际生成的 Word 文件。
 * @param text 正文应包含的源文件内容。
 */
export async function assertDocxDocumentContains(bytes: Uint8Array, text: string): Promise<void> {
  const zip = await JSZip.loadAsync(bytes)
  assert((await zip.file('word/document.xml')?.async('string'))?.includes(text))
}
