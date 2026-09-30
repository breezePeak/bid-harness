/** 原始任务与真实目录事实的反例；可控核验响应不证明模型自主规划。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { inspectBidProject } from '../src/bid-project-inspect.ts'
import { persistCapabilityTaskRequest } from '../src/bid-capability-task.ts'
import { readBidWorkRequest } from '../src/work-descriptor.ts'
import { bidCapabilityTaskSchema } from '../src/bid-capability-contract.ts'
import { seedCapabilityProject } from './capability-fixture.ts'
import { addRevisionIssue, readRevisionQueue, writeRevisionQueue } from '../src/chapter-revision-queue.ts'
import { chapterContentSha256 } from '../src/chapter-revision.ts'
import { seedMainTaskPlanningProject } from './fixtures/main-task-planning-loop.ts'
import { validateWritingCapability } from '../src/bid-writing-capability.ts'

const disposals: Array<() => Promise<void>> = []

it('真实模型验收初始章节具有完整采购条款、评分来源及当前审核身份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bid-main-source-facts-'))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const workspace = await seedMainTaskPlanningProject(root, true)
  const requirements = JSON.parse(await readFile(join(workspace.projectRoot, 'analysis/requirements.json'), 'utf8')) as {
    requirements: Array<{ raw_text: string; source_refs: Array<{ file_id: string }> }>
  }
  const first = requirements.requirements[0]!
  expect(first.raw_text).toContain('收集输入、校验结果、交付成果')
  const manifest = await workspace.readManifest()
  expect(manifest.files.find(file => String(file.id) === first.source_refs[0]?.file_id)?.role).toBe('tender')
  await expect(validateWritingCapability({ working: workspace }, ['S2.3'])).resolves.toBeUndefined()
})
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bid-main-task-'))
  const ctx = new Context()
  disposals.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  const workspace = new BidWorkspace(root)
  await seedCapabilityProject(workspace, 'complete')
  const session = ctx.sessions.create()
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '开始处理当前全部待处理审批意见。' }] })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  const markdown = await readFile(join(workspace.projectRoot, 'chapters/sections/0001.md'), 'utf8')
  const text = '流程一：收集输入。'
  const start = markdown.indexOf(text)
  const queue = addRevisionIssue(await readRevisionQueue(workspace), {
    section_id: 'SEC-1', scope: 'paragraphs', reference: { scope: 'paragraphs',
      base_content_sha256: chapterContentSha256(markdown), start, end: start + text.length, text },
    instruction: '这里的任务每个阶段其实可以单独做成小章节的', suggestion: null,
  }, '章节1', Date.now())
  await writeRevisionQueue(workspace, queue)
  const issue = queue.issues[0]!
  const reference = { scope: 'paragraphs' as const, section_id: issue.section_id,
    content_sha256: chapterContentSha256(markdown), start, end: start + text.length, text }
  return { workspace, session, message, issue, reference }
}

it('冻结真实意见原话及选区，目标摘要不能替代来源', async () => {
  const { workspace, session, message, issue, reference } = await fixture()
  const task = bidCapabilityTaskSchema.parse({ goal: '将阶段改为分项说明', issue_ids: [issue.issue_id],
    scope: { kind: 'paragraphs', reference }, steps: [{ description: '改写阶段分项', scope: { source: 'task' },
      call: { capability: 'chapter.revise', input: { instruction: '改写阶段分项', reference } } }] })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
    { session_id: String(session.id), message_id: String(message.id) }, [],
    { stage: 'chapter_writing', status: 'completed', run: null })
  expect(await readBidWorkRequest(workspace, work)).toMatchObject({ source_snapshot: {
    message: { text: '开始处理当前全部待处理审批意见。' }, issues: [{ instruction: issue.instruction,
      scope: 'paragraphs', reference: issue.reference }],
  } })
})

it('S3 没有确认目录时返回真实草稿及 artifact', async () => {
  const { workspace } = await fixture()
  const outline = JSON.parse(await readFile(join(workspace.projectRoot, 'outline/confirmed-outline.json'), 'utf8')) as unknown
  const { outlineArtifactSha256 } = await import('../src/outline-confirmation-artifacts.ts')
  const { parseOutlineArtifact } = await import('../src/outline-generation-artifacts.ts')
  const hash = outlineArtifactSha256(parseOutlineArtifact(outline))
  await writeFile(join(workspace.projectRoot, 'outline/draft.json'), JSON.stringify({ schema_version: 1,
    scope: 'technical_bid', revision: 1, outline, source_outline_sha256: hash, draft_outline_sha256: hash }))
  await rm(join(workspace.projectRoot, 'outline/confirmed-outline.json'))
  expect(await inspectBidProject(workspace, { object: 'outline', page: 0 })).toMatchObject({
    available: true, artifact: 'outline/draft.json', page: 0,
  })
})

import { vi } from 'vitest'
import { executeCapabilityTask, capabilityTaskCheckpointSchema, capabilityTaskRequestSchema,
  patchCapabilityTaskSteps } from '../src/bid-capability-task.ts'
import { executorTestVerifier } from './fixtures/task-verifier.ts'
import { createTestBidRunContext } from '../src/run-coordinator.ts'
import { readCapabilityPublicationReceipt, publishCapabilityChanges } from '../src/bid-capability-changes.ts'
import { checkpointBidProjectState } from '../src/index.ts'
import { prepareBidWorkingTree } from '../src/working-tree.ts'
import { collectBidTaskEvidence, collectBidTaskScopeEvidence, collectBidTaskPreservationEvidence,
  validateBidTaskVerification, type BidTaskVerifier } from '../src/bid-task-verification.ts'

const falseSatisfied = '当前正文已将主流程拆分为受理、资料核验、分派、外业、内业、复核、提交整改、归档等清晰阶段，并进一步以节点表逐项展开输入处理、输出记录、责任岗位及放行条件；各阶段已形成便于独立阅读的小节式分项结构，落实了将各阶段分别展开的意见。'

it('范围外核验读取真实基线和候选摘要，并拒绝核验器忽略的正文变更', async () => {
  const { workspace, session, message } = await fixture()
  const task = bidCapabilityTaskSchema.parse({ goal: '审核第一章', scope: { kind: 'sections', section_ids: ['SEC-1'] },
    steps: [{ description: '审核第一章', scope: { source: 'task' }, call: { capability: 'chapter.review', input: { reason: '审核第一章' } } }] })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
    { session_id: String(session.id), message_id: String(message.id) }, [],
    { stage: 'chapter_writing', status: 'completed', run: null })
  const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work))
  const working = new BidWorkspace((await prepareBidWorkingTree(workspace, work)).root, workspace.config)
  const unchanged = await collectBidTaskScopeEvidence(workspace, working, task)
  expect(unchanged.every(item => item.before_sha256 === item.after_sha256)).toBe(true)
  expect(unchanged.some(item => item.section_id === 'SEC-1')).toBe(false)
  const projectEvidence = await collectBidTaskScopeEvidence(workspace, working, { ...task, scope: { kind: 'project' } })
  expect(projectEvidence.some(item => item.section_id === 'SEC-1' && item.object === 'outline')).toBe(true)
  expect(projectEvidence.every(item => !item.outside_scope && item.before_sha256 === item.after_sha256)).toBe(true)
  const unchangedInput = { phase: 'result' as const, task, source: request.source_snapshot!,
    evidence: await collectBidTaskEvidence(working, task, []), scope_evidence: unchanged }
  const unchangedDecision = await executorTestVerifier(unchangedInput, {} as Parameters<BidTaskVerifier>[1], new AbortController().signal)
  const outside = unchanged.find(item => item.object === 'chapters/sections/0002.md')!
  expect(unchangedInput.evidence.some(item => item.path === outside.object)).toBe(false)
  unchangedDecision.checks[0]!.evidence = [{ path: outside.object, sha256: outside.after_sha256! }]
  expect(await validateBidTaskVerification(unchangedInput, unchangedDecision, workspace, working)).toMatchObject({ goal_met: true })
  unchangedDecision.checks[0]!.evidence = [{ path: outside.object }]
  const bound = await validateBidTaskVerification(unchangedInput, unchangedDecision, workspace, working)
  expect(bound.checks[0]!.evidence).toEqual([{ path: outside.object, sha256: outside.after_sha256 }])
  unchangedDecision.checks[0]!.evidence = [{ path: outside.object, sha256: '0'.repeat(64) }]
  await expect(validateBidTaskVerification(unchangedInput, unchangedDecision, workspace, working))
    .rejects.toThrow('BID_TASK_VERIFICATION_EVIDENCE_INVALID')
  unchangedDecision.checks[0]!.evidence = [{ path: 'scope_evidence/SEC-2/' + outside.object, sha256: outside.after_sha256! }]
  await expect(validateBidTaskVerification(unchangedInput, unchangedDecision, workspace, working))
    .rejects.toThrow('BID_TASK_VERIFICATION_EVIDENCE_INVALID')
  await writeFile(join(working.projectRoot, 'chapters/sections/0002.md'), '未经授权的新正文\n')
  const input = { phase: 'result' as const, task, source: request.source_snapshot!,
    evidence: await collectBidTaskEvidence(working, task, []),
    scope_evidence: await collectBidTaskScopeEvidence(workspace, working, task) }
  expect(input.scope_evidence.find(item => item.object === 'chapters/sections/0002.md'))
    .toMatchObject({ section_id: 'SEC-2', before_sha256: unchanged.find(item => item.object === 'chapters/sections/0002.md')!.before_sha256 })
  const decision = await executorTestVerifier(input, {} as Parameters<BidTaskVerifier>[1], new AbortController().signal)
  const verified = await validateBidTaskVerification(input, decision, workspace, working)
  expect(verified.goal_met).toBe(false)
  expect(verified.unmet).toContain('范围外既有章节的目录或文件发生变化。')
})

const structureVerifier: BidTaskVerifier = async input => ({
  scope_authorized: true,
  relevant_issue_ids: input.source.issues.map(issue => issue.issue_id),
  requirements: [...(input.requirements ?? [input.source.message.message_id,
    ...input.source.issues.map(issue => issue.issue_id)].map(source_id => ({
    source_id, description: '将流程阶段建立为真实目录子章节',
    object: 'outline' as const, section_ids: ['SEC-1'], new_children: true,
    completed_content: false, repair: false, preserve_migrated_content: false,
  })))],
  checks: (input.requirements ?? [input.source.message, ...input.source.issues]).map((_, requirement_index) => ({
    requirement_index, met: true, reason: falseSatisfied,
    evidence: input.evidence.filter(file => file.path === 'outline/confirmed-outline.json')
      .map(({ path, sha256 }) => ({ path, sha256 })),
  })),
})

it.each(['表1 校验产物', '流程一：收集输入。', '流程图定义'])('原文保留要求不接受语义核验漏掉的原块改写：%s', async (changed) => {
  const { workspace, session } = await fixture()
  const sourcePath = join(workspace.projectRoot, 'chapters/sections/0001.md')
  const original = (await readFile(sourcePath, 'utf8')) + '\n\n表1 校验产物\n\n| 步骤 | 产物 |\n| --- | --- |\n| 校验 | 报告 |\n'
  await writeFile(sourcePath, original)
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '拆分本章时保留原文、原表题和表格。' }] })
  session.append('user/message', message, { surfaceOp: 'append' })
  const task = bidCapabilityTaskSchema.parse({ goal: '核验原文保留', scope: { kind: 'sections', section_ids: ['SEC-1'] },
    steps: [{ description: '核验原文保留', scope: { source: 'task' }, call: { capability: 'chapter.review', input: { reason: '原文保留事实测试' } } }] })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
    { session_id: String(session.id), message_id: String(message.id) }, [], { stage: 'chapter_writing', status: 'completed', run: null })
  const source = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work)).source_snapshot!
  const working = new BidWorkspace((await prepareBidWorkingTree(workspace, work)).root, workspace.config)
  const verify = async () => {
    const input = { phase: 'result' as const, source, task, evidence: await collectBidTaskEvidence(working, task, []),
      preservation_evidence: { retained: true, missing: [] } }
    const decision = await executorTestVerifier(input, {} as Parameters<BidTaskVerifier>[1], new AbortController().signal)
    decision.requirements[0] = { ...decision.requirements[0]!, object: 'content', section_ids: ['SEC-1'], preserve_migrated_content: true }
    return validateBidTaskVerification(input, decision, workspace, working)
  }
  expect(await verify()).toMatchObject({ goal_met: true })
  expect(await collectBidTaskPreservationEvidence(workspace, working, task)).toEqual({ retained: true, missing: [] })
  if (changed === '流程图定义') {
    const metadataPath = join(working.projectRoot, 'chapters/meta/0001.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { flowcharts: Array<{ nodes: Array<{ text: string }> }> }
    metadata.flowcharts[0]!.nodes[0]!.text = '改变后的流程节点'
    await writeFile(metadataPath, JSON.stringify(metadata))
  } else await writeFile(join(working.projectRoot, 'chapters/sections/0001.md'), original.replace(changed, '改写后的内容'))
  const rejected = await verify()
  expect(await collectBidTaskPreservationEvidence(workspace, working, task)).toMatchObject({ retained: false })
  expect(rejected.goal_met).toBe(false)
  expect(rejected.unmet.some(message => message.startsWith(changed === '流程图定义' ? '迁移流程图定义未保留' : '迁移原文块未逐字保留'))).toBe(true)
})

it('历史段落小章节意见即使核验器给 satisfied 也不越权、不执行、不关闭', async () => {
  const { workspace, session, message, issue, reference } = await fixture()
  const task = bidCapabilityTaskSchema.parse({ goal: '分项说明', issue_ids: [issue.issue_id],
    scope: { kind: 'paragraphs', reference }, steps: [{ description: '分项说明',
      scope: { source: 'task' }, call: { capability: 'chapter.revise', input: { instruction: '分项说明', reference } } }] })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
    { session_id: String(session.id), message_id: String(message.id) }, [],
    { stage: 'chapter_writing', status: 'completed', run: null })
  const execute = vi.fn()
  await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), {
    verifyTask: structureVerifier, allowedWrites: async () => new Set(), execute, validate: async () => {},
  }, {} as Parameters<typeof executeCapabilityTask>[3], session)).rejects.toMatchObject({
    code: 'BID_TASK_SCOPE_AUTHORIZATION_REQUIRED',
  })
  expect(execute).not.toHaveBeenCalled()
  expect((await readRevisionQueue(workspace)).issues[0]?.status).toBe('pending')
  expect(await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256)).toBeNull()
})

it('结构计划全步骤成功但无真实子节点时拒绝正式 publication，保留已完成前缀', async () => {
  const { workspace, session } = await fixture()
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
    text: '只修改本章，将流程各阶段拆成真实目录子章节，保留原文。' }] })
  session.append('user/message', message, { surfaceOp: 'append' })
  const task = bidCapabilityTaskSchema.parse({ goal: '流程分项', scope: { kind: 'sections', section_ids: ['SEC-1'] },
    steps: [{ description: '修改目录', scope: { source: 'task' }, call: { capability: 'outline.update', input: {
      operations: [{ type: 'update_section', section_id: 'SEC-1', title: '阶段分项' }],
    } } }] })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
    { session_id: String(session.id), message_id: String(message.id) }, [],
    { stage: 'chapter_writing', status: 'completed', run: null })
  await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), {
    verifyTask: structureVerifier, allowedWrites: async () => new Set(),
    execute: async () => ({ result: { target_section_ids: ['SEC-1'], changed_artifacts: [],
      change_summary: '阶段分项和节点表已满足意见', warnings: [], missing_topics: [], needs_input: false } }),
    validate: async () => {},
  }, {} as Parameters<typeof executeCapabilityTask>[3], session)).rejects.toMatchObject({ code: 'BID_TASK_RESULT_UNMET' })
  const checkpoint = capabilityTaskCheckpointSchema.parse(JSON.parse(await readFile(join(workspace.projectRoot,
    'runs/' + work.workId + '/task-checkpoint.json'), 'utf8')))
  expect(checkpoint.steps.map(step => step.status)).toEqual(['completed'])
  expect(checkpoint.verifications?.at(-1)).toMatchObject({ goal_met: false, phase: 'result' })
  expect(await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256)).toBeNull()
})

it('任务产物漏项可在同一 Work 末尾追加，不重跑完成前缀，结束后按 ID 查证', async () => {
  const { workspace, session } = await fixture()
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '审核章节和整书。' }] })
  session.append('user/message', message, { surfaceOp: 'append' })
  const task = bidCapabilityTaskSchema.parse({ goal: '审核章节和整书', scope: { kind: 'project' },
    steps: [{ description: '审核章节', scope: { source: 'task' }, call: { capability: 'chapter.review', input: { reason: '审核章节' } } }] })
  const authorization = { session_id: String(session.id), message_id: String(message.id) }
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task, authorization, [],
    { stage: 'chapter_writing', status: 'completed', run: null })
  const verifier: BidTaskVerifier = async (...args) => {
    const decision = await executorTestVerifier(...args)
    if (args[0].phase === 'result' && args[0].task.steps.length === 1) {
      decision.checks[0]!.met = false
      decision.checks[0]!.reason = '全书报告未形成'
    }
    return decision
  }
  const execute = vi.fn(async () => ({ result: { target_section_ids: [], changed_artifacts: [],
    change_summary: '审核完成', warnings: [], missing_topics: [], needs_input: false } }))
  const dispatcher = { verifyTask: verifier, allowedWrites: async () => new Set<string>(), execute, validate: async () => {} }
  const run = createTestBidRunContext({ work })
  const agent = {} as Parameters<typeof executeCapabilityTask>[3]
  await expect(executeCapabilityTask(workspace, run, dispatcher, agent, session)).rejects.toMatchObject({ code: 'BID_TASK_RESULT_UNMET' })
  const request = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work))
  const working = new BidWorkspace((await prepareBidWorkingTree(workspace, work)).root, workspace.config)
  await patchCapabilityTaskSteps(run, workspace, working, request, session, authorization, 1,
    [{ description: '补齐全书审核报告', scope: { source: 'task' }, call: { capability: 'document.review', input: { reason: '补齐全书报告' } } }])
  expect(await executeCapabilityTask(workspace, createTestBidRunContext({ work }), dispatcher, agent, session))
    .toMatchObject({ status: 'completed', receipt: { goal_met: true } })
  expect(execute).toHaveBeenCalledTimes(2)
  await checkpointBidProjectState(workspace, { stage: 'chapter_writing', status: 'completed', run: null })
  expect(await inspectBidProject(workspace, { object: 'task', work_id: work.workId })).toMatchObject({
    available: true, data: { capability_task: { work_id: work.workId, goal_met: true, completed_prefix: 2 } },
  })
})

it('生产路径缺少隔离核验服务不能静默成功', async () => {
  const { workspace, session, message } = await fixture()
  const task = bidCapabilityTaskSchema.parse({ goal: '审核', scope: { kind: 'project' }, steps: [{
    description: '审核', scope: { source: 'task' }, call: { capability: 'chapter.review', input: { reason: '审核' } },
  }] })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
    { session_id: String(session.id), message_id: String(message.id) }, [],
    { stage: 'chapter_writing', status: 'completed', run: null })
  const execute = vi.fn()
  await expect(executeCapabilityTask(workspace, createTestBidRunContext({ work }), {
    allowedWrites: async () => new Set(), execute, validate: async () => {},
  }, { ctx: { get: () => undefined } } as unknown as Parameters<typeof executeCapabilityTask>[3], session))
    .rejects.toThrow('BID_TASK_VERIFIER_UNAVAILABLE')
  expect(execute).not.toHaveBeenCalled()
})

it.each(['新增意见', '修改来源'] as const)('已核验任务发布对最新队列执行原子结算：%s', async (change) => {
  const { workspace, session, message, issue, reference } = await fixture()
  const task = bidCapabilityTaskSchema.parse({ goal: '发布已核验结果', issue_ids: [issue.issue_id],
    scope: { kind: 'project' }, steps: [{ description: '审核意见对应正文', scope: { source: 'task' },
      call: { capability: 'chapter.review', input: { reason: '发布层受控核验夹具' } } }] })
  const work = await persistCapabilityTaskRequest(workspace, session, 'chapter_writing', task,
    { session_id: String(session.id), message_id: String(message.id) }, [],
    { stage: 'chapter_writing', status: 'completed', run: null })
  const source = capabilityTaskRequestSchema.parse(await readBidWorkRequest(workspace, work)).source_snapshot!
  const input = { phase: 'result' as const, source, task, evidence: await collectBidTaskEvidence(workspace, task, []) }
  const agent = {} as Parameters<BidTaskVerifier>[1]
  const verification = await validateBidTaskVerification(input,
    await executorTestVerifier(input, agent, new AbortController().signal), workspace, workspace)
  const queue = await readRevisionQueue(workspace)
  if (change === '新增意见') {
    const { section_id: _section, content_sha256, ...selected } = reference
    await writeRevisionQueue(workspace, addRevisionIssue(queue, { section_id: issue.section_id,
      scope: 'paragraphs', reference: { ...selected, base_content_sha256: content_sha256 },
      instruction: '接纳后新增的独立意见', suggestion: null }, '章节1', Date.now()))
  } else await writeRevisionQueue(workspace, { ...queue, revision: queue.revision + 1,
    issues: queue.issues.map(item => ({ ...item, instruction: '接纳后修改了原意见' })) })
  const run = createTestBidRunContext({ work })
  const publication = publishCapabilityChanges(run, workspace, workspace, [], [], { source, verification })
  if (change === '修改来源') {
    await expect(publication).rejects.toMatchObject({ code: 'BID_TASK_SOURCE_ISSUE_CHANGED' })
    expect(await readCapabilityPublicationReceipt(workspace, work.workId, work.requestSha256)).toBeNull()
    expect((await readRevisionQueue(workspace)).issues[0]?.status).toBe('pending')
  } else {
    expect(await publication).toMatchObject({ goal_met: true,
      issue_results: [{ issue_id: issue.issue_id, target_section_ids: [issue.section_id], work_id: work.workId }] })
    expect((await readRevisionQueue(workspace)).issues.map(item => item.status)).toEqual(['completed', 'pending'])
  }
})
