/** 固定源码 Loader 中的 Main Agent 交互工具、阶段事件与修改结果。 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

it('第八章新增小节的数字选择保留完整上下文，拒绝捏造目录限制并在同一 Work 完成', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({ label: '数字澄清的真实新增小节', tempDirPrefix: 'dsh-bid-numeric-clarification-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-numeric-clarification'], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) })
  expect(JSON.parse(result.stdout)).toMatchObject({ state: 'completed', source: '3', userMessages: 2,
    sourceContext: ['我需要将第8章也细化一下，增加几个小章节。'], workIds: [expect.any(String)],
    unfoundedRestrictionRejected: true, noSuspension: true, verifiedCompletionNotice: true, seedPreserved: true, outsidePreserved: true,
    children: ['收集输入', '校验结果', '交付成果'], workbench: Array(3).fill({ status: 'completed', content: true }) })
}, 150_000)

it('同一 Work 更新写作规则后继续无变更业务绑定，复用范围外强依赖并按当前规则审核发布', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '局部写作与验收规则一致', tempDirPrefix: 'dsh-bid-current-rules-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-rules-update'], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const facts = JSON.parse(result.stdout) as Record<string, unknown>
  expect(facts, JSON.stringify(facts.recoveryErrors)).toMatchObject({
    state: 'completed', interrupted: true, workIds: [expect.any(String)], userMessages: 1,
    seedPreserved: true, outsidePreserved: true, outsideCompleted: true, currentRulesReviewed: true, currentRulesShared: true,
    outsideDependencyPreserved: true, acceptedCheckpointRestored: true, missingCitationRejected: true,
    revisionPreservationShared: true, revisionPublished: true,
    selectedRouteInherited: true,
    recoveryErrors: [{ code: 'ETIMEDOUT' }],
    executions: ['outline.update', 'chapter.reorganize', 'chapter.write', 'chapter.review', 'writing.plan', 'outline.update', 'chapter.write', 'chapter.review', 'chapter.revise'],
    workbench: Array(3).fill({ status: 'completed', content: true }),
  })
}, 150_000)

it('六子章稀疏迁移在同一子会话拒绝漏块、表题分离及原文共享，空草稿子章仍完成写作审核和发布', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '六子章完整迁移', tempDirPrefix: 'dsh-bid-six-sparse-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'six-sparse'], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const facts = JSON.parse(result.stdout) as { workIds: string[] }
  expect(facts.workIds).toHaveLength(1)
  expect(facts).toMatchObject({ state: 'completed', migrationSubmissions: 4, originalUnique: true, generatedDraftRepaired: true,
    children: ['收集输入', '边界确认', '校验结果', '内业处理', '复核整改', '交付成果'],
    seedPreserved: true, outsidePreserved: true, outsideCompleted: true,
    workbench: Array(6).fill({ status: 'completed', content: true }),
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task'],
  })
}, 150_000)

it('局部审核中断后 Main 沿用原 Work 和正文，只续剩余审核并发布', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '原 Work 审核恢复', tempDirPrefix: 'dsh-bid-review-resume-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-review-resume'], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const facts = JSON.parse(result.stdout) as { workIds: string[] }
  expect(facts.workIds).toHaveLength(1)
  expect(facts).toMatchObject({ state: 'completed', interrupted: true, reviewResumeNoWriter: true,
    children: ['收集输入', '校验结果', '交付成果'], seedPreserved: true, outsidePreserved: true,
    outsideCompleted: true, workbench: Array(3).fill({ status: 'completed', content: true }),
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task', 'bid_recover_task'],
  })
}, 150_000)

it('产物核验只读首字符的完成结论在同一子会话拒绝，补读完整证据后才发布', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '拒绝未读核验证据', tempDirPrefix: 'dsh-bid-unread-verification-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-unread-verification'], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const facts = JSON.parse(result.stdout) as { workIds: string[] }
  expect(facts.workIds).toHaveLength(1)
  expect(facts).toMatchObject({ state: 'completed', unreadVerificationRejected: true, seedPreserved: true,
    outsidePreserved: true, outsideCompleted: true, workbench: Array(3).fill({ status: 'completed', content: true }),
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task'],
  })
}, 150_000)

it('已发布结果的用户纠正沿用原 Work，保留历史凭据并重新审核发布', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '已发布 Work 纠正', tempDirPrefix: 'dsh-bid-published-correction-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-published-correction'], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const facts = JSON.parse(result.stdout) as { workIds: string[] }
  expect(facts.workIds).toHaveLength(1)
  expect(facts).toMatchObject({ state: 'completed', priorPublicationPreserved: true, planPatchCount: 1,
    publicationNotices: 2, correctionNoticeMatchesRun: true,
    seedPreserved: true, outsidePreserved: true, outsideCompleted: true, userMessages: 2,
    workbench: Array(3).fill({ status: 'completed', content: true }),
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task', 'bid_project_inspect', 'bid_plan_task', 'bid_recover_task'],
  })
}, 150_000)

it('遗漏导出的计划拒绝后，Main 在原 Work 补齐尾步骤并完成真实 Word 导出', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '原 Work 补齐导出', tempDirPrefix: 'dsh-bid-task-export-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-export'], mode: 'src', processTimeoutMs: 90_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "calls": [
        "bid_project_inspect",
        "bid_run_task",
        "bid_stage_inspect",
        "bid_project_inspect",
        "bid_plan_task",
        "bid_recover_task",
      ],
      "completedNotices": 1,
      "displayedSteps": [
        {
          "capability": "tender.update",
          "status": "completed",
        },
        {
          "capability": "docx.export",
          "status": "completed",
        },
      ],
      "goalMet": true,
      "planRejected": true,
      "sameWork": true,
      "state": "completed",
      "steps": [
        {
          "capability": "tender.update",
          "status": "completed",
        },
        {
          "capability": "docx.export",
          "status": "pending",
        },
      ],
      "userMessages": 1,
      "wordFile": true,
    }
  `)
}, 120_000)

it.each(['task-planning', 'task-adding'])('完整项目通过 %s 在原章下建立子章，经原文迁移和新叶节写作发布', async (scenario) => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '真实目录拆章与正文完成', tempDirPrefix: 'dsh-bid-task-planning-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, scenario], mode: 'src',
    processTimeoutMs: 90_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const facts = JSON.parse(result.stdout) as { workIds: string[] }
  expect(facts.workIds).toHaveLength(1)
  expect(facts).toMatchObject({
    state: 'completed', source: '只修改本章 S2.3，把三个阶段拆成真实目录子章节，保留原文并完成正文和审核。不要改其他章节。',
    children: ['收集输入', '校验结果', '交付成果'],
    workbench: Array(3).fill({ status: 'completed', content: true }),
    seedPreserved: true, outsidePreserved: true, outsideCompleted: true,
    exportedChildren: ['收集输入', '校验结果', '交付成果'],
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task'], userMessages: 1, verifiers: 2,
    interrupted: false, executions: [],
  })
}, 120_000)

it('拆章要求经第二条章节名称澄清后完整冻结，并通过正文审核与发布', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '连续用户消息的拆章任务', tempDirPrefix: 'dsh-bid-clarification-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-clarification'], mode: 'src', processTimeoutMs: 90_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const facts = JSON.parse(result.stdout) as { workIds: string[] }
  expect(facts.workIds).toHaveLength(1)
  expect(facts).toMatchObject({ state: 'completed', source: 'S2.3', userMessages: 2, verifiers: 2,
    sourceContext: ['本章也需要小章节。把三个阶段拆成真实目录子章节，保留原文、表格和流程图，并完成正文和审核。不要改其他章节；具体是哪章等我确认后再执行。'],
    children: ['收集输入', '校验结果', '交付成果'], seedPreserved: true, outsidePreserved: true, outsideCompleted: true,
    workbench: Array(3).fill({ status: 'completed', content: true }),
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task'],
  })
}, 120_000)

it('模型切换和原文迁移后中断仍以原 Work 完成资料、正文、审核与发布', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '当前模型下原 Work 完整恢复', tempDirPrefix: 'dsh-bid-selected-route-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'selected-route'], mode: 'src',
    processTimeoutMs: 90_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toMatchObject({
    state: 'completed', selectedRouteInherited: true, interrupted: true,
    children: ['收集输入', '校验结果', '交付成果'],
    workIds: [expect.any(String)], seedPreserved: true, outsidePreserved: true, outsideCompleted: true,
    workbench: Array(3).fill({ status: 'completed', content: true }),
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task', 'bid_recover_task'],
    executions: ['outline.update', 'chapter.reorganize', 'chapter.write', 'chapter.review'],
  })
}, 120_000)

it('已冻结授权的模型复判冲突由 Host 恢复原 Work，完成前缀不重跑', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '原 Work 授权复判冲突恢复', tempDirPrefix: 'dsh-bid-auth-recheck-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-auth-recheck'], mode: 'src', processTimeoutMs: 90_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toMatchObject({
    state: 'completed', interrupted: true, workIds: [expect.any(String)],
    seedPreserved: true, outsidePreserved: true, outsideCompleted: true,
    workbench: Array(3).fill({ status: 'completed', content: true }),
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task', 'bid_recover_task'],
    executions: ['outline.update', 'chapter.reorganize', 'chapter.write', 'chapter.review'],
  })
}, 120_000)

it('部分新叶节完成后切换模型并重新规划，原 Work 复用正文审核且只补失败章节', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '部分拆章成果恢复', tempDirPrefix: 'dsh-bid-partial-replan-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'partial-replan'], mode: 'src',
    processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const facts = JSON.parse(result.stdout) as { workIds: string[] }
  expect(facts.workIds).toHaveLength(1)
  expect(facts).toMatchObject({ state: 'completed', selectedRouteInherited: true, interrupted: true,
    children: ['收集输入', '校验结果', '交付成果'], resumedWriterTitles: ['交付成果'],
    seedPreserved: true, outsidePreserved: true, outsideCompleted: true,
    planPatchCount: 1,
    workbench: Array(3).fill({ status: 'completed', content: true }),
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task', 'bid_plan_task', 'bid_recover_task'],
    executions: ['outline.update', 'chapter.reorganize', 'chapter.write', 'chapter.write', 'chapter.review'],
  })
}, 150_000)

it('步骤指令与章节职责冲突时 Main 在原 Work 改计划，实际无外部缺口不向用户索要资料', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '章节职责冲突恢复', tempDirPrefix: 'dsh-bid-assignment-conflict-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-assignment-conflict'], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toMatchObject({
    state: 'completed', interrupted: true, workIds: [expect.any(String)], userMessages: 1,
    seedPreserved: true, outsidePreserved: true, outsideCompleted: true,
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task', 'bid_plan_task', 'bid_recover_task'],
    executions: ['outline.update', 'chapter.reorganize', 'chapter.write', 'chapter.write', 'chapter.review'],
    workbench: Array(3).fill({ status: 'completed', content: true }),
  })
}, 150_000)

it('章节日志已完成但审核要求整改时，原 Work 只续写失败章节并完成正式发布', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '已提交失败审核恢复', tempDirPrefix: 'dsh-bid-completed-repair-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-completed-repair'], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toMatchObject({
    state: 'completed', interrupted: true, workIds: [expect.any(String)], userMessages: 1,
    resumedWriterTitles: ['校验结果'], seedPreserved: true, outsidePreserved: true, outsideCompleted: true,
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task', 'bid_plan_task', 'bid_recover_task'],
    planPatchCount: 1,
    executions: ['outline.update', 'chapter.reorganize', 'chapter.write', 'chapter.write', 'chapter.review'],
    workbench: Array(3).fill({ status: 'completed', content: true }),
  })
}, 150_000)

it('写作中断后先纠正业务归属，保留其他审核和原候选并完成同一 Work 发布', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '业务归属修正后恢复写作', tempDirPrefix: 'dsh-bid-binding-repair-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-binding-repair'], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toMatchObject({
    state: 'completed', interrupted: true, workIds: [expect.any(String)], userMessages: 1,
    resumedWriterTitles: ['校验结果'], seedPreserved: true, outsidePreserved: true, outsideCompleted: true,
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task', 'bid_project_inspect', 'bid_plan_task', 'bid_recover_task'],
    executions: ['outline.update', 'chapter.reorganize', 'chapter.write', 'outline.update', 'chapter.write', 'chapter.review'],
    bindingRepaired: true,
    queuedReplacementCanceled: true,
    planPatchCount: 1,
    workbench: Array(3).fill({ status: 'completed', content: true }),
  })
}, 150_000)

it('用户纠正未完成写作的原文迁移时，在同一 Work 从已接纳结果重新迁移并发布', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '原文迁移纠正后重新写作', tempDirPrefix: 'dsh-bid-migration-restart-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'task-migration-restart'], mode: 'src', processTimeoutMs: 120_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toMatchObject({
    state: 'completed', interrupted: true, workIds: [expect.any(String)], userMessages: 2,
    seedPreserved: true, outsidePreserved: true, outsideCompleted: true,
    calls: ['bid_project_inspect', 'bid_project_inspect', 'bid_run_task', 'bid_project_inspect', 'bid_plan_task', 'bid_recover_task'],
    executions: ['outline.update', 'chapter.reorganize', 'chapter.write', 'chapter.reorganize', 'chapter.write'],
    migrationRestarted: true, planPatchCount: 1,
    workbench: Array(3).fill({ status: 'completed', content: true }),
  })
}, 150_000)

it('首次任务与重规划拒绝超长步骤说明，同回合改为短摘要后完成原目标', async () => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '能力计划恢复源码装配', tempDirPrefix: 'dsh-bid-replan-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, 'replan'], mode: 'src',
    processTimeoutMs: 60_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toEqual({
    section: { title: '独立实施方案', parent_id: null, level: 1 }, bodyPreserved: true,
    userMessages: 1, completed: 1,
    initialDescriptionRejected: true, replacementDescriptionRejected: true,
    descriptionSchemaChecked: true, descriptionGuidanceChecked: true, planPatchCount: 1,
    plan: { status: 'completed', steps: [
      { description: '将章节3提升到顶层并保留现有正文', status: 'completed', hasResult: true },
      { description: '将提升后的章节改名为独立实施方案', status: 'completed', hasResult: true },
    ] },
    calls: ['bid_project_inspect', 'bid_run_task', 'bid_run_task', 'bid_stage_inspect', 'bid_project_inspect',
      'bid_plan_task', 'bid_plan_task', 'bid_recover_task'],
  })
}, 75_000)

it.each(['supersede', 'failed-supersede'])('主 Agent 用新用户任务通过 %s 接管旧 Work 并发布评分目录', async (scenario) => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '失败能力任务接管源码装配', tempDirPrefix: 'dsh-bid-supersede-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath, binArgs: [configPath, scenario], mode: 'src',
    processTimeoutMs: 60_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toEqual({
    status: 'completed', wrongTitleGone: true,
    leaf: { title: '总体实施方案', parent_id: 'GROUP-A', responsePoints: ['RP-000001'],
      mustAnswer: ['回答评分1，说明实施方案的范围和方法'] },
    distinctWork: true, resumedOldWork: false,
    calls: ['bid_run_task', 'bid_project_inspect', 'bid_run_task'], supersededNotice: true,
  })
}, 75_000)

it('S4 waiting_user 通过源码 Loader 执行受控对话修改', async () => {
  const result = await runLoaderSmoke({
    label: 'S4 阶段交互源码装配', tempDirPrefix: 'dsh-bid-interaction-snapshot-',
    binScript: fileURLToPath(new URL('./fixtures/bid-stage-interaction-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url)),
    processTimeoutMs: 60_000,
    mode: 'src', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(path => readFile(join(store, path), 'utf8')))
      const parent = logs.find(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).id === 's3-real-loop')!
      const events = parent.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
      expect(events.filter(event => event.type === 'bid.stage.started' || event.type === 'bid.user_confirmation.required').slice(-6).map(event => [event.type, event.data.stage])).toEqual([
        ['bid.stage.started', 'file_intake'], ['bid.stage.started', 'tender_analysis'],
        ['bid.stage.started', 'outline_generation'],
        ['bid.user_confirmation.required', 'evidence_mapping'],
        ['bid.user_confirmation.required', 'evidence_mapping'],
        ['bid.user_confirmation.required', 'evidence_mapping'],
      ])
      expect(parent).toContain('对应到 objects.sections 或 objects.draft_sections 的位置')
      expect(parent).toContain('身份与草稿版本由程序绑定')
      expect(parent).not.toContain('bid.user_confirmation.received')
      const starts = events.filter(event => event.type === 'bid.run.started'
        && event.data.run.work.kind === 'capability_task')
      expect(starts).toHaveLength(2)
      const workId = starts[0]?.type === 'bid.run.started' ? starts[0].data.run.work.workId : undefined
      expect(events.filter(event => event.type === 'bid.run.notice'
        && event.data.workId === workId && event.data.kind === 'completed')).toHaveLength(1)
      expect(await readFile(join(cwd, `.bid-harness/requests/${workId}/result.json`), 'utf8'))
        .toContain('analysis/requirements.json')
    },
  })
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "calls": [
        "bid_stage_inspect",
        "bid_stage_inspect",
        "bid_stage_inspect",
        "bid_stage_inspect",
        "write",
        "bid_outline_apply_operations",
        "bid_project_inspect",
        "bid_outline_regenerate_scope",
        "bid_project_inspect",
        "bid_project_inspect",
        "bid_run_task",
        "bid_run_task",
        "bid_run_task",
      ],
      "capabilitySplit": [
        {
          "responsePoints": [
            "RP-000001",
          ],
          "title": "人员准备",
        },
        {
          "responsePoints": [],
          "title": "资源核查",
        },
      ],
      "capabilityUpdates": 1,
      "concurrent": [
        "BID_OPERATION_IN_PROGRESS",
        "BID_OPERATION_IN_PROGRESS",
        "BID_OPERATION_IN_PROGRESS",
      ],
      "confirmations": 0,
      "disposed": null,
      "failures": 2,
      "incompletePlanRejected": true,
      "planOnlyNoWork": true,
      "rawWriteBlocked": true,
      "readOnlyNoWork": true,
      "revision": 3,
      "state": {
        "run": null,
        "stage": "evidence_mapping",
        "status": "waiting_user",
      },
      "titles": [
        "访问控制与安全审计",
        "实施准备与资源核查",
        "实施过程",
        "验收移交",
      ],
      "turns": [
        {
          "admitted": true,
          "input": "现在是什么情况？",
        },
        {
          "admitted": true,
          "input": "这样可以吗？",
        },
        {
          "admitted": true,
          "input": "可以",
        },
        {
          "admitted": true,
          "input": "没问题",
        },
        {
          "admitted": true,
          "input": "更新目录",
        },
        {
          "admitted": true,
          "input": "第一章拆成实施准备、实施过程、验收移交",
        },
        {
          "admitted": true,
          "input": "实施准备这一节重新规划一下",
        },
        {
          "admitted": true,
          "input": "先讨论第一条要求，暂不修改",
        },
        {
          "admitted": true,
          "input": "先讨论把实施流程拆成小节的方案，暂不修改",
        },
        {
          "admitted": true,
          "input": "把第一条要求的理解改为明确实施边界",
        },
        {
          "admitted": true,
          "input": "将实施准备拆为人员准备和资源核查两个小节，只调整目录",
        },
      ],
      "untouchedEvidencePreserved": true,
      "updatedRequirement": "明确实施边界",
      "visibleTools": [
        "bid_stage_inspect",
        "bid_outline_apply_operations",
        "bid_outline_regenerate_scope",
        "bid_evidence_remap",
        "bid_project_inspect",
        "bid_run_task",
        "bid_confirm_writing_plan",
      ],
    }
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
