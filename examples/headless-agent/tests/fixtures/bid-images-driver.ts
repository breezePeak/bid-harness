/** 生图 HTTP 返回固定图片，实际 S5 会话、视觉确认、资产绑定与 Word 导出回放。 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { chapterImageFixturePng } from '../../../../packages/bid/bid/tests/fixtures/chapter-image-png.ts'
import { runChapterWritingLoop } from '../../../../packages/bid/bid/tests/fixtures/evidence-mapping-loop.ts'
import { BidImageGenerationConfig, BID_IMAGE_SETTINGS_NAMESPACE } from '../../../../packages/bid/bid/src/bid-image-config.ts'
import { attachBidImageStyle, readBidImageStyle, readChapterImages } from '../../../../packages/bid/bid/src/chapter-images.ts'
import { createBidImageProvider } from '../../../../packages/bid/bid/src/bid-image-provider.ts'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import { executeDocxExport } from '../../../../packages/bid/bid/src/docx-export.ts'
import { createTestBidRunContext } from '../../../../packages/bid/bid/src/run-coordinator.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('缺少生图回放配置路径')
await writeFile('image-settings.yaml', '{}\n')
await writeFile('image-credentials.yaml', 'version: 1\nrefs:\n  BID_IMAGE_SNAPSHOT_KEY: snapshot-only-key\n')
const png = await chapterImageFixturePng()
const originalFetch = globalThis.fetch
const requests: string[] = []
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url !== 'https://cpa.example/v1/images/generations') throw new Error(`非预期图片请求：${url}`)
  requests.push(String(init?.body))
  return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200,
    headers: { 'content-type': 'application/json' } })
}
let ctx: Context | undefined
try {
  ctx = await boot('bid-images-snapshot', configPath)
  const host = ctx
  host.settings.register(settingsNamespace('llm-pi-ai'), z.object({ providers: z.object({
    pp: z.object({ baseURL: z.string(), apiKeyEnv: z.string() }),
  }) }), { base: { providers: { pp: { baseURL: 'https://cpa.example/v1', apiKeyEnv: 'BID_IMAGE_SNAPSHOT_KEY' } } } })
  const settings = host.settings.register(BID_IMAGE_SETTINGS_NAMESPACE, BidImageGenerationConfig,
    { base: { model: 'snapshot-image-model' } })
  const frozen = process.env.DSH_BID_FROZEN_IMAGE_STYLE === '1'
  if (frozen) {
    const planner = host.agentLoop.create(SessionId('frozen-image-style-planner'), { provider: 'mock', model: 'mock' })
    const workspace = new BidWorkspace(process.cwd())
    const connection = createBidImageProvider(host).resolve()
    if (connection === undefined) throw new Error('缺少初始项目作图连接')
    const runtime = attachBidImageStyle(planner, workspace, connection, createTestBidRunContext().commits, 0)
    try {
      const result = await host.tools.execute({ agent: planner, name: 'set_image_style',
        arguments: { prompt: '蓝灰色写实工业插图，浅色背景，统一透视和光照，不在画面内写文字。' },
        callId: CallId('freeze-existing-style'), signal: new AbortController().signal })
      if (result.isError) throw new Error('项目原风格建立失败')
    } finally { runtime.dispose() }
    await settings.update({ model: '', baseURL: 'https://changed.example/v1' })
  }
  const result = await runChapterWritingLoop(host, process.cwd(), frozen ? 'frozen' : true)
  const style = await readBidImageStyle(result.workspace)
  const images = await readChapterImages(result.workspace, 'SEC-SECURITY')
  await executeDocxExport(result.workspace, createTestBidRunContext())
  const markdown = await readFile(join(result.workspace.projectRoot, 'output/bid.md'), 'utf8')
  process.stdout.write(JSON.stringify({ generated: requests.length, style, images,
    markdown, image_sha256: images.length === 0 ? null : createHash('sha256').update(await readFile(join(result.workspace.projectRoot, images[0]!.path))).digest('hex') }) + '\n')
} finally { globalThis.fetch = originalFetch; await ctx?.fiber.dispose() }
