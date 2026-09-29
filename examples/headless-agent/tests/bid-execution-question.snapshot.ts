/** 后台执行提问不会留在子会话等待用户。 */
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('源码装配的 Bid Execution 提问唤醒主 Agent', async () => {
  const result = await runLoaderSmoke({
    label: 'Bid 后台提问源码装配', tempDirPrefix: 'dsh-bid-execution-question-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-execution-question-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-goal-recovery.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toEqual({
    denied: true, providerCalls: 0, notices: 1, mainSawQuestion: true, mainReplied: true,
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
