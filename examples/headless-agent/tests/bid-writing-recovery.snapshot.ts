/** 真实 Loader 应用的主会话通知、模型输出和私有审查会话回放。 */
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { bidInputFingerprint } from '../../../packages/bid/bid/src/work-descriptor.ts'

const fixtureDir = fileURLToPath(new URL('./bid-writing-recovery-snapshots/', import.meta.url))

function mainModelTrace(log: string): string {
  const types = new Set(['session', 'user/message', 'assistant/message', 'tool/call'])
  const records = log.trimEnd().split('\n').map(line => JSON.parse(line) as { type: string; data?: object })
  const notice = records.findLast(record => record.type === 'bid.run.notice'
    && (record.data as { kind: string }).kind === 'completed')?.data as { noticeId: string } | undefined
  // 凭据摘要包含随机授权消息身份；模型消息仍保留已核对的凭据通知类型和正文。
  const receiptSha256 = notice?.noticeId.split(':').at(-1)
  return `${records.filter(record => types.has(record.type)).map((record) => {
    const text = JSON.stringify(record)
    return receiptSha256 === undefined ? text : text.replaceAll(receiptSha256, '{{receiptSha256}}')
  }).join('\n')}\n`
}

it.each(['assignment-conflict', 'corrupt-format', 'saved-TIMEOUT', 'saved-TRANSPORT'])('%s 真实 Writer/Host 失败经 Main 纠正或明确阻断', async (scenario) => {
  const result = await runLoaderSmoke({
    label: `Bid 写作恢复 ${scenario}`, tempDirPrefix: 'dsh-bid-writing-recovery-snapshot-', mode: 'src', processTimeoutMs: 60_000,
    binScript: fileURLToPath(new URL('./fixtures/bid-writing-recovery-driver.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../bid-writing-recovery.cordis.snapshot.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { DSH_BID_WRITING_RECOVERY_SCENARIO: scenario },
    inspect: async (cwd) => {
      const metadata = JSON.parse(await readFile(join(cwd, 'recovery-snapshot.json'), 'utf8')) as { mainId: string; reviewerIds: string[] }
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const headers = logs.map(log => JSON.parse(log.split('\n')[0]!) as SessionHeader)
      const byId = new Map<string, string>(logs.map((log, index) => [headers[index]!.id, log]))
      const aliases = [...new Set([cwd, ...headers.flatMap(header => header.cwd === undefined ? [] : [header.cwd])])]
      const canonical = await realpath(cwd)
      const samePath = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
      for (const alias of aliases) expect(samePath(await realpath(alias))).toBe(samePath(canonical))
      const normalize = (log: string) => normalizeSessionSnapshot(log, { sessionIds: [...byId.keys()], cwd,
        cwdAliases: aliases.flatMap(alias => [alias, alias.replaceAll('\\', '/')]) })
      const mainLog = byId.get(metadata.mainId)!
      const events = mainLog.trimEnd().split('\n').map(line => JSON.parse(line) as { type: string; data?: object })
      const notice = events.findLast(event => event.type === 'bid.run.notice' && (event.data as { kind: string }).kind === 'completed')?.data as {
        workId: string
        noticeId: string
        resultRef: string
      } | undefined
      if (notice !== undefined) {
        const receipt = JSON.parse(await readFile(join(cwd, '.bid-harness', notice.resultRef), 'utf8')) as object
        expect(notice.noticeId).toBe(`work:${notice.workId}:completed:${bidInputFingerprint(receipt)}`)
      }
      const snapshots: Record<string, string> = { [`${scenario}-main.expected.jsonl`]: normalize(mainModelTrace(mainLog)) }
      for (const [index, id] of metadata.reviewerIds.entries()) snapshots[`${scenario}-reviewer-${index + 1}.expected.jsonl`] = normalize(byId.get(id)!)
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        for (const [name, content] of Object.entries(snapshots)) await writeFile(join(fixtureDir, name), content)
      }
      for (const [name, content] of Object.entries(snapshots)) expect(content).toBe(await readFile(join(fixtureDir, name), 'utf8'))
    },
  })
  const summary = JSON.parse(result.stdout) as Record<string, unknown>
  if (scenario.startsWith('saved-')) {
    expect(summary).toMatchObject({ questions: 1, noGoal: true, requestState: 'consumed', answer: '重点说明实施步骤。',
      planIncludesAnswer: true, originalFailure: true, recoveryRequests: 1, confirmCalls: 1, startedRuns: 1, planVersion: 1, finalStatus: 'completed',
      roundStates: ['scheduled', 'notified', 'executing', 'recovered'] })
    return
  }
  expect(summary).toMatchObject({ initial: { status: 'failed' }, questions: 0, noGoal: true, bodyPreservedAtFailure: true,
    bodyPreservedAfterSettlement: true, manifestPreservedAfterSettlement: true })
  if (scenario === 'assignment-conflict') expect(summary).toMatchObject({
    initial: { failure: { issues: [{ code: 'CHAPTER_WRITING_ASSIGNMENT_CONFLICT' }], recovery: { kind: 'repair' } } },
    finalStatus: 'completed', startedRuns: 2, sameWork: true, resumedOriginal: true,
    rounds: [[1, 'scheduled'], [1, 'notified'], [1, 'no_effect'], [2, 'scheduled'], [2, 'notified'], [2, 'executing'], [2, 'recovered']],
    recoveryRequests: 1, completedNotices: 1, calls: ['bid_stage_inspect', 'bid_recover_task'], revisionStatuses: ['completed'],
  })
  else expect(summary).toMatchObject({ initial: { failure: { code: 'BID_DOCX_FORMAT_CORRUPT', recovery: { kind: 'blocked' } } },
    finalStatus: 'failed', startedRuns: 1, recoveryRequests: 0, completedNotices: 0, calls: [], rounds: [[0, 'blocked']] })
}, 75_000)
