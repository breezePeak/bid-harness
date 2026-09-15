import { afterEach, describe, expect, it } from 'vitest'
import { createNativeVisioExport } from '../src/native-visio.ts'

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
})
