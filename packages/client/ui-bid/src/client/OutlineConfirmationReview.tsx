import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  buildOutlineView,
  type BidStage,
  type OutlineArtifact,
  type OutlineEditOperation,
} from '@deepseek-ai/dsh-bid/control-plane'
import {
  Button,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BidKey } from './locales.ts'
import css from './OutlineConfirmationReview.module.css'

type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string

export interface OutlineConfirmationReviewProps {
  outline: OutlineArtifact
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
 * Modern, hierarchical outline confirmation workbench for S3 and S4.
 * Highlights structure, coverage metrics, clean inline editing, and folding.
 */
export function OutlineConfirmationReview({
  outline,
  stage,
  draftSaveState = 'saved',
  revision,
  onUpdateSection,
  onStructureOperation,
  onIndentSection,
  onOutdentSection,
  t,
}: OutlineConfirmationReviewProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedBranchIds, setCollapsedBranchIds] = useState<ReadonlySet<string>>(() => new Set())
  const [expandedDetailIds, setExpandedDetailIds] = useState<ReadonlySet<string>>(() => new Set())
  const [globalDetailsOpen, setGlobalDetailsOpen] = useState(true)

  // 1. 统计计算
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

  // 2. 树状层级扁平化
  const viewSections = useMemo(() => buildOutlineView(outline.sections), [outline.sections])

  // 3. 构建父子映射
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

  // 4. 判断某节点是否因祖先被折叠而隐藏
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

  // 5. 过滤展示列表
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

  const toggleDetail = (sectionId: string): void => {
    setExpandedDetailIds((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  const stageLabel = stage === 'evidence_mapping'
    ? 'S4 · 深化目录与材料审核'
    : stage === 'outline_generation'
      ? 'S3 · 初步技术标目录审核'
      : '技术标目录审核'

  return (
    <div className={css.root}>
      {/* 顶部宏观概览与指标看板 */}
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

        {/* 核心指标统计 */}
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

      {/* 工具与控制栏 */}
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setGlobalDetailsOpen(!globalDetailsOpen) }}
          >
            {globalDetailsOpen ? '收起写作详情' : '展开写作详情'}
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

      {/* 目录树展示区 */}
      <div className={css.treeContainer} aria-label="技术标目录">
        {displayedSections.length === 0 && (
          <div className={css.emptySearch}>
            {searchQuery ? `未找到包含 "${searchQuery}" 的章节` : '暂无目录章节'}
          </div>
        )}

        {displayedSections.map(({ section, number, depth }) => {
          const hasChildren = hasChildrenMap.get(section.id) ?? false
          const isBranchCollapsed = collapsedBranchIds.has(section.id)
          const isDetailOpen = globalDetailsOpen || expandedDetailIds.has(section.id)
          const siblings = outline.sections
            .filter(candidate => candidate.parent_id === section.parent_id)
            .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
          const index = siblings.findIndex(candidate => candidate.id === section.id)

          const levelClass = depth === 1 ? css.levelRoot : depth === 2 ? css.levelSecond : css.levelSub
          const indentPx = Math.max(0, depth - 1) * 20

          return (
            <article
              key={section.id}
              className={`${css.sectionCard} ${levelClass}`}
              style={{ marginLeft: `${String(indentPx)}px` } as CSSProperties}
            >
              {/* 卡片主信息栏 */}
              <div className={css.cardMain}>
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

                {/* 结构调整操作按钮 */}
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
                  <button
                    type="button"
                    className={css.detailToggle}
                    onClick={() => { toggleDetail(section.id) }}
                  >
                    {isDetailOpen ? '收起详情' : '详情'}
                  </button>
                </div>
              </div>

              {/* 详情及写作要求编辑 */}
              {isDetailOpen && (
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
            </article>
          )
        })}
      </div>
    </div>
  )
}
