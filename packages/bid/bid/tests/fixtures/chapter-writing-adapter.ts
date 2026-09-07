/** S5 包测试与 Loader 会话回放共用的外部模型脚本。 */
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ChapterReviewItem } from '../../src/chapter-writing-review.ts'

function call(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(name), name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function text(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

const quality = {
  project_specific: true, structure_complete: true, legacy_project_pollution_free: true,
  placeholder_free: true, obvious_repetition_free: true,
}

/** 只替换模型：工具、Child 创建、错误归一化、取消和落盘均运行真实实现。 */
export class ChapterAdapter extends LlmAdapter {
  readonly requests = new Map<string, { role: 'plan' | 'writer' | 'review'; tools: string[]; steps: number; sectionId?: string }>()
  writerMetadata?: (sectionId: string, step: number) => object
  repairReviews = Infinity
  failWriterStep?: number
  omitRepairSubmission = false
  reviewPreamble = true
  onReview?: () => void
  constructor(private readonly cancelWriter?: () => void, private readonly omitReviewFinish = false) { super() }
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = options.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const role = options.sessionId === 'parent' ? 'plan' : prompt.includes('Review Checklist：') ? 'review' : 'writer'
    let entry = this.requests.get(String(options.sessionId))
    if (entry === undefined) {
      entry = { role, tools: (options.tools ?? []).map(tool => tool.name).sort(), steps: 0 }
      this.requests.set(String(options.sessionId), entry)
      for (const tool of options.tools ?? []) assertSupportedJsonSchema(tool.parameters)
    }
    const step = entry.steps++
    if (step > 8) throw new Error(`script exceeded bound: ${role}`)
    if (role === 'plan') {
      yield* step === 0 ? call('add_global_consistency_note', { note: '统一接口与审计术语。' }) : call('finish_chapter_plan', {})
      return
    }
    const blueprintLine = prompt.split('\n').find(line => line.startsWith('Current Chapter Blueprint：'))!
    const section = JSON.parse(blueprintLine.slice('Current Chapter Blueprint：'.length)) as { id: string }
    entry.sectionId = section.id
    if (role === 'writer') {
      this.cancelWriter?.()
      if (section.id === 'SEC-1' && step === this.failWriterStep) throw new Error('暂时的模型传输错误')
      if (this.omitRepairSubmission && step >= 2) { yield* text('已完成修改。'); return }
      const markdown = `# ${section.id}\n\n${prompt.includes('这是同一章节 Writer 的修复轮次') ? '修复候选' : '首次候选'}：本章具体说明技术措施、责任接口与成果交付，逐项核查要求并形成可追溯的审计记录。`
      yield* call('submit_chapter', { markdown, metadata: this.writerMetadata?.(section.id, step) ?? (step === 0 ? { local_materials_used: [{ material_ref: 'M999', usage: 'reference', summary: '错误短引用' }] } : {}) })
      return
    }
    this.onReview?.()
    if (this.omitReviewFinish) { yield* text('审查已经完成，无需工具。'); return }
    const checklistLine = prompt.split('\n').find(line => line.startsWith('Review Checklist：'))!
    const items = JSON.parse(checklistLine.slice('Review Checklist：'.length)) as ChapterReviewItem[]
    const covered = (item: ChapterReviewItem) => ({ item_ref: item.item_ref, status: 'covered', evidence_quote_refs: ['Q2'], issue: null })
    switch (step) {
      case 0: yield* this.reviewPreamble ? text('审查已完成。') : call('finish_chapter_review', {}); break
      case 1: yield* call('review_coverage_items', { items: [covered(items.at(-1)!)] }); break
      case 2: yield* call('finish_chapter_review', {}); break
      case 3: yield* call('review_coverage_items', { items: [...items].reverse().map(item => section.id === 'SEC-1' && item.item_ref === 'R1'
        && [...this.requests.values()].filter(request => request.role === 'review' && request.sectionId === section.id).length <= this.repairReviews
        ? { item_ref: item.item_ref, status: 'missing', evidence_quote_refs: [], issue: '缺少适用的实际设备数量依据。' } : covered(item)) }); break
      case 4: yield* call('set_review_summary', { quality_checks: quality, blocking_issues: [] }); break
      case 5: yield* call('finish_chapter_review', {}); break
      default: throw new Error('Reviewer finish did not conclude the turn')
    }
  }
}
