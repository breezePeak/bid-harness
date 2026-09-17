import { afterEach, describe, expect, it } from 'vitest'
import { createNativeVisioExport, detectFlowchartExportEnvironment } from '../src/native-visio.ts'

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

describe('native Visio runtime', () => {
  it('非 Windows 环境明确报告 Office runtime 不可用', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const office = createNativeVisioExport()
    await expect(office.visio.isAvailable()).resolves.toBe(false)
    await expect(office.word.isAvailable()).resolves.toBe(false)
  })

  it('非 Windows 环境下 detectFlowchartExportEnvironment 自动判定为 image_fallback', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const env = await detectFlowchartExportEnvironment()
    expect(env.mode).toBe('image_fallback')
    expect(env.hasVisio).toBe(false)
    expect(env.hasWord).toBe(false)
    expect(env.reasons).toContain('当前运行环境非 Windows 平台，不支持 Office COM 自动化')
  })
})
