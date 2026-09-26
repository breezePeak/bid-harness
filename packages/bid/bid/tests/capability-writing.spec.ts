import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import { allowedWritingCapabilitySourceWrites, allowedWritingCapabilityWrites } from '../src/bid-writing-capability.ts'
import { writeInputs } from './fixtures/chapter-writing-inputs.ts'

it('章节能力只授权目标正文、审核与共享索引，不授权范围外文件', async () => {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-capability-writing-paths-')))
  await writeInputs(workspace)
  const paths = await allowedWritingCapabilityWrites(workspace, new Set(['SEC-2']))
  expect(paths).toEqual(new Set([
    'chapters/sections/0002.md', 'chapters/meta/0002.json', 'chapters/reviews/0002.json',
    'chapters/execution-plan.json', 'chapters/execution-log.json', 'chapters/manifest.json',
    'analysis/evidence-map.json', 'analysis/web-evidence-sources.json', 'outline/quality-report.json',
  ]))
  expect(await allowedWritingCapabilitySourceWrites(workspace)).toEqual(new Set())
})
