/** 原目录授权身份到本 Work 当前章节的解析；退役记录不能扩大原任务范围。 */
import { readFile } from 'node:fs/promises'
import type { BidWorkspace } from './index.ts'
import type { BidCapabilityTask } from './bid-capability-contract.ts'
import { readCapabilityOutlineBaseline } from './outline-draft-store.ts'
import { outlineReassignmentSchema } from './outline-capability-update.ts'
import { outlineArtifactSha256 } from './outline-confirmation-artifacts.ts'
import { outlineSectionScope } from './section-evidence-context.ts'
import { assertNoLinkedPath, within } from './workspace-path.ts'

/**
 * 将原授权节点解析为当前节点及子树，合并保留原来源身份用于审计。
 * @param canonical 接纳任务时的正式目录。
 * @param working 本 Work 候选目录及退役记录。
 * @param task 原范围与有效结构计划。
 * @param roots 需要核对的原始节点。
 * @returns 当前目录范围；合法删除可以没有结果节点，未知或越权迁移拒绝。
 */
export async function resolveBidTaskSections(canonical: BidWorkspace, working: BidWorkspace,
  task: BidCapabilityTask, roots: readonly string[]): Promise<Set<string>> {
  const before = (await readCapabilityOutlineBaseline(canonical)).outline
  const after = (await readCapabilityOutlineBaseline(working)).outline
  const beforeIds = new Set(before.sections.map(section => section.id))
  const original = outlineSectionScope(before, roots.filter(id => beforeIds.has(id)))
  const allowed = task.scope.kind === 'project' ? new Set(before.sections.map(section => section.id))
    : outlineSectionScope(before, task.scope.kind === 'sections' ? task.scope.section_ids : [task.scope.reference.section_id])
  if ([...original].some(id => !allowed.has(id))) throw new Error('BID_CAPABILITY_SCOPE_ESCALATION')
  const known = new Set(after.sections.map(section => section.id))
  const currentAllowed = task.scope.kind === 'project' ? known
    : outlineSectionScope(after, [...allowed].filter(id => known.has(id)))
  if (roots.some(id => !beforeIds.has(id) && !currentAllowed.has(id))) throw new Error('BID_SECTION_SCOPE_INVALID')
  let reassignment: ReturnType<typeof outlineReassignmentSchema.parse> | undefined
  const path = within(working.projectRoot, 'outline/reassignment.json')
  await assertNoLinkedPath(working.root, path)
  let raw: string | undefined
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (raw !== undefined) reassignment = outlineReassignmentSchema.parse(JSON.parse(raw))
  const resultRoots: string[] = []
  for (const id of roots) {
    if (known.has(id)) { resultRoots.push(id); continue }
    const operation = task.steps.flatMap(step => step.call.capability === 'outline.update' ? step.call.input.operations : [])
      .find(item => item.type === 'merge_sections' ? item.section_ids.includes(id)
        : item.type === 'delete_section' && outlineSectionScope(before, [item.section_id]).has(id))
    const retired = reassignment?.retired_sections.find(item => item.source_section_id === id)
    if (operation === undefined || retired === undefined
      || reassignment?.confirmed_outline_sha256 !== outlineArtifactSha256(after)
      || retired.target_section_ids.some(target => !known.has(target) || !currentAllowed.has(target))
      || operation.type === 'merge_sections' && (retired.target_section_ids.length === 0
        || operation.section_ids[0] === undefined || !retired.target_section_ids.includes(operation.section_ids[0]))) {
      throw new Error('BID_SECTION_SCOPE_INVALID')
    }
    resultRoots.push(...retired.target_section_ids)
  }
  return outlineSectionScope(after, [...new Set(resultRoots)])
}
