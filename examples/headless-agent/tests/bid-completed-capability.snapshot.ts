/** 独立能力完成后，三种原阶段状态通过真实 Loader 接受同 Work 纠正并保留范围外产物。 */
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it.each(['ready', 'waiting_user', 'completed'] as const)('原阶段 %s：已发布能力沿用原 Work 追加纠正并重新验收', async (status) => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const mode = status === 'completed' ? 'task-published-correction'
    : status === 'ready' ? 'task-published-correction-ready' : 'task-published-correction-waiting-user'
  const result = await runLoaderSmoke({
    label: '同 Work 三态纠正', tempDirPrefix: 'dsh-bid-completed-capability-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, mode], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const facts = JSON.parse(result.stdout) as {
    state: string
    workIds: string[]
    planPatchCount: number
    priorPublicationPreserved: boolean
    publicationNotices: number
    correctionNoticeMatchesRun: boolean
    outsidePreserved: boolean
    outsideCompleted: boolean
    seedPreserved: boolean
    calls: string[]
    stagePreserved?: boolean
    nativeStageRuns?: number
  }
  expect(facts.workIds).toHaveLength(1)
  expect(facts.state).toBe(status)
  expect({ sameWork: facts.workIds.length === 1, planPatchCount: facts.planPatchCount,
    priorPublicationPreserved: facts.priorPublicationPreserved, publicationNotices: facts.publicationNotices,
    correctionNoticeMatchesRun: facts.correctionNoticeMatchesRun, outsidePreserved: facts.outsidePreserved,
    outsideCompleted: facts.outsideCompleted, seedPreserved: facts.seedPreserved, calls: facts.calls,
    ...status === 'completed' ? {} : { stagePreserved: facts.stagePreserved, nativeStageRuns: facts.nativeStageRuns },
  }).toMatchSnapshot()
}, 150_000)
