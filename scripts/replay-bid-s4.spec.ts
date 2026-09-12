import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import { parseReplayBidS4Args, prepareBidS4ReplayWorkspace } from './replay-bid-s4.ts'

describe('S4 Workspace 回放入口', () => {
  it('解析通用 Workspace、Section 过滤和执行参数，不内置项目 Section ID', () => {
    const options = parseReplayBidS4Args([
      '--workspace', 'source', '--output', 'target', '--sections', 'SEC-A, SEC-B',
      '--provider', 'chat-only', '--model', 'model-a', '--max-concurrency', '2',
      '--repair-attempts', '0', '--timeout-ms', '60000',
    ], 'D:/acceptance')
    expect(options).toMatchObject({
      workspace: resolve('D:/acceptance/source'), output: resolve('D:/acceptance/target'),
      sections: ['SEC-A', 'SEC-B'], provider: 'chat-only', model: 'model-a',
      maxConcurrency: 2, maxRepairAttempts: 0, timeoutMs: 60_000,
    })
  })

  it('只保留副本中的 S1-S3 状态，不修改源 Workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-s4-replay-entry-'))
    const sourceRoot = join(root, 'source')
    const outputRoot = join(root, 'output')
    await mkdir(join(sourceRoot, '.bid-harness', 'outline'), { recursive: true })
    const sourceMarker = join(sourceRoot, '.bid-harness', 'outline', 'marker.json')
    const staleS4 = join(sourceRoot, '.bid-harness', 'analysis', 'evidence-mapping-checkpoint.json')
    await writeFile(sourceMarker, '{"source":true}\n')
    await mkdir(join(sourceRoot, '.bid-harness', 'analysis'), { recursive: true })
    await writeFile(staleS4, '{"oldS4":true}\n')
    const replay = await prepareBidS4ReplayWorkspace(new BidWorkspace(sourceRoot), outputRoot)
    await writeFile(join(replay.projectRoot, 'outline', 'marker.json'), '{"replay":true}\n')
    await expect(readFile(sourceMarker, 'utf8')).resolves.toBe('{"source":true}\n')
    await expect(readFile(staleS4, 'utf8')).resolves.toBe('{"oldS4":true}\n')
    await expect(readFile(join(replay.projectRoot, 'outline', 'marker.json'), 'utf8')).resolves.toBe('{"replay":true}\n')
    await expect(access(join(replay.projectRoot, 'analysis', 'evidence-mapping-checkpoint.json'))).rejects.toThrow()
    await expect(prepareBidS4ReplayWorkspace(new BidWorkspace(sourceRoot), outputRoot))
      .rejects.toThrow('回放目标已存在')
  })
})
