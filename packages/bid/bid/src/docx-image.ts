/** DOCX 正文图片的确定性尺寸读取。 */

/**
 * 读取导出支持的 PNG/JPEG 像素尺寸。
 * @param data 已验证的图片字节。
 * @returns 图片格式及原始像素尺寸。
 */
export function docxImageDimensions(data: Buffer): { type: 'png' | 'jpg'; width: number; height: number } {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { type: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (data[0] !== 255 || data[1] !== 216) throw new Error('仅支持有效 PNG 或 JPEG。')
  let offset = 2
  while (offset + 9 < data.length) {
    const marker = data.readUInt8(offset + 1), length = data.readUInt16BE(offset + 2)
    if ([192, 193, 194].includes(marker)) {
      const height = data.readUInt16BE(offset + 5), width = data.readUInt16BE(offset + 7)
      if (width && height) return { type: 'jpg', width, height }
      break
    }
    if (length < 2) break
    offset += length + 2
  }
  throw new Error('无法读取图片尺寸。')
}
