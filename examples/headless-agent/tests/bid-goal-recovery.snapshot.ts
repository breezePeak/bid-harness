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

it('自动预算耗尽后用户说继续，通过真实工具启动原 S2，保留原 Work 和预算', async () => {
  const configPath = fileURLToPath(new URL('../bid-goal-recovery.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'Bid 用户继续失败阶段', tempDirPrefix: 'dsh-bid-user-continue-',
    binScript: fileURLToPath(new URL('./fixtures/bid-goal-recovery-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'continue'], mode: 'src',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toEqual({
    startedRuns: 2, sameWork: true, resumeOfOriginal: true, automaticEligible: false, attempts: 1,
    automaticRound: 3, automaticBudget: 3,
    calls: ['bid_stage_inspect', 'bid_resume_current_run'], userMessages: ['继续'],
    continuationGuidance: '先用 bid_stage_inspect(view=recovery) 核对失败、原目标和检查点。新的直接用户消息明确要求继续或重试原任务时，调用 bid_resume_current_run 实际执行；即使自动恢复预算已耗尽，也可按这次新授权继续一次。保留原 Work、已保存候选和正式校验，不重置自动预算；普通问答不启动恢复。',
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
