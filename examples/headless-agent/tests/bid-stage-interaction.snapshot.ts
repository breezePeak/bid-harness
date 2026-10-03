/** 固定源码 Loader 中的 Main Agent 交互工具、阶段事件与修改结果。 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

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

it('主 Agent 在原授权内换用目录编辑能力并接续后续步骤', async () => {
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
    plan: { status: 'completed', steps: [
      { description: '将章节3提升到顶层并保留现有正文', status: 'completed', hasResult: true },
      { description: '将提升后的章节改名为独立实施方案', status: 'completed', hasResult: true },
    ] },
    calls: ['bid_project_inspect', 'bid_run_task', 'bid_stage_inspect', 'bid_project_inspect', 'bid_plan_task', 'bid_recover_task'],
  })
}, 75_000)

it.each(['supersede', 'failed-supersede'])('主 Agent 用新用户任务通过 %s 接管旧 Work 并发布评分目录', async (scenario) => {
  const configPath = fileURLToPath(new URL('../bid-stage-interaction.cordis.snapshot.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: '挂起能力任务接管源码装配', tempDirPrefix: 'dsh-bid-supersede-snapshot-',
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
      expect(parent).toContain('编号不是 Section ID')
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
