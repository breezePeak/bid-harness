/** S4 与 S5 共用的真实 Web fetch 正文快照转换。 */
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { normalizeWebEvidenceUrl, webEvidenceContentSha256, webEvidenceSourceId, type WebEvidenceSource } from './web-evidence-source-artifacts.ts'

/** 当前 Child 工具执行完成时捕获的结果，不依赖 Session 事件序号。 */
export interface CapturedWebResult {
  readonly exec: Readonly<ToolExecution>
  readonly result: Readonly<ToolExecutionResult>
}

/** 成功 fetch 的正文及其持久化来源。 */
export interface WebEvidenceSnapshot {
  readonly source: WebEvidenceSource
  readonly content: string
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined
}

/**
 * 从成功 HTTP(S) fetch 的非空正文生成快照；搜索结果与调用日志不参与判定。
 * @param captured - 当前 Child 的真实工具结果。
 * @returns 按 URL 与正文哈希去重的快照，失败或空正文被忽略。
 */
export function buildWebEvidenceSnapshots(captured: Iterable<CapturedWebResult>): WebEvidenceSnapshot[] {
  const snapshots = new Map<string, WebEvidenceSnapshot>()
  for (const { exec, result } of captured) {
    if (exec.name !== 'web_fetch' || result.isError) continue
    const fetched = record(result.value)
    const body = record(fetched?.body)
    const args = record(exec.arguments)
    if (typeof fetched?.url !== 'string' || normalizeWebEvidenceUrl(fetched.url) === undefined
      || typeof fetched.statusCode !== 'number' || !Number.isInteger(fetched.statusCode)
      || fetched.statusCode < 200 || fetched.statusCode >= 300
      || typeof body?.content !== 'string' || body.content.trim().length === 0) continue
    const requestedUrl = typeof args?.url === 'string' && normalizeWebEvidenceUrl(args.url) !== undefined ? args.url : fetched.url
    const content = body.content
    const hash = webEvidenceContentSha256(content)
    const id = webEvidenceSourceId(fetched.url, hash)
    snapshots.set(id, {
      content,
      source: {
        source_id: id, requested_url: requestedUrl, final_url: fetched.url,
        status_code: fetched.statusCode, truncated: fetched.truncated === true,
        fetched_at: new Date().toISOString(), content_sha256: hash,
        snapshot_path: `analysis/web-sources/${id}.md`,
      },
    })
  }
  return [...snapshots.values()]
}
