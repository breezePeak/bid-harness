/** 固定真实 Loader 中 S5 挂起策略、用户继续和恢复接纳。 */
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('S5 意外挂起后不提问，用户继续沿用原 work', async () => {
  const result = await runLoaderSmoke({
    label: 'S5 挂起流程图视觉策略', tempDirPrefix: 'dsh-s5-flowchart-policy-',
    binScript: fileURLToPath(new URL('./fixtures/bid-flowchart-policy-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-flowchart-policy.cordis.snapshot.yml', import.meta.url)),
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toEqual({
    parameters: {
      type: 'object', properties: { policy: { type: 'string', enum: ['required', 'skip'] } },
      required: ['policy'], additionalProperties: false,
    },
    command: { status: 'pending', command: { kind: 'flowchart_visual_review_policy', policy: 'skip' } },
    modelSawTool: true,
    modelSawRule: true,
    toolCallLogged: true,
    sameWork: true,
    stillSuspended: true,
    noRecoveryQuestion: true,
    modelSawResumeTool: true,
    resumeToolCallLogged: true,
    resumeAdmitted: true,
    resumeToolSucceeded: true,
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
