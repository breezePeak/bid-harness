import { useMemo, useState, useRef, useEffect } from 'react'
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
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { compareOutlines, outlineDropOperation } from './outline-review.ts'
import type { BidKey } from './locales.ts'
import css from './OutlineConfirmationReview.module.css'

type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string

export interface OutlineConfirmationReviewProps {
  outline: OutlineArtifact
  reviewContext?: OutlineReviewContext | null | undefined
  stage?: BidStage | undefined
  draftSaveState?: 'saved' | 'saving' | 'failed' | 'conflict' | undefined
  revision?: number | undefined
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
  reviewContext,
  stage,
  draftSaveState = 'saved',
  revision,
  onUpdateSection,
  onStructureOperation,
  onIndentSection,
  onOutdentSection,
  t,
}: OutlineConfirmationReviewProps) {
  const [selectedId, setSelectedId] = useState(outline.sections[0]?.id)
  const dragFrame = useRef<number>()
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [onlyChanges, setOnlyChanges] = useState(false)
  const baselineRows = useRef(new Map<string, HTMLDivElement>())
  const baseline = reviewContext?.baseline
  const diff = useMemo(() => baseline == null ? null : compareOutlines(baseline, outline), [baseline, outline])
  const changed = (id: string): boolean => Object.values(diff?.get(id) ?? {}).some(Boolean)
  const visibleIds = (sections: OutlineArtifact['sections']): Set<string> => {
    const ids = new Set(sections.filter(section => changed(section.id)).map(section => section.id))
    const byId = new Map(sections.map(section => [section.id, section]))
    for (const id of ids) {
      const parent = byId.get(id)?.parent_id
      if (parent != null) ids.add(parent)
    }
    return ids
  }
  const currentVisible = diff === null ? null : visibleIds(outline.sections)
  const baselineVisible = baseline == null ? null : visibleIds(baseline.sections)
  const selected = outline.sections.find(section => section.id === selectedId) ?? outline.sections[0]
  useEffect(() => {
    if (selected !== undefined) baselineRows.current.get(selected.id)?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id])
  const badges = (id: string) => {
    const change = diff?.get(id)
    return change === undefined ? null : <span className={css.diffBadges}>
      {change.added && <span>+ 新增</span>}{change.modified && <span>~ 修改</span>}
      {change.deleted && <span>- 删除</span>}{change.moved && <span>↕ 移动</span>}
    </span>
  }
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedBranchIds, setCollapsedBranchIds] = useState<ReadonlySet<string>>(() => new Set())

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

  const viewSections = useMemo(() => buildOutlineView(outline.sections), [outline.sections])

  const { childMap, hasChildrenMap } = useMemo(() => {
    const children = new Map<string, string[]>()
    const hasChildren = new Map<string, boolean>()
    for (const s of outline.sections) {
      if (s.parent_id !== null) {
        const list = children.get(s.parent_id) ?? []
        list.push(s.id)
        children.set(s.parent_id, list)
        hasChildren.set(s.parent_id, true)
      }
    }
    return { childMap: children, hasChildrenMap: hasChildren }
  }, [outline.sections])

  const hiddenSectionIds = useMemo(() => {
    const hidden = new Set<string>()
    const markDescendants = (parentId: string): void => {
      const childIds = childMap.get(parentId) ?? []
      for (const cid of childIds) {
        hidden.add(cid)
        markDescendants(cid)
      }
    }
    for (const branchId of collapsedBranchIds) {
      markDescendants(branchId)
    }
    return hidden
  }, [childMap, collapsedBranchIds])

  const displayedSections = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return viewSections.filter(({ section, number }) => {
      if (hiddenSectionIds.has(section.id)) return false
      if (query.length === 0) return true
      return section.title.toLowerCase().includes(query)
        || number.toLowerCase().includes(query)
        || section.purpose.toLowerCase().includes(query)
    })
  }, [hiddenSectionIds, searchQuery, viewSections])

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
  }

  const expandAll = (): void => {
    setCollapsedBranchIds(new Set())
  }

  const stageLabel = stage === 'evidence_mapping'
    ? 'S4 · 深化目录与材料审核'
    : stage === 'outline_generation'
      ? 'S3 · 初步技术标目录审核'
      : '技术标目录审核'

  return (
    <div className={css.root}>
      <header className={css.header}>
        <div className={css.titleRow}>
          <div className={css.titleArea}>
            <span className={css.docTitle} title={outline.document_title}>
              {outline.document_title || '技术标文件'}
            </span>
            <span className={css.stagePill}>{stageLabel}</span>
          </div>
          <div className={css.saveStatus}>
            <span className={`${css.saveDot} ${draftSaveState === 'saving' ? css.saveDotSaving : draftSaveState === 'conflict' || draftSaveState === 'failed' ? css.saveDotConflict : ''}`} />
            <span>
              {t(`outline.draft.${draftSaveState}`)}
              {revision !== undefined ? ` (Rev ${String(revision)})` : ''}
            </span>
          </div>
        </div>
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
      </header>

      {stage === 'evidence_mapping' && <div className={css.diffSummary}>
        {diff === null ? <span role="status">S3 基线尚未加载</span> : <>
          <span>S3 章节数量 {baseline?.sections.length}</span><span>S4 章节数量 {outline.sections.length}</span>
          {([['added', '新增'], ['modified', '修改'], ['deleted', '删除'], ['moved', '移动']] as const).map(([key, label]) =>
            <span key={key}>{label}数量 {[...diff.values()].filter(change => change[key]).length}</span>)}
          <label><input type="checkbox" checked={onlyChanges} onChange={(event) => { setOnlyChanges(event.target.checked); setCollapsedBranchIds(new Set()) }} />只看变化</label>
        </>}
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
        <div className={css.toolbarRight}>
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
        </div>
      </div>

      <div className={`${css.workbench} ${stage === 'evidence_mapping' ? css.threeColumns : ''}`}>
        {stage === 'evidence_mapping' && <aside className={css.sidePanel} aria-label="S3 已确认目录">
          <h3>S3 已确认目录 · 只读</h3>
          {baseline != null && buildOutlineView(baseline.sections)
            .filter(({ section }) => !onlyChanges || baselineVisible?.has(section.id))
            .map(({ section, number, depth }) =>
              <div key={section.id} ref={(element) => {
                if (element) baselineRows.current.set(section.id, element)
                else baselineRows.current.delete(section.id)
              }}
              className={`${css.baselineRow} ${selected?.id === section.id ? css.selected : ''} ${onlyChanges && !changed(section.id) ? css.muted : ''}`}
              aria-current={selected?.id === section.id ? 'true' : undefined} style={{ paddingLeft: (depth - 1) * 16 }}>
                {number} {section.title} {badges(section.id)}
              </div>)}
        </aside>}
        <div className={css.treeContainer} aria-label="技术标目录">
          {displayedSections.length === 0 && (
            <div className={css.emptySearch}>
              {searchQuery ? `未找到包含 "${searchQuery}" 的章节` : '暂无目录章节'}
            </div>
          )}

          {displayedSections.filter(({ section }) => !onlyChanges || currentVisible?.has(section.id)).map(({ section, number, depth }) => {
            const hasChildren = hasChildrenMap.get(section.id) ?? false
            const isBranchCollapsed = collapsedBranchIds.has(section.id)
            const indentPx = Math.max(0, depth - 1) * 20

            return (
              <article
                key={section.id}
                className={`${css.treeRow} ${selected?.id === section.id ? css.selected : ''} ${onlyChanges && !changed(section.id) ? css.muted : ''}`}
                onFocus={() => { setSelectedId(section.id) }}
                style={{ paddingLeft: `${String(indentPx)}px` }}
              >
                {draggedId !== null && <div className={css.dropTargets}>
                  {(['before', 'inside', 'after'] as const).map((position) => {
                    const operation = outlineDropOperation(outline, draggedId, section.id, position)
                    return <div key={position} role="button" tabIndex={-1} aria-disabled={operation === null}
                      aria-label={`${section.id} ${position}`}
                      className={operation === null ? css.dropDisabled : css.dropTarget}
                      onDragOver={(event) => { if (operation !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
                      onDrop={(event) => {
                        if (operation === null) return
                        event.preventDefault()
                        onStructureOperation(operation)
                        setSelectedId(draggedId)
                        setCollapsedBranchIds(new Set())
                        setDraggedId(null)
                      }}>
                      {{ before: '放在前面', inside: '作为子级', after: '放在后面' }[position]}
                    </div>
                  })}
                </div>}
                <div className={css.rowMain}>
                  {hasChildren ? (
                    <button
                      type="button"
                      className={css.collapseToggle}
                      aria-label={isBranchCollapsed ? `展开 ${section.title}` : `折叠 ${section.title}`}
                      onClick={() => { toggleBranch(section.id) }}
                    >
                      {isBranchCollapsed ? <IconChevronRightOutline14 /> : <IconChevronDownOutline14 />}
                    </button>
                  ) : (
                    <span className={css.collapsePlaceholder} />
                  )}

                  <button type="button" draggable aria-label={`拖动 ${section.title}`} className={css.dragHandle}
                    onClick={() => { setSelectedId(section.id) }}
                    // Let the browser capture the drag image before adding drop targets.
                    onDragStart={(event) => { event.dataTransfer.setData('application/x-bid-outline-section', section.id); event.dataTransfer.effectAllowed = 'move'; dragFrame.current = requestAnimationFrame(() => { setDraggedId(section.id) }) }}
                    onDragEnd={() => {
                      if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current)
                      setDraggedId(null)
                    }}>⠿</button>
                  <span className={css.sectionNumber} aria-label={`${section.id} 章节编号`}>
                    {number}
                  </span>

                  <div className={css.titleInputWrapper}>
                    <input
                      className={css.titleInput}
                      aria-label={`${section.id} 标题`}
                      value={section.title}
                      onChange={(event) => {
                        onUpdateSection(section.id, { title: event.target.value })
                      }}
                    />
                  </div>
                  {badges(section.id)}
                </div>



              </article>
            )
          })}
        </div>
        <aside className={css.sidePanel} aria-label="当前章节详情">
          <h3>当前章节关联内容</h3>
          {selected !== undefined && [selected].map((section) => {
            const siblings = outline.sections
              .filter(candidate => candidate.parent_id === section.parent_id)
              .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
            const index = siblings.findIndex(candidate => candidate.id === section.id)

            return <div key={section.id}>
              <h4>{section.title}</h4>
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
              <div className={css.cardActions}>
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
              </div>
              {section.summary && <p>{section.summary}</p>}
              {(
                <div className={css.cardDetails}>
                  <div className={css.detailField}>
                    <label className={css.detailLabel}>章节编写目的与应答范围</label>
                    <textarea
                      className={css.detailTextarea}
                      aria-label={`${section.id} 目的`}
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
