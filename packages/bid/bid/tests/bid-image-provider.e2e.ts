import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { BID_IMAGE_SETTINGS_NAMESPACE, BidImageGenerationConfig } from '../src/bid-image-config.ts'
import { createBidImageProvider } from '../src/bid-image-provider.ts'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

it('通过已有 pp 配置生成概念图及保持项目风格的参考图', async (test) => {
  const ctx = new Context()
  for (const fiber of [
    ctx.plugin(FileSettingsProvider, { watch: false }),
    ctx.plugin(LocalCredentialProvider, { watch: false }),
    ctx.plugin(LlmRuntime),
    ctx.plugin(piAi, {}),
  ]) {
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
  }
  ctx.settings.register(BID_IMAGE_SETTINGS_NAMESPACE, BidImageGenerationConfig, {
    base: { model: process.env.BID_IMAGE_E2E_MODEL ?? 'gpt-image-2', timeoutMs: 300_000 },
  })
  const images = createBidImageProvider(ctx)
  const view = await images.view()
  if (!view.credentialConfigured) test.skip('尚未配置已有 pp 路由及其凭据。')
  const connection = images.resolve()
  if (connection === undefined) {
    test.skip('尚未选择作图模型。')
    return
  }
  const signal = new AbortController().signal
  const models = await images.discoverModels(signal)
  expect(models).toContain(connection.model)
  const first = await images.generate({ model: connection.model, size: '1536x1024',
    prompt: '标书技术方案概念配图：数据中心机房的等距透视商务插画。浅白背景、蓝灰色主色和少量青色点缀，不含文字、数字、标识，不表示任何真实企业业绩或项目现场。',
  }, signal)
  const second = await images.generate({ model: connection.model, size: '1536x1024', reference: first.png,
    prompt: '保持参考图的蓝灰色和青色配色、浅白背景、等距透视与线条质感，绘制维护人员检查网络设备的另一个概念场景，不含文字、数字、标识，不表示真实企业业绩或现场。',
  }, signal)
  for (const image of [first, second]) {
    expect(image.model).toBe(connection.model)
    expect(image.png.length).toBeLessThanOrEqual(connection.maxImageBytes)
    expect(await sharp(image.png).metadata()).toMatchObject({ format: 'png', width: image.width, height: image.height })
  }
  const directory = join(process.cwd(), '.artifacts', 'bid-images-smoke')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'e2e-first.png'), first.png)
  await writeFile(join(directory, 'e2e-reference.png'), second.png)
}, 650_000)
