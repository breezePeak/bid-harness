/** 生图测试使用程序生成的固定 PNG，外部 API 返回与本地工具共用。 */
import sharp from 'sharp'

/** @returns 固定尺寸和颜色的真实 PNG。 */
export function chapterImageFixturePng(): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 16, channels: 3, background: '#41586a' } }).png().toBuffer()
}
