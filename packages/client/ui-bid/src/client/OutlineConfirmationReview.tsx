import { useMemo, useState, useRef, useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  buildOutlineView,
  type BidStage,
  type OutlineArtifact,
  type OutlineReviewContext,
  type OutlineEditOperation,
} from '@deepseek-ai/dsh-bid/control-plane'
import {
  Button,
  IconChevronDownOutline14,
  IconEditOutline16,
  IconTrashOutline16,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { compareOutlines, outlineDropOperation, alignOutlineRows } from './outline-review.ts'
import type { BidKey } from './locales.ts'
import css from './OutlineConfirmationReview.module.css'

type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string

function titleChange(before: string, after: string) {
  let start = 0
  let end = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  while (end < before.length - start && end < after.length - start
    && before[before.length - end - 1] === after[after.length - end - 1]) end++
  return <div>
    <p>修改前：{before.slice(0, start)}<del>{before.slice(start, before.length - end)}</del>{before.slice(before.length - end)}</p>
    <p>修改后：{after.slice(0, start)}<ins>{after.slice(start, after.length - end)}</ins>{after.slice(after.length - end)}</p>
  </div>
}

export interface OutlineConfirmationReviewProps {
  outline: OutlineArtifact
  /** 已发布详情禁止编辑，保留目录导航和关联内容。 */
  readOnly?: boolean
  /** 目录版本的展示模式，不随工作流推进或只读权限变化。 */
  displayMode?: 'initial' | 'final_candidate' | 'final_confirmed'
  /** 与 S2 共用顶部右侧确认位置。 */
  confirmation?: ReactNode
  feedback?: ReactNode
  notice?: ReactNode
  reviewContext?: OutlineReviewContext | null | undefined
  stage?: BidStage | undefined
  draftSaveState?: 'saved' | 'saving' | 'failed' | 'conflict' | undefined
  revision?: number | undefined
  /** 是否隐藏顶部核心指标统计卡片（例如目录详情页面）。 */
  hideStats?: boolean
  onUpdateSection: (sectionId: string, patch: { title?: string; purpose?: string; must_answer?: string[] }) => void
  onStructureOperation: (operation: OutlineEditOperation) => void
  onIndentSection: (sectionId: string) => void
  onOutdentSection: (sectionId: string) => void
  t: TranslateBid
}

/**
 * Review formal outline sections beside their read-only source records.
 * @param props Current draft, S3 baseline, related records, and persisted edit callbacks.
 * @returns S3 two-column or S4 three-column outline workbench.
 */
export function OutlineConfirmationReview({
  outline,
  readOnly = false,
  displayMode = 'initial',
  confirmation,
  notice,
  reviewContext,
  stage,
  draftSaveState = 'saved',
  revision,
  hideStats = false,
  onUpdateSection,
  onStructureOperation,
  onIndentSection,
  onOutdentSection,
  t,
}: OutlineConfirmationReviewProps) {
  const [selectedId, setSelectedId] = useState(() => buildOutlineView(outline.sections)[0]?.section.id)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const titleInputs = useRef(new Map<string, HTMLInputElement>())
  const dragFrame = useRef<number>()
  const [activeDrop, setActiveDrop] = useState<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const baselineRows = useRef(new Map<string, HTMLDivElement>())
  const currentRows = useRef(new Map<string, HTMLElement>())
  const baselineScroll = useRef<HTMLDivElement>(null)
  const currentScroll = useRef<HTMLDivElement>(null)
  const [baselineCollapsed, setBaselineCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [onlyChanges, setOnlyChanges] = useState(false)
  const [navigation, setNavigation] = useState<{ id: string; side: 'baseline' | 'current' } | null>(null)
  const baseline = reviewContext?.baseline
  const diff = useMemo(() => baseline == null ? null : compareOutlines(baseline, outline, reviewContext?.evidence),
    [baseline, outline, reviewContext?.evidence])
  const currentSelected = outline.sections.find(section => section.id === selectedId)
  const selected = currentSelected ?? baseline?.sections.find(section => section.id === selectedId)
  const detailReadOnly = readOnly || currentSelected === undefined

  const handleBaselineScroll = () => {
    const baselineEl = baselineScroll.current
    const currentEl = currentScroll.current
    if (!baselineEl || !currentEl) return
    if (Math.abs(currentEl.scrollTop - baselineEl.scrollTop) > 0.5) {
      currentEl.scrollTop = baselineEl.scrollTop
    }
  }

  const handleCurrentScroll = () => {
    const baselineEl = baselineScroll.current
    const currentEl = currentScroll.current
    if (!baselineEl || !currentEl) return
    if (Math.abs(baselineEl.scrollTop - currentEl.scrollTop) > 0.5) {
      baselineEl.scrollTop = currentEl.scrollTop
    }
  }

  useEffect(() => {
    if (navigation === null) return
    const container = navigation.side === 'current' ? currentScroll.current : baselineScroll.current
    const row = (navigation.side === 'current' ? currentRows : baselineRows).current.get(navigation.id)
    if (container === null || row === undefined) return
    const bounds = container.getBoundingClientRect()
    const target = row.getBoundingClientRect()
    if (target.top < bounds.top + 4) {
      container.scrollTop += target.top - bounds.top - 4
    } else if (target.bottom > bounds.bottom - 4) {
      container.scrollTop += target.bottom - bounds.bottom + 4
    }
    const otherContainer = navigation.side === 'current' ? baselineScroll.current : currentScroll.current
    if (otherContainer !== null) {
      otherContainer.scrollTop = container.scrollTop
    }
  }, [navigation])
  const changeClass = (id: string) => {
    const change = diff?.get(id)
    return change?.added ? css.added : change?.deleted ? css.deleted : change?.moved ? css.moved : change?.title || change?.writing ? css.modified : change?.links ? css.linkChanged : ''
  }
  const badges = (id: string) => {
    const change = diff?.get(id)
    return change === undefined ? null : <span className={css.diffBadges}>
      {change.added && <span className={css.added}>＋ 新增</span>}{change.deleted && <span className={css.deleted}>− 删除</span>}
      {change.title && <span className={css.modified}>✎ 标题修改</span>}{change.writing && <span className={css.modified}>✎ 编写要求更新</span>}
      {change.moved && <span className={css.moved}>↕ 结构调整</span>}{change.links && <span className={css.linkChanged}>↗ 关联信息更新</span>}
      {change.children && !change.added && !change.deleted && !change.modified && !change.moved && <span>◇ 子项有变化</span>}
    </span>
  }
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedBranchIds, setCollapsedBranchIds] = useState<ReadonlySet<string>>(() => new Set())
  const selectSection = (id: string, side: 'baseline' | 'current') => {
    setSelectedId(id)
    const expand = (sections: OutlineArtifact['sections'], collapsed: ReadonlySet<string>) => {
      const next = new Set(collapsed)
      let parent = sections.find(section => section.id === id)?.parent_id
      while (parent != null) { next.delete(parent); parent = sections.find(section => section.id === parent)?.parent_id }
      return next
    }
    setCollapsedBranchIds(previous => expand(outline.sections, previous))
    setBaselineCollapsed(previous => expand(baseline?.sections ?? [], previous))
    setNavigation({ id, side })
  }

  const stats = useMemo(() => {
    const sections = outline.sections
    const total = sections.length
    const rootCount = sections.filter(s => s.parent_id === null).length
    const writableCount = sections.filter(s => s.writable).length
    const structuralCount = total - writableCount
    const allReqs = new Set(sections.flatMap(s => s.requirement_ids))
    const allScoring = new Set(sections.flatMap(s => s.scoring_ids))
    const allRps = new Set(sections.flatMap(s => s.scoring_response_point_ids ?? []))
    return {
      total,
      rootCount,
      writableCount,
      structuralCount,
      reqCount: allReqs.size,
      scoringCount: allScoring.size,
      rpCount: allRps.size,
    }
  }, [outline.sections])

  const hasChildrenMap = useMemo(() => new Map(outline.sections
    .filter(section => section.parent_id !== null).map(section => [section.parent_id, true])), [outline.sections])

  const filterSections = (sections: OutlineArtifact['sections'], collapsed: ReadonlySet<string>) => {
    const view = buildOutlineView(sections)
    const parents = new Map(sections.map(section => [section.id, section.parent_id]))
    const query = searchQuery.trim().toLowerCase()
    const included = new Set<string>()
    for (const { section, number } of view) {
      const change = diff?.get(section.id)
      const matches = (!onlyChanges || change?.added || change?.deleted || change?.modified || change?.moved)
        && (query.length === 0 || section.title.toLowerCase().includes(query)
          || number.includes(query) || section.purpose.toLowerCase().includes(query))
      if (!matches && section.id !== navigation?.id) continue
      included.add(section.id)
      let parent = section.parent_id
      while (parent != null) { included.add(parent); parent = parents.get(parent) ?? null }
    }
    return view.filter(({ section }) => {
      let parent = section.parent_id
      while (parent != null) {
        if (collapsed.has(parent)) return false
        parent = parents.get(parent) ?? null
      }
      return included.has(section.id)
    })
  }
  const displayedSections = filterSections(outline.sections, collapsedBranchIds)
  const baselineDisplayed = filterSections(baseline?.sections ?? [], baselineCollapsed)
  const isDiffMode = displayMode !== 'initial' && baseline != null
  const alignedRows = useMemo(() => {
    if (!isDiffMode) return null
    return alignOutlineRows(baselineDisplayed, displayedSections)
  }, [isDiffMode, baselineDisplayed, displayedSections])
  const allChanges = [...(diff?.values() ?? [])]
  const structureChanged = allChanges.some(change => change.added || change.deleted || change.moved || change.title)
  const infoChanged = allChanges.some(change => change.writing || change.links)
  const path = (source: OutlineArtifact | null | undefined, id: string) => {
    const parts: string[] = []
    let section = source?.sections.find(item => item.id === id)
    while (section !== undefined) {
      parts.unshift(section.title)
      const parent = section.parent_id
      section = source?.sections.find(item => item.id === parent)
    }
    const number = buildOutlineView(source?.sections ?? []).find(item => item.section.id === id)?.number
    return `${number ?? ''} ${parts.join(' / ')}`.trim()
  }

  // 折叠/展开控制
  const toggleBranch = (sectionId: string): void => {
    setCollapsedBranchIds((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  const collapseAll = (): void => {
    const parents = outline.sections.filter(s => hasChildrenMap.get(s.id)).map(s => s.id)
    setCollapsedBranchIds(new Set(parents))
    setBaselineCollapsed(new Set(baseline?.sections.flatMap(section => section.parent_id === null ? [] : [section.parent_id])))
  }

  const expandAll = (): void => {
    setCollapsedBranchIds(new Set())
    setBaselineCollapsed(new Set())
  }

  const stageLabel = stage === 'evidence_mapping'
    ? 'S4 · 深化目录与材料审核'
    : stage === 'outline_generation'
      ? 'S3 · 初步技术标目录审核'
      : '技术标目录审核'

  return (
    <div className={css.root} data-outline-review="" data-conversation-composer-overlay="">
      <header className={css.header}>
        <div className={css.titleRow}>
          <div className={css.titleArea}>
            <span className={css.docTitle} title={outline.document_title}>
              {outline.document_title || '技术标文件'}
            </span>
            <span className={css.stagePill}>{displayMode === 'final_confirmed' ? '最终目录已确认 / 只读' : readOnly ? '目录详情 / 只读' : stageLabel}</span>
          </div>
          <div className={css.headerActions}>
            {!readOnly && <div className={css.saveStatus}>
              <span className={`${css.saveDot} ${draftSaveState === 'saving' ? css.saveDotSaving : draftSaveState === 'conflict' || draftSaveState === 'failed' ? css.saveDotConflict : ''}`} />
              <span>
                {t(`outline.draft.${draftSaveState}`)}
                {revision !== undefined ? ` (Rev ${String(revision)})` : ''}
              </span>
            </div>}
            {!readOnly && confirmation != null && confirmation}
          </div>
        </div>
        {!hideStats && <div className={css.statsRow}>
          <div className={css.statsGrid}>
            <div className={css.statCard}>
              <span className={css.statLabel}>章节总数</span>
              <span className={css.statValue}>
                {stats.total}
                <span className={css.statSub}>{stats.rootCount} 个一级大章</span>
              </span>
            </div>
            <div className={css.statCard}>
              <span className={css.statLabel}>正文编写章节</span>
              <span className={css.statValue}>
                {stats.writableCount}
                <span className={css.statSub}>{stats.structuralCount} 个分类结构</span>
              </span>
            </div>
            <div className={css.statCard}>
              <span className={css.statLabel}>覆盖招标要求</span>
              <span className={css.statValue}>
                {stats.reqCount}
                <span className={css.statSub}>项 REQ 已分配</span>
              </span>
            </div>
            <div className={css.statCard}>
              <span className={css.statLabel}>覆盖评分响应点</span>
              <span className={css.statValue}>
                {stats.rpCount > 0 ? stats.rpCount : stats.scoringCount}
                <span className={css.statSub}>项评分点应答</span>
              </span>
            </div>
          </div>
        </div>}
        {notice}
        {diff !== null && <div className={css.diffSummary} aria-label="目录差异汇总">
          {(['added', 'deleted', 'title', 'writing', 'moved', 'links'] as const).map((kind, index) => <span key={kind}>
            {['新增', '删除', '标题修改', '编写要求更新', '结构调整', '关联信息更新'][index]} {allChanges.filter(change => change[kind]).length}
          </span>)}
          <strong>{structureChanged ? '目录结构有变化' : infoChanged ? '目录结构未变，章节信息已更新' : '目录与章节信息一致'}</strong>
          <label><input type="checkbox" checked={onlyChanges} onChange={(event) => { setOnlyChanges(event.target.checked) }} />仅看变化</label>
        </div>}
        <div className={css.toolbar}>
          <div className={css.toolbarLeft}>
            <input
              className={css.searchInput}
              type="search"
              placeholder="搜索章节标题或编号..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value) }}
            />
            <Button size="sm" variant="ghost" onClick={expandAll}>
              全部展开
            </Button>
            <Button size="sm" variant="ghost" onClick={collapseAll}>
              全部折叠
            </Button>
          </div>
          {!readOnly && <div className={css.toolbarRight}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const rootSections = outline.sections.filter(s => s.parent_id === null)
                const nextOrder = rootSections.reduce((max, s) => Math.max(max, s.order), 0) + 1
                onStructureOperation({
                  type: 'add_section',
                  parent_id: null,
                  order: nextOrder,
                  writable: true,
                  title: '新增章节',
                  purpose: '补充响应',
                  must_answer: ['待补充'],
                })
              }}
            >
              + 新增一级大章
            </Button>
          </div>}
        </div>
      </header>

      <div className={`${css.workbench} ${displayMode !== 'initial' ? css.threeColumns : ''}`}>
        {displayMode !== 'initial' && <aside className={css.directoryPanel} aria-label="S3 已确认目录">
          <h3>S3 已确认目录 · 只读</h3>
          <div className={css.treeContainer} ref={baselineScroll} onScroll={handleBaselineScroll}>
            {baseline == null && <p>未加载 S3 已确认目录</p>}
            {alignedRows !== null ? alignedRows.map(({ left, key }) => {
              if (!left) return <div key={`spacer-${key}`} className={css.treeRowSpacer} aria-hidden="true" />
              const { section, number, depth } = left
              const hasChildren = baseline?.sections.some(item => item.parent_id === section.id) ?? false
              return (
                <div key={section.id} ref={(element) => {
                  if (element) baselineRows.current.set(section.id, element)
                  else baselineRows.current.delete(section.id)
                }}
                className={`${css.treeRow} ${changeClass(section.id)} ${selectedId === section.id ? css.selected : ''}`}
                data-section-id={section.id}
                onClick={() => { selectSection(section.id, 'baseline') }}
                onFocus={() => { selectSection(section.id, 'baseline') }}
                aria-current={selectedId === section.id ? 'true' : undefined} style={{ paddingLeft: (depth - 1) * 20 }}>
                  <div className={css.rowMain}>
                    {hasChildren ? <button type="button" className={css.collapseToggle}
                      aria-label={`${baselineCollapsed.has(section.id) ? '展开' : '折叠'} ${section.title}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setBaselineCollapsed((previous) => {
                          const next = new Set(previous)
                          if (next.has(section.id)) next.delete(section.id)
                          else next.add(section.id)
                          return next
                        })
                      }}>
                      {baselineCollapsed.has(section.id) ? <IconChevronRightOutline14 /> : <IconChevronDownOutline14 />}
                    </button> : <span className={css.collapsePlaceholder} />}
                    <span className={css.dragPlaceholder} />
                    <span className={css.sectionNumber}>{number}</span>
                    <button className={css.baselineTitle} title={section.title} type="button">{section.title}</button>
                    {badges(section.id)}
                  </div>
                </div>
              )
            }) : baselineDisplayed.map(({ section, number, depth }) => {
              const hasChildren = baseline?.sections.some(item => item.parent_id === section.id) ?? false
              return (
                <div key={section.id} ref={(element) => {
                  if (element) baselineRows.current.set(section.id, element)
                  else baselineRows.current.delete(section.id)
                }}
                className={`${css.treeRow} ${changeClass(section.id)} ${selectedId === section.id ? css.selected : ''}`}
                data-section-id={section.id}
                onClick={() => { selectSection(section.id, 'baseline') }}
                onFocus={() => { selectSection(section.id, 'baseline') }}
                aria-current={selectedId === section.id ? 'true' : undefined} style={{ paddingLeft: (depth - 1) * 20 }}>
                  <div className={css.rowMain}>
                    {hasChildren ? <button type="button" className={css.collapseToggle}
                      aria-label={`${baselineCollapsed.has(section.id) ? '展开' : '折叠'} ${section.title}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleBranch(section.id)
                      }}>
                      {baselineCollapsed.has(section.id) ? <IconChevronRightOutline14 /> : <IconChevronDownOutline14 />}
                    </button> : <span className={css.collapsePlaceholder} />}
                    <span className={css.dragPlaceholder} />
                    <span className={css.sectionNumber}>{number}</span>
                    <button className={css.baselineTitle} title={section.title} type="button">{section.title}</button>
                    {badges(section.id)}
                  </div>
                </div>
              )
            })}
          </div>
        </aside>}
        <div className={css.directoryPanel} aria-label="技术标目录">
          <h3>{displayMode !== 'initial' ? displayMode === 'final_confirmed' ? 'S4 最终确认目录' : 'S4 当前目录' : '当前目录'}</h3>
          <div className={css.treeContainer} ref={currentScroll} onScroll={handleCurrentScroll}>
            {((alignedRows !== null ? alignedRows.length : displayedSections.length) === 0) && (
              <div className={css.emptySearch}>
                {onlyChanges ? '没有符合条件的变化章节' : searchQuery ? `未找到包含 "${searchQuery}" 的章节` : '暂无目录章节'}
              </div>
            )}

            {(() => {
              const renderCurrentSection = ({ section, number, depth }: { section: OutlineArtifact['sections'][number]; number: string; depth: number }) => {
                const hasChildren = hasChildrenMap.get(section.id) ?? false
                const isBranchCollapsed = collapsedBranchIds.has(section.id)
                const indentPx = Math.max(0, depth - 1) * 20

                return (
                  <article
                    key={section.id}
                    ref={(element) => {
                      if (element) currentRows.current.set(section.id, element)
                      else currentRows.current.delete(section.id)
                    }}
                    data-section-id={section.id}
                    aria-current={selectedId === section.id ? 'true' : undefined}
                    className={`${css.treeRow} ${changeClass(section.id)} ${selectedId === section.id ? css.selected : ''}`}
                    onFocus={() => { selectSection(section.id, 'current') }}
                    onClick={() => { selectSection(section.id, 'current') }}
                    draggable={!readOnly && editingId !== section.id}
                    // Let the browser capture the drag image before adding drop targets.
                    onDragStart={(event) => {
                      event.dataTransfer.setData('application/x-bid-outline-section', section.id)
                      event.dataTransfer.effectAllowed = 'move'
                      const row = event.currentTarget
                      event.dataTransfer.setDragImage(row, 24, 16)
                      dragFrame.current = requestAnimationFrame(() => { setDraggedId(section.id) })
                    }}
                    onDragEnd={() => {
                      if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current)
                      setDraggedId(null); setActiveDrop(null)
                    }}
                    style={{ paddingLeft: `${String(indentPx)}px` }}
                  >
                    {draggedId !== null && <div className={css.dropTargets}>
                      {(['before', 'inside', 'after'] as const).map((position) => {
                        const operation = position === 'after' && hasChildren && !isBranchCollapsed
                          ? null : outlineDropOperation(outline, draggedId, section.id, position)
                        return <div key={position} role="button" tabIndex={-1} aria-disabled={operation === null}
                          aria-label={`${section.id} ${position}`}
                          data-position={position}
                          data-active={activeDrop === `${section.id}:${position}`}
                          className={operation === null ? css.dropDisabled : css.dropTarget}
                          onDragLeave={() => { setActiveDrop(null) }}
                          onDragOver={(event) => {
                            setActiveDrop(operation === null ? null : `${section.id}:${position}`)
                            if (operation !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }
                          }}
                          onDrop={(event) => {
                            if (operation === null) return
                            event.preventDefault()
                            onStructureOperation(operation)
                            setSelectedId(draggedId)
                            setCollapsedBranchIds(new Set())
                            setDraggedId(null); setActiveDrop(null)
                          }}>
                        </div>
                      })}
                    </div>}
                    <div className={css.rowMain}>
                      {hasChildren ? (
                        <button
                          type="button"
                          className={css.collapseToggle}
                          aria-label={isBranchCollapsed ? `展开 ${section.title}` : `折叠 ${section.title}`}
                          onClick={(event) => { event.stopPropagation(); toggleBranch(section.id) }}
                        >
                          {isBranchCollapsed ? <IconChevronRightOutline14 /> : <IconChevronDownOutline14 />}
                        </button>
                      ) : (
                        <span className={css.collapsePlaceholder} />
                      )}

                      {!readOnly && <button type="button" aria-label={`拖动 ${section.title}`} className={css.dragHandle}
                        onClick={() => { setSelectedId(section.id) }}
                      >⠿</button>}
                      <span className={css.sectionNumber} aria-label={`${section.id} 章节编号`}>
                        {number}
                      </span>

                      <div className={css.titleInputWrapper}>
                        <input
                          className={css.titleInput}
                          ref={(element) => {
                            if (element) titleInputs.current.set(section.id, element)
                            else titleInputs.current.delete(section.id)
                          }}
                          aria-label={`${section.id} 标题`}
                          title={section.title}
                          readOnly={readOnly || editingId !== section.id}
                          value={editingId === section.id ? editingTitle : section.title}
                          onChange={(event) => { setEditingTitle(event.target.value) }}
                          onBlur={() => {
                            if (editingId !== section.id) return
                            if (editingTitle !== section.title) onUpdateSection(section.id, { title: editingTitle })
                            setEditingId(null)
                          }}
                        />
                      </div>
                      {badges(section.id)}
                      {!readOnly && <span className={css.rowActions}>
                        <button type="button" className={css.rowIcon} aria-label={`编辑 ${section.title}`}
                          onClick={() => {
                            setEditingId(section.id)
                            setEditingTitle(section.title)
                            titleInputs.current.get(section.id)?.focus()
                            titleInputs.current.get(section.id)?.select()
                          }}>
                          <IconEditOutline16 />
                        </button>
                        <button type="button" className={css.rowIcon} aria-label={`删除 ${section.title}`}
                          onClick={() => { onStructureOperation({ type: 'delete_section', section_id: section.id }) }}>
                          <IconTrashOutline16 />
                        </button>
                      </span>}
                    </div>
                  </article>
                )
              }

              if (alignedRows !== null) {
                return alignedRows.map(({ right, key }) => {
                  if (!right) return <div key={`spacer-${key}`} className={css.treeRowSpacer} aria-hidden="true" />
                  return renderCurrentSection(right)
                })
              }
              return displayedSections.map(renderCurrentSection)
            })()}
          </div>
        </div>
        <aside className={css.sidePanel} aria-label="当前章节详情">
          <h3>当前章节关联内容</h3>
          {selected !== undefined && [selected].map((section) => {
            const original = baseline?.sections.find(item => item.id === section.id)
            const change = diff?.get(section.id)
            const siblings = outline.sections
              .filter(candidate => candidate.parent_id === section.parent_id)
              .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
            const index = siblings.findIndex(candidate => candidate.id === section.id)

            return <div key={section.id}>
              <h4>{section.title}</h4>
              {diff !== null && <section className={css.chapterChanges} aria-label="本章变化">
                <h4>本章变化</h4>
                {currentSelected === undefined && <p>S4 中无对应章节 · 已删除，以下为 S3 原内容</p>}
                {original === undefined && <p>S3 中无对应章节</p>}
                {badges(section.id)}
                {!change?.modified && !change?.moved && !change?.added && !change?.deleted && <p>本章内容未变化</p>}
                {original !== undefined && diff.get(section.id)?.title && titleChange(original.title, section.title)}
                {diff.get(section.id)?.moved && <p>{path(baseline, section.id)} → {path(outline, section.id)}</p>}
                {diff.get(section.id)?.details.map(detail => <div key={detail.label}><h5>{detail.label}</h5>
                  {detail.before.map((value, index) => <p key={`before-${index}`}>− <del>{value}</del></p>)}
                  {detail.after.map((value, index) => <p key={`after-${index}`}>＋ <ins>{value}</ins></p>)}
                </div>)}
              </section>}
              <div className={css.badges}>
                <span className={`${css.badge} ${section.writable ? css.badgeWritable : css.badgeStructural}`}>
                  {section.writable ? '正文编写' : '结构目录'}
                </span>
                {section.requirement_ids.length > 0 && (
                  <span className={`${css.badge} ${css.badgeMapping}`} title={`关联招标要求: ${section.requirement_ids.join(', ')}`}>
                    REQ · {section.requirement_ids.length}
                  </span>
                )}
                {section.scoring_ids.length > 0 && (
                  <span className={`${css.badge} ${css.badgeScoring}`} title={`关联评分项: ${section.scoring_ids.join(', ')}`}>
                    评分 · {section.scoring_ids.length}
                  </span>
                )}
              </div>
              {!detailReadOnly && <div className={css.cardActions}>
                <button
                  type="button"
                  className={css.actionButton}
                  onClick={() => {
                    onStructureOperation({
                      type: 'add_section',
                      parent_id: section.parent_id,
                      order: section.order + 1,
                      writable: true,
                      title: '新增章节',
                      purpose: '补充响应',
                      must_answer: ['待补充'],
                    })
                  }}
                >
                  新增同级
                </button>
                <button
                  type="button"
                  className={css.actionButton}
                  onClick={() => {
                    onStructureOperation({
                      type: 'add_section',
                      parent_id: section.id,
                      order: 1,
                      writable: true,
                      title: '新增子级',
                      purpose: '补充响应',
                      must_answer: ['待补充'],
                    })
                  }}
                >
                  新增子级
                </button>
                <button
                  type="button"
                  disabled={index === 0}
                  className={css.actionButton}
                  onClick={() => {
                    onStructureOperation({
                      type: 'move_section',
                      section_id: section.id,
                      parent_id: section.parent_id,
                      order: index,
                    })
                  }}
                >
                  上移
                </button>
                <button
                  type="button"
                  disabled={index === siblings.length - 1}
                  className={css.actionButton}
                  onClick={() => {
                    onStructureOperation({
                      type: 'move_section',
                      section_id: section.id,
                      parent_id: section.parent_id,
                      order: index + 2,
                    })
                  }}
                >
                  下移
                </button>
                <button
                  type="button"
                  disabled={index === 0}
                  className={css.actionButton}
                  onClick={() => { onIndentSection(section.id) }}
                >
                  缩进
                </button>
                <button
                  type="button"
                  disabled={section.parent_id === null}
                  className={css.actionButton}
                  onClick={() => { onOutdentSection(section.id) }}
                >
                  取消缩进
                </button>
                <button
                  type="button"
                  className={`${css.actionButton} ${css.deleteButton}`}
                  onClick={() => {
                    onStructureOperation({ type: 'delete_section', section_id: section.id })
                  }}
                >
                  删除
                </button>
              </div>}
              {section.summary && <p>{section.summary}</p>}
              {(
                <div className={css.cardDetails}>
                  <div className={css.detailField}>
                    <label className={css.detailLabel}>章节编写目的与应答范围</label>
                    <textarea
                      className={css.detailTextarea}
                      aria-label={`${section.id} 目的`}
                      readOnly={detailReadOnly}
                      value={section.purpose}
                      onChange={(event) => {
                        onUpdateSection(section.id, { purpose: event.target.value })
                      }}
                    />
                  </div>

                  {section.writable && (
                    <div className={css.detailField}>
                      <label className={css.detailLabel}>必须回答的关键技术要点（每行一条）</label>
                      <textarea
                        className={css.detailTextarea}
                        aria-label={`${section.id} 必答内容`}
                        readOnly={detailReadOnly}
                        value={section.must_answer.join('\n')}
                        onChange={(event) => {
                          onUpdateSection(section.id, {
                            must_answer: event.target.value.split('\n').map(v => v.trim()).filter(Boolean),
                          })
                        }}
                      />
                    </div>
                  )}

                  <div className={css.mappingInfo}>
                    <span>{`Requirement ${String(section.requirement_ids.length)} · Scoring ${String(section.scoring_ids.length)}`}</span>
                    {section.scoring_response_points.length > 0 && (
                      <span>
                        响应点：{section.scoring_response_points.map(rp => rp.response_point).join('；')}
                      </span>
                    )}
                  </div>
                </div>
              )}
              <h4>Requirement · 招标要求</h4>
              {section.requirement_ids.map(id => <p key={id}>{id} · {reviewContext?.requirements.requirements.find(item => item.id === id)?.normalized_requirement ?? '未加载要求正文'}</p>)}
              <h4>Scoring · 评分项</h4>
              {section.scoring_ids.map(id => <p key={id}>{id} · {reviewContext?.scoring.scoring_items.find(item => item.id === id)?.criterion ?? '未加载评分正文'}</p>)}
              <h4>人工框架</h4>
              {(section.framework_refs ?? []).map((ref, index) => <p key={index}>{ref.file_id} · {ref.heading_path.join(' / ')}</p>)}
              <h4>Blueprint · 写作说明</h4>
              {[...section.writing_notes, ...section.suggested_tables, ...section.suggested_figures]
                .map((text, index) => <p key={index}>{text}</p>)}
              <h4>Evidence · 旧标书与资料</h4>
              {reviewContext?.evidence?.section_mappings
                .filter(mapping => mapping.section_id === section.id).map(mapping => <div key={mapping.section_id}>
                  {mapping.writing_dimensions.map((text, index) => <p key={`dimension-${index}`}>{text}</p>)}
                  {mapping.local_materials.map((material, index) => <p key={`local-${index}`}>{material.source_kind === 'reference_bid' ? '旧标书' : '资料'} · {material.file_id} / {material.chunk} · {material.summary}</p>)}
                  {mapping.web_materials.map((material, index) => <p key={`web-${index}`}>{material.source_id} · {material.summary} · {material.supports}</p>)}
                  {mapping.missing_topics.map((text, index) => <p key={`missing-${index}`}>待补充：{text}</p>)}
                </div>)}
            </div>
          })}
        </aside>
      </div>
    </div>
  )
}
