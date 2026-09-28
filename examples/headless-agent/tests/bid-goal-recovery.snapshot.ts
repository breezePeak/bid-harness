/** 原生 Goal Round 在真实 Bid Session 中调用诊断与受控恢复工具。 */
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it.each(['tender_analysis', 'outline_generation', 'evidence_mapping'])('%s 校验失败后由同一主会话 Goal Round 接管', async (stage) => {
  const result = await runLoaderSmoke({
    label: 'Bid Goal 恢复源码装配', tempDirPrefix: 'dsh-bid-goal-recovery-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-goal-recovery-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-goal-recovery.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { DSH_BID_RECOVERY_STAGE: stage },
  })
  expect(JSON.parse(result.stdout)).toEqual({
    boundToInitialS2: true, rounds: 1, goalPrompt: true, recoveryPrompt: true, strategyPrompt: true,
    calls: ['bid_stage_inspect', 'bid_recover_task'], acceptedEvents: 1,
    recoveryUnit: stage === 'evidence_mapping' ? 'MAP-REPAIR-S2.1'
      : stage === 'outline_generation' ? 'outline/outline.json' : 'analysis/project.json',
    startedRuns: stage === 'tender_analysis' ? 2 : stage === 'outline_generation' ? 3 : 4,
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
