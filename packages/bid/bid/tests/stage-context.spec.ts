import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import {
  BID_STAGES,
  BidWorkspace,
  getBidStagePolicy,
  type BidStage,
} from '@deepseek-ai/dsh-bid'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareBidStageContextTransition, recoverOverflowedBidStageContext } from '../src/stage-context.ts'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

async function fixture(toStage: BidStage) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-stage-context-'))
  disposals.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create()
  const workspace = new BidWorkspace(root)
  const contents = new Map<string, string>()
  for (const path of getBidStagePolicy(toStage).requiredInputs) {
    const content = `authoritative:${toStage}:${path}\n`
    const absolute = join(workspace.projectRoot, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
    contents.set(path, content)
  }
  return { session, workspace, contents }
}

function appendVisible(session: Awaited<ReturnType<typeof fixture>>['session'], text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

describe('Bid Stage Context Boundary', () => {
  it.each([
    ['file_intake', 'tender_analysis', 'S1-旧文件判断'],
    ['tender_analysis', 'outline_generation', 'SC-009'],
    ['outline_generation', 'evidence_mapping', '旧章节-X'],
    ['evidence_mapping', 'chapter_writing', '旧资料与错误 Section'],
  ] as const)('%s → %s 保留日志，但只把下一阶段权威 Artifact 投影给模型', async (fromStage, toStage, stale) => {
    const { session, workspace, contents } = await fixture(toStage)
    const predecessor = BID_STAGES[BID_STAGES.indexOf(fromStage) - 1]
    if (predecessor !== undefined) {
      session.append('bid.stage.started', { stage: predecessor, status: 'running' })
      session.append('bid.stage.completed', { stage: predecessor, status: 'completed', artifacts: [] })
      appendVisible(session, `进入 ${fromStage} 的旧交接`)
    }
    const staleSeq = appendVisible(session, stale)
    const before = session.deriveMessages()
    const commit = await prepareBidStageContextTransition(session, workspace, fromStage, toStage)

    expect(session.deriveMessages()).toEqual(before)
    session.append('bid.stage.completed', { stage: fromStage, status: 'completed', artifacts: [] })
    commit()

    expect(session.events.find(event => event.seq === staleSeq)).toMatchObject({ type: 'user/message' })
    expect(JSON.stringify(session.events)).toContain(stale)
    const visible = JSON.stringify(session.deriveMessages())
    expect(visible).not.toContain(stale)
    const content = session.deriveMessages()[0]?.content[0]
    if (content?.type !== 'text') throw new Error('Bid stage handoff is not text')
    const handoff = JSON.parse(content.text.slice('Bid 阶段交接：\n'.length)) as {
      from_stage: BidStage
      to_stage: BidStage
      authoritative_inputs: Array<{ path: string; sha256: string }>
    }
    expect(handoff).toMatchObject({ from_stage: fromStage, to_stage: toStage })
    expect(handoff.authoritative_inputs).toEqual([...contents].map(([path, content]) => ({
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
    })))
    expect(handoff.authoritative_inputs.map(input => input.path)).toEqual(getBidStagePolicy(toStage).requiredInputs)
  })

  it('S3 retry 继续使用边界后的 S3 交互，不恢复已排除的 S2 内容', async () => {
    const { session, workspace } = await fixture('outline_generation')
    appendVisible(session, 'SC-009')
    const commit = await prepareBidStageContextTransition(session, workspace, 'tender_analysis', 'outline_generation')
    session.append('bid.stage.completed', { stage: 'tender_analysis', status: 'completed', artifacts: [] })
    commit()
    appendVisible(session, 'S3 当前候选与修复意见')

    const visible = JSON.stringify(session.deriveMessages())
    expect(visible).toContain('S3 当前候选与修复意见')
    expect(visible).not.toContain('SC-009')
  })

  it('S5 上下文超限重试删除旧私有轮次并原样保留用户消息', async () => {
    const { session } = await fixture('chapter_writing')
    session.append('bid.stage.completed', { stage: 'evidence_mapping', status: 'completed', artifacts: [] })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '超大私有审核提示' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-bid', form: 'instructions' },
    }), { surfaceOp: 'append' })
    appendVisible(session, '只保留用户填写要求')
    session.append('bid.stage.started', { stage: 'chapter_writing', status: 'running' })
    session.append('turn/end', {
      turn: 1, reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: '请求超过模型上下文' } },
    })
    session.append('bid.stage.failed', { stage: 'chapter_writing', status: 'failed', reason: '模型上下文超限' })

    expect(recoverOverflowedBidStageContext(session, 'chapter_writing')).toBe(true)

    const visible = JSON.stringify(session.deriveMessages())
    expect(visible).not.toContain('超大私有审核提示')
    expect(visible).toContain('只保留用户填写要求')
    expect(visible).toContain('当前 Artifact 检查点恢复')
    expect(JSON.stringify(session.events)).toContain('超大私有审核提示')
  })

  it('普通失败重试不改变当前阶段上下文', async () => {
    const { session } = await fixture('chapter_writing')
    appendVisible(session, '普通失败上下文')
    session.append('bid.stage.started', { stage: 'chapter_writing', status: 'running' })
    session.append('bid.stage.failed', { stage: 'chapter_writing', status: 'failed', reason: '普通失败' })
    const before = session.deriveMessages()

    expect(recoverOverflowedBidStageContext(session, 'chapter_writing')).toBe(false)
    expect(session.deriveMessages()).toEqual(before)
  })
})
