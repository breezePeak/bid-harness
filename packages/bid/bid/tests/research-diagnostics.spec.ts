import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { deriveResearchDiagnostics, observeResearchTool } from '../src/research-diagnostics.ts'

const successful = (value: unknown): ToolExecutionResult => ({ isError: false, value: value as never, content: [] })
const execution = (name: string, args: unknown): ToolExecution => ({
  callId: CallId(`call-${name}`), name, arguments: args,
} as ToolExecution)
const assessment = { evidence_requirement: { kind: 'not_required' as const, reason: '本章按招标要求提出方案，不需证明外部事实。' },
  sufficient_for_blueprint: true, unresolved_gaps: [] }

describe('研究执行与引用交接诊断', () => {
  it('模型充分性文字不能生成搜索或读取事实；合理无需资料仍可解释零引用', () => {
    expect(deriveResearchDiagnostics([], undefined)).toMatchObject({ status: 'not_started', searches: 0, read: 0, displayed: 0 })
    expect(deriveResearchDiagnostics([], assessment)).toMatchObject({ status: 'not_required', requirement: assessment.evidence_requirement, searches: 0 })
  })
  it('真实查询空结果与抓取故障保存具体原因和原始字段', () => {
    const search = observeResearchTool(execution('web_search', { queries: ['正式标准'] }), successful({ sources: [] }))
    expect(deriveResearchDiagnostics([search], undefined)).toMatchObject({ status: 'search_empty', queries: ['正式标准'], searches: 1 })
    const failedSearch = observeResearchTool(execution('web_search', { queries: ['正式标准'] }), {
      isError: true, error: { message: '认证失败', info: { name: 'WebError', code: 'WEB_PROVIDER_AUTHENTICATION_FAILED', statusCode: 401 } }, content: [],
    })
    expect(deriveResearchDiagnostics([failedSearch], undefined)).toMatchObject({ status: 'search_failed', failure_reasons: ['认证失败'] })
    expect(deriveResearchDiagnostics([failedSearch, search], undefined)).toMatchObject({ status: 'search_empty' })
    const fetch = observeResearchTool(execution('web_fetch', { url: 'https://example.com/standard' }), {
      isError: true, error: { message: '原始限流', info: { name: 'WebError', code: 'WEB_PROVIDER_RATE_LIMITED', statusCode: 429, retryAfter: '12' } }, content: [],
    })
    expect(fetch.error_info).toMatchObject({ code: 'WEB_PROVIDER_RATE_LIMITED', statusCode: 429, retryAfter: '12' })
    expect(deriveResearchDiagnostics([search, fetch], undefined)).toMatchObject({ status: 'fetch_failed', failure_reasons: ['原始限流'], fetched: 0 })
  })
  it('搜索、保存、读取、采用、绑定和显示分别对账，缺失交接不能冒充已展示', () => {
    const ref = 'W:WEB-0000000000000001:C0001'
    const events = [
      observeResearchTool(execution('web_search', { queries: ['审计标准'] }), successful({ sources: [{ url: 'https://example.com/standard' }] })),
      observeResearchTool(execution('web_fetch', {}), successful({ source_ref: 'W:WEB-0000000000000001' })),
    ]
    expect(deriveResearchDiagnostics(events, undefined)).toMatchObject({ status: 'saved_unbound', fetched: 1, read: 0, bound: 0 })
    events.push(observeResearchTool(execution('read_source', {}), successful({ chunk_ref: ref, body: '实际标准条款。' })))
    expect(deriveResearchDiagnostics(events, { ...assessment, sufficient_for_blueprint: false,
      excluded_materials: [{ material_ref: ref, reason: '本条只适用于其他系统。' }] })).toMatchObject({
      status: 'read_excluded', read: 1, exclusions: [{ reason: '本条只适用于其他系统。' }], adopted: 0,
    })
    expect(deriveResearchDiagnostics(events, undefined, [ref], [], [])).toMatchObject({ status: 'saved_unbound', adopted: 1, bound: 0 })
    expect(deriveResearchDiagnostics(events, undefined, [ref], [ref], [])).toMatchObject({ status: 'display_omitted', bound: 1, displayed: 0 })
    expect(deriveResearchDiagnostics(events, undefined, [ref], [ref], [ref])).toMatchObject({ status: 'bound', searches: 1,
      candidate_urls: ['https://example.com/standard'], fetched: 1, read: 1, adopted: 1, bound: 1, displayed: 1 })
  })
  it('本地充分性只采信实际正文与程序绑定的文件分块', () => {
    const reading = observeResearchTool(execution('read_source', {}), successful({ file_id: 'FILE-LOCAL', body: '实施方法原文。', materials: [{ chunk: 'chunk_0001' }] }))
    const local = { ...assessment, evidence_requirement: { kind: 'local_sufficient' as const, reason: '该实施方法已有本地技术说明。' } }
    expect(deriveResearchDiagnostics([], local)).toMatchObject({ status: 'not_started', read: 0 })
    expect(deriveResearchDiagnostics([reading], local)).toMatchObject({ status: 'local_sufficient', read: 1, searches: 0 })
    expect(reading.read_refs).toEqual(['L:FILE-LOCAL:chunk_0001'])
  })
})
