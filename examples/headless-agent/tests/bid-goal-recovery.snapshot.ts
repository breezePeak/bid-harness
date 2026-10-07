/** 原生 Goal Round 与默认 Bid 失败流程相互独立。 */
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it.each(['tender_analysis', 'outline_generation', 'evidence_mapping'])('%s 默认失败交回主 Agent，显式 Goal 使用公共工具并独立完成', async (stage) => {
  const result = await runLoaderSmoke({
    label: 'Bid Goal 恢复源码装配', tempDirPrefix: 'dsh-bid-goal-recovery-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-goal-recovery-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-goal-recovery.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { DSH_BID_RECOVERY_STAGE: stage },
  })
  expect(JSON.parse(result.stdout)).toEqual({
    noAutomaticGoal: true, decision: false, phase: 'complete', rounds: 1,
    goalPrompt: true, stagePrompt: true, calls: ['bid_stage_inspect', 'bid_recover_task', 'bid_stage_inspect', 'get_goal', 'update_goal'],
    recoveryEvents: 1, legacyEvents: 0, createGoalVisible: false,
    startedRuns: stage === 'tender_analysis' ? 2 : stage === 'outline_generation' ? 3 : 4,
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('源码装配的 Host 拒绝通过更换指令重跑失效目录 Work', async () => {
  const configPath = fileURLToPath(new URL('../bid-goal-recovery.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'Bid stale 恢复拒绝源码装配', tempDirPrefix: 'dsh-bid-stale-recovery-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-goal-recovery-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'stale'],
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toEqual({ rejected: [true, true, true], toolAvailable: false, acceptedEvents: 0, startedRuns: 1 })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
