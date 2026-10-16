/** 独立文件任务生成的 Word 必须包含真实 OOXML 正文。 */
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import type { NativeVisioExport } from '../../src/native-visio.ts'

/** 无密钥回放只校验生成的 OOXML，不依赖宿主安装的 Office。 */
export const keylessNativeOffice: NativeVisioExport = {
  visio: {
    isAvailable: async () => false,
    createDiagram: async () => { throw new Error('无密钥回放不调用 Visio。') },
  },
  word: {
    isAvailable: async () => false,
    embed: async () => { throw new Error('无密钥回放不调用 Word。') },
    countVisioObjects: async () => { throw new Error('无密钥回放不调用 Word。') },
  },
}

/**
 * @param bytes 实际生成的 Word 文件。
 * @param text 正文应包含的源文件内容。
 */
export async function assertDocxDocumentContains(bytes: Uint8Array, text: string): Promise<void> {
  const zip = await JSZip.loadAsync(bytes)
  assert((await zip.file('word/document.xml')?.async('string'))?.includes(text))
}
