/** 原生 Goal Round 在真实 Bid Session 中调用诊断与受控恢复工具。 */
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('S2 失败后只由同一主会话 Goal Round 提交一次恢复', async () => {
  const result = await runLoaderSmoke({
    label: 'Bid Goal 恢复源码装配', tempDirPrefix: 'dsh-bid-goal-recovery-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-goal-recovery-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-goal-recovery.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toEqual({
    boundToInitialS2: true, rounds: 1, goalPrompt: true, recoveryPrompt: true,
    calls: ['bid_stage_inspect', 'bid_recover_task'], acceptedEvents: 1, startedRuns: 2,
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
