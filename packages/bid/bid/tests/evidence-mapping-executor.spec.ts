import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BidWorkspace, buildBidStageTask, executeEvidenceMapping } from '@deepseek-ai/dsh-bid'

describe('evidence-mapping Agent executor', () => {
  it('removes a failed-attempt Artifact before retrying S3', async () => {
    const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-executor-')), 'session')
    const artifact = join(workspace.sessionRoot, 'analysis/evidence-map.json')
    await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
    await writeFile(artifact, '{ stale }', 'utf8')
    const followup = vi.fn()
    const whenIdle = vi.fn(async () => {
      if (whenIdle.mock.calls.length === 2) await expect(access(artifact, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    const services = {
      fs: { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })) },
      tools: { restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) },
    }
    const agent = {
      id: 'session',
      ctx: { get: (name: keyof typeof services) => services[name], emit: vi.fn() },
      followup,
      whenIdle,
    } as unknown as Agent

    await expect(executeEvidenceMapping(agent, workspace, buildBidStageTask('evidence_mapping')))
      .resolves.toEqual([{ stage: 'evidence_mapping', type: 'evidence_map', path: 'analysis/evidence-map.json' }])
    expect(followup).toHaveBeenCalledOnce()
  })
})
