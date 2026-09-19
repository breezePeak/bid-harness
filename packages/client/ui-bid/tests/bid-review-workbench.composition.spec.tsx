// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BidAddRevisionIssueRequest,
  BidRevisionIssueView,
  BidRevisionQueueView,
  BidReviewChapterView,
  DocxTemplateId,
} from '@deepseek-ai/dsh-bid/control-plane'
import type { ComposerSubmitHandler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BidReviewWorkbench } from '../src/client/BidReviewWorkbench.tsx'
import { BidComposerContext } from '../src/client/BidComposerContext.tsx'
import { BidStagePanel } from '../src/client/BidStagePanel.tsx'
import { createBidRevisionStore } from '../src/client/revision-reference.ts'

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
})

const pageBasis = {
  source: 'template' as const,
  method: 'fast' as const,
  template: { id: 'a'.repeat(64) as DocxTemplateId, name: '模版.docx', revision: 1 },
}

const mockWorkbench = {
  schema_version: 6 as const,
  outline: [
    {
      section_id: 'ROOT',
      parent_id: null,
      order: 1,
      title: '技术方案概述',
      summary: '技术方案顶层概述，不可单独编辑。',
      writable: false,
      writing_status: 'not_started' as const,
      review_status: 'not_started' as const,
      chapter_indicator: { status: 'not_started' as const, tooltip: '章节概述' },
      content_available: false,
    },
    {
      section_id: 'SEC-1',
      parent_id: 'ROOT',
      order: 1,
      title: '实施方案详解',
      writable: true,
      writing_status: 'content_ready' as const,
      review_status: 'reviewing' as const,
      chapter_indicator: { status: 'reviewing' as const, tooltip: '审核中' },
      content_available: true,
    },
  ],
  summary: {
    chapter_count: 1,
    content_count: 1,
    reviewed_count: 0,
    needs_attention_count: 0,
    page_estimate: { status: 'available' as const, pages: 3, ...pageBasis },
    page_target: { status: 'not_required' as const },
  },
  global_compliance: {
    status: 'not_required' as const,
    reviewed_count: 0,
    total_count: 0,
    document_issues: [],
    delivery_todos: [],
  },
}

const chapterMarkdown = `# 1.1 实施方案详解

第一段技术实施原则与方案说明。

第二段关键人员配置与资质证明安排。

第三段进度控制与交付物清单保证。
`

const mockChapter: BidReviewChapterView = {
  section_id: 'SEC-1',
  title: '实施方案详解',
  number: '1.1',
  heading_path: ['技术方案概述', '实施方案详解'],
  writable: true,
  markdown: chapterMarkdown,
  content_sha256: 'b'.repeat(64),
  requirement_ids: ['REQ-01'],
  scoring_response_point_ids: ['RP-01'],
  evidence_status: 'available',
  review: { status: 'reviewing', issues: [] },
}

async function openRevisionPanel(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: '展开批量审核修改' }))
}

describe('S5 Review Workbench & Composer REAL-Composition Integration', () => {
  function setupCompositionEnvironment() {
    const store = createBidRevisionStore().create()
    let currentRevision = 1
    const issues: BidRevisionIssueView[] = []

    const remoteQueue = vi.fn(async (): Promise<BidRevisionQueueView> => {
      return {
        schema_version: 1,
        revision: currentRevision,
        issues: [...issues],
      }
    })

    let revisionQueueListener: (() => void) | null = null
    const subscribeRevisionQueueChanged = vi.fn((listener: () => void) => {
      revisionQueueListener = listener
      return () => { revisionQueueListener = null }
    })

    const remoteAddIssue = vi.fn(async (request: BidAddRevisionIssueRequest): Promise<BidRevisionQueueView> => {
      currentRevision += 1
      const newIssue: BidRevisionIssueView = {
        issue_id: `ISSUE-${issues.length + 1}`,
        scope: request.scope,
        section_id: request.section_id,
        section_title: '实施方案详解',
        reference: request.reference,
        instruction: request.instruction,
        suggestion: request.suggestion ?? null,
        status: 'pending',
        batch_id: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      }
      issues.push(newIssue)
      revisionQueueListener?.()
      return {
        schema_version: 1,
        revision: currentRevision,
        issues: [...issues],
      }
    })

    const remoteGetChapter = vi.fn(async (sectionId: string) => {
      if (sectionId === 'SEC-1') return mockChapter
      throw new Error(`Unknown chapter: ${sectionId}`)
    })

    const remoteGetWorkbench = vi.fn(async () => mockWorkbench)

    function CompositionHarness() {
      const workbenchProps = {
        sessionId: 'bid' as SessionId,
        useStore: (selector: (state: ReturnType<typeof store.getSnapshot>) => unknown) => (
          selector(useSyncExternalStore(l => store.subscribe(l), () => store.getSnapshot()))
        ),
        actions: store.actions,
        useSessions: <S,>(selector: (state: never) => S): S => selector({ byId: { bid: { agentPreset: 'bid' } } } as never),
        useProjection: () => ({ allowedActions: [], runtime: { stage: 'chapter_writing', status: 'running' } }),
        renderSlot: (name: string) => <div data-slot={name} />,
        getWorkbench: remoteGetWorkbench,
        getChapter: remoteGetChapter,
        addRevisionIssue: remoteAddIssue,
      }

      const stagePanelProps = {
        sessionId: 'bid' as SessionId,
        disabled: false,
        useSessions: <S,>(selector: (state: never) => S): S => selector({ byId: { bid: { agentPreset: 'bid' } } } as never),
        useProjection: () => ({
          allowedActions: ['request_writing_requirements', 'auto_start_chapter_writing'],
          runtime: { stage: 'chapter_writing', status: 'running' },
          composer: { enabled: true },
        }),
        useStore: (select: (state: { mode: string }) => unknown) => select({ mode: 'manual' }),
        actions: { setMode: vi.fn(), markAttempted: vi.fn(), clearAttempted: vi.fn() },
        t: ((key: string) => key) as unknown as (_key: string) => string,
        getDetails: vi.fn(async () => ({})),
        setDetailsAvailable: vi.fn(),
        setComposerBlock: vi.fn(),
        selectReviewView: vi.fn(),
        setReviewViewAvailable: vi.fn(),
        reviewSurface: { host: () => null, subscribe: () => () => {} },
        uploadFiles: vi.fn(async () => []),
        getDocxLibrary: vi.fn(async () => ({ templates: [], templateMaxBytes: 1024, revision: 1 })),
        uploadDocxTemplate: vi.fn(),
        getRevisionQueue: remoteQueue,
        updateRevisionIssue: vi.fn(),
        deleteRevisionIssue: vi.fn(),
        startRevisionBatch: vi.fn(async () => {}),
        locateChapter: vi.fn(),
        subscribeRevisionQueueChanged,
      }

      const composerProps = {
        sessionId: 'bid' as SessionId,
        disabled: false,
        useSessions: (select: (state: unknown) => unknown) => select({ byId: { bid: { agentPreset: 'bid' } } }),
        useProjection: () => ({ runtime: { stage: 'chapter_writing', status: 'running' } }),
        useStore: (selector: (state: ReturnType<typeof store.getSnapshot>) => unknown) => (
          selector(useSyncExternalStore(l => store.subscribe(l), () => store.getSnapshot()))
        ),
        actions: store.actions,
        getChapter: remoteGetChapter,
        sendMessage: vi.fn(async () => {}),
        registerSubmit: (_handler: ComposerSubmitHandler) => () => {},
      }

      return (
        <div data-testid="composition-root">
          <div data-testid="review-panel">
            <BidReviewWorkbench {...(workbenchProps as unknown as Parameters<typeof BidReviewWorkbench>[0])} />
          </div>
          <div data-testid="composer-dock">
            <BidStagePanel {...(stagePanelProps as unknown as Parameters<typeof BidStagePanel>[0])} />
            <BidComposerContext {...(composerProps as unknown as Parameters<typeof BidComposerContext>[0])} />
            <textarea aria-label="编写意见" />
          </div>
        </div>
      )
    }

    const view = render(<CompositionHarness />)

    return {
      ...view,
      store,
      remoteQueue,
      remoteAddIssue,
      remoteGetChapter,
      remoteGetWorkbench,
    }
  }

  it('Case 1: 正文段落选区右键添加审批意见完整链路 -> 保存后 Composer 立即展示 Issue 卡片', async () => {
    const harness = setupCompositionEnvironment()

    // 1. 等待工作台及正文渲染完成
    expect(await screen.findByText('第一段技术实施原则与方案说明。')).toBeTruthy()
    expect(await screen.findByText('第二段关键人员配置与资质证明安排。')).toBeTruthy()

    // 2. 模拟选中文本段落
    const paragraphs = harness.container.querySelectorAll<HTMLElement>('[data-markdown-paragraph]')
    expect(paragraphs.length).toBeGreaterThanOrEqual(3)
    const targetParagraph = paragraphs[1]! // 第二段

    const range = document.createRange()
    range.setStart(targetParagraph.firstChild!, 1)
    range.setEnd(targetParagraph.lastChild!, 5)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    // 3. 在目标段落触发右键菜单
    fireEvent.contextMenu(targetParagraph, { clientX: 200, clientY: 300 })

    // 4. 验证弹出包含“添加审批意见”的右键菜单项
    const addIssueBtn = await screen.findByRole('menuitem', { name: '添加审批意见' })
    expect(addIssueBtn).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '添加到对话框' })).toBeTruthy()

    // 5. 点击“添加审批意见”，弹出 modal
    fireEvent.click(addIssueBtn)
    expect(await screen.findByRole('heading', { name: '添加审批意见' })).toBeTruthy()
    expect(screen.getByText(/实施方案详解 · 1 段/)).toBeTruthy()

    // 6. 填写修改意见
    const instructionInput = screen.getByLabelText(/修改意见/)
    fireEvent.change(instructionInput, { target: { value: '必须补充项目经理高级工程师证书扫描件' } })

    // 7. 点击保存（添加到待处理意见）
    const saveBtn = screen.getByRole('button', { name: '添加到待处理意见' })
    fireEvent.click(saveBtn)

    // 8. 验证调用了 remote 的 addRevisionIssue，入参正确
    await waitFor(() => {
      expect(harness.remoteAddIssue).toHaveBeenCalledWith({
        scope: 'paragraphs',
        section_id: 'SEC-1',
        reference: expect.objectContaining({
          scope: 'paragraphs',
          base_content_sha256: mockChapter.content_sha256,
          start: expect.any(Number),
          end: expect.any(Number),
          text: expect.any(String),
        }),
        instruction: '必须补充项目经理高级工程师证书扫描件',
        suggestion: null,
      })
    })

    // 9. 底部入口打开批量审核修改浮层并展示新增意见，Composer 上方不显示队列
    await openRevisionPanel()
    expect(await screen.findByRole('list', { name: '待修复与修复中，共 1 条' })).toBeTruthy()
    expect(screen.getByText('ISSUE-1')).toBeTruthy()
    expect(screen.getByText('必须补充项目经理高级工程师证书扫描件')).toBeTruthy()
    expect(screen.queryByText(/待处理审批意见/)).toBeNull()
  })

  it('Case 2: 左侧章节目录右键添加审批意见完整链路 -> scope: chapter 且 Composer 立即展示', async () => {
    const harness = setupCompositionEnvironment()

    // 1. 等待工作台加载
    const leafChapterBtn = await screen.findByRole('button', { name: /1.1 实施方案详解/ })
    expect(leafChapterBtn).toBeTruthy()

    // 2. 在左侧目录树的可写章节上触发右键
    const treeRow = leafChapterBtn.closest('[class*="treeRow"]')!
    fireEvent.contextMenu(treeRow, { clientX: 50, clientY: 100 })

    // 3. 验证弹出章节右键菜单
    const addIssueBtn = await screen.findByRole('menuitem', { name: '添加审批意见' })
    expect(addIssueBtn).toBeTruthy()

    // 4. 点击打开 Modal
    fireEvent.click(addIssueBtn)
    expect(await screen.findByRole('heading', { name: '添加审批意见' })).toBeTruthy()
    expect(screen.getByText(/实施方案详解 · 整个章节/)).toBeTruthy()

    // 5. 填写并保存
    const instructionInput = screen.getByLabelText(/修改意见/)
    fireEvent.change(instructionInput, { target: { value: '整个章节字数偏少，需要扩充工期保障措施' } })

    fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' }))

    // 6. 验证 remote 以 scope: 'chapter' 调用
    await waitFor(() => {
      expect(harness.remoteAddIssue).toHaveBeenCalledWith({
        scope: 'chapter',
        section_id: 'SEC-1',
        reference: {
          scope: 'chapter',
          base_content_sha256: mockChapter.content_sha256,
        },
        instruction: '整个章节字数偏少，需要扩充工期保障措施',
        suggestion: null,
      })
    })

    // 7. 验证浮层立即出现该卡片
    await openRevisionPanel()
    expect(await screen.findByRole('list', { name: '待修复与修复中，共 1 条' })).toBeTruthy()
    expect(screen.getByText('ISSUE-1')).toBeTruthy()
    expect(screen.getByText('整个章节字数偏少，需要扩充工期保障措施')).toBeTruthy()
  })

  it('Case 3: 正文标题区域右键添加审批意见 -> scope: chapter 且 Composer 立即展示', async () => {
    const harness = setupCompositionEnvironment()

    // 1. 等待正文标题出现
    expect(await screen.findByText('1.1 实施方案详解')).toBeTruthy()
    const titleRow = harness.container.querySelector('[class*="titleRow"]')!
    expect(titleRow).toBeTruthy()

    // 2. 右键点击正文顶部的标题行
    fireEvent.contextMenu(titleRow, { clientX: 250, clientY: 60 })

    // 3. 弹出右键菜单并点击“添加审批意见”
    const addIssueBtn = await screen.findByRole('menuitem', { name: '添加审批意见' })
    fireEvent.click(addIssueBtn)

    // 4. 填写并保存
    expect(await screen.findByRole('heading', { name: '添加审批意见' })).toBeTruthy()
    expect(screen.getByText(/实施方案详解 · 整个章节/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/修改意见/), { target: { value: '方案标题需要遵循招标要求统一规范' } })
    fireEvent.click(screen.getByRole('button', { name: '添加到待处理意见' }))

    // 5. 验证 remote 调用及浮层即时刷新
    await waitFor(() => {
      expect(harness.remoteAddIssue).toHaveBeenCalledWith({
        scope: 'chapter',
        section_id: 'SEC-1',
        reference: {
          scope: 'chapter',
          base_content_sha256: mockChapter.content_sha256,
        },
        instruction: '方案标题需要遵循招标要求统一规范',
        suggestion: null,
      })
    })

    await openRevisionPanel()
    expect(await screen.findByRole('list', { name: '待修复与修复中，共 1 条' })).toBeTruthy()
    expect(screen.getByText('ISSUE-1')).toBeTruthy()
    expect(screen.getByText('方案标题需要遵循招标要求统一规范')).toBeTruthy()
  })

  it('Case 4: 选区在外部或不可写父节点时，不弹出审批意见菜单', async () => {
    const harness = setupCompositionEnvironment()

    // 1. 在不可写父节点（ROOT 技术方案概述）上触发右键
    const rootBtn = await screen.findByRole('button', { name: /1 技术方案概述/ })
    const rootTreeRow = rootBtn.closest('[class*="treeRow"]')!
    expect(rootTreeRow).toBeTruthy()

    fireEvent.contextMenu(rootTreeRow, { clientX: 40, clientY: 50 })

    // 验证：没有弹出右键菜单
    expect(screen.queryByRole('menu', { name: /操作/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '添加审批意见' })).toBeNull()

    // 2. 鼠标在非段落空白处（如面板头部）右键
    const header = harness.container.querySelector('[class*="leftHeader"]')!
    expect(header).toBeTruthy()

    fireEvent.contextMenu(header, { clientX: 80, clientY: 20 })

    // 验证：不弹出审批意见菜单
    expect(screen.queryByRole('menuitem', { name: '添加审批意见' })).toBeNull()
  })
})
