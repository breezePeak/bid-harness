/** S5 关系草稿由模型判断，完整计划由 Host 按确认目录组装。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { buildWritableSectionWorklist } from './section-evidence-context.ts'
import type { OutlineArtifact } from './outline-generation-artifacts.ts'
import {
  CHAPTER_EXECUTION_SCHEMA_VERSION, parseChapterExecutionPlan, validateChapterExecutionPlan,
  type ChapterExecutionPlan,
} from './chapter-writing-plan-artifacts.ts'
import { chapterToolArgs, createChapterProtocol, type ChapterProtocol } from './chapter-writing-protocol.ts'

/** 仅在当前 planning Agent 注册。 */
export const CHAPTER_PLAN_TOOLS = ['add_global_consistency_note', 'set_chapter_relations', 'finish_chapter_plan'] as const

const text = z.string().trim().min(1)
const relation = z.object({ section_id: text, reason: text }).strict()
const relations = z.object({
  section_id: text,
  depends_on: z.array(relation),
  related_sections: z.array(relation),
  planning_notes: z.array(text),
}).strict()
const relationParameter = {
  type: 'object', properties: { section_id: { type: 'string' }, reason: { type: 'string' } },
  required: ['section_id', 'reason'], additionalProperties: false,
}

/**
 * 预置全部可写章节，模型只需提交特殊关系及至少一项全局说明。
 * @param agent 当前规划 Agent。
 * @param outline 唯一确认目录。
 * @param outlineHash 当前目录 Hash。
 * @param maxContinuations 未 finish 的有限续行次数。
 * @returns 已确认计划及作用域工具的释放句柄。
 */
export function attachChapterPlan(
  agent: Agent, outline: OutlineArtifact, outlineHash: string, maxContinuations: number,
): ChapterProtocol<ChapterExecutionPlan> {
  const runtime = createChapterProtocol<ChapterExecutionPlan>(agent, 'finish_chapter_plan', maxContinuations)
  const sections = new Map<string, ChapterExecutionPlan['sections'][number]>(buildWritableSectionWorklist(outline).map(section => [section.id, {
    section_id: section.id, depends_on: [], related_sections: [], planning_notes: [],
  }]))
  const notes = new Set<string>()
  const assemble = (): ChapterExecutionPlan => ({
    schema_version: CHAPTER_EXECUTION_SCHEMA_VERSION, scope: 'technical_bid',
    confirmed_outline_sha256: outlineHash, global_consistency_notes: [...notes], sections: [...sections.values()],
  })
  try {
    runtime.register({
      name: 'add_global_consistency_note', description: '记录全书需要统一的真实术语、参数或方案要求；重复说明自动合并。',
      parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
      execute(args) {
        notes.add(chapterToolArgs(z.object({ note: text }).strict(), args).note)
        return Promise.resolve({ recorded: true, total_notes: notes.size })
      },
    })
    runtime.register({
      name: 'set_chapter_relations', description: '整体替换一个可写章节的强依赖、弱关联和规划说明。',
      parameters: {
        type: 'object', properties: {
          section_id: { type: 'string' },
          depends_on: { type: 'array', items: relationParameter },
          related_sections: { type: 'array', items: relationParameter },
          planning_notes: { type: 'array', items: { type: 'string' } },
        }, required: ['section_id', 'depends_on', 'related_sections', 'planning_notes'], additionalProperties: false,
      },
      execute(args) {
        const input = chapterToolArgs(relations, args)
        if (!sections.has(input.section_id)) throw new ToolArgsError([`section_id: 未知或不可写章节 ${input.section_id}。`])
        const draft = { ...input, related_sections: input.related_sections.map(item => ({ ...item, strength: 'weak' as const })) }
        const plan = assemble()
        plan.sections = plan.sections.map(section => section.section_id === input.section_id ? draft : section)
        const issues = validateChapterExecutionPlan(plan, outline, outlineHash).filter(issue => issue.code !== 'CHAPTER_PLAN_DEPENDENCY_CYCLE')
        if (issues.length > 0) throw new ToolArgsError(issues.map(issue => `${issue.path}: ${issue.message}`))
        sections.set(input.section_id, draft)
        return Promise.resolve({ recorded: true, section_id: input.section_id })
      },
    })
    runtime.register({
      name: 'finish_chapter_plan', description: '校验完整计划与强依赖 DAG；返回缺项或具体环路，通过后提交并结束规划。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute(args, exec) {
        chapterToolArgs(z.object({}).strict(), args)
        if (notes.size === 0) return Promise.resolve({ completed: false, issues: ['缺少 global_consistency_notes：请补充至少一项真实全书一致性要求。'] })
        const plan = parseChapterExecutionPlan(assemble())
        const issues = validateChapterExecutionPlan(plan, outline, outlineHash)
        return Promise.resolve(issues.length > 0 ? { completed: false, issues } : runtime.finish(exec, plan))
      },
    })
    return runtime
  } catch (error: unknown) {
    runtime.dispose()
    throw error
  }
}
