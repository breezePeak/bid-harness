import { useState, useMemo } from 'react'
import type { ReactNode } from 'react'
import type {
  TenderAnalysisConfirmationView,
  TenderAnalysisEditOperation,
} from '@deepseek-ai/dsh-bid/control-plane'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BidKey } from './locales.ts'
import css from './TenderAnalysisReview.module.css'

type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string
type ProjectArrayKey =
  | 'project_background'
  | 'project_objectives'
  | 'project_scope'
  | 'technical_scope'
  | 'delivery_scope'
  | 'implementation_constraints'
  | 'key_technical_points'
type ProjectTextKey = 'project_name' | 'tender_name' | 'purchaser' | 'owner'
const TEXT_FIELDS: readonly ProjectTextKey[] = ['project_name', 'tender_name', 'purchaser', 'owner']
const ARRAY_FIELDS: readonly ProjectArrayKey[] = [
  'project_background',
  'project_objectives',
  'project_scope',
  'technical_scope',
  'delivery_scope',
  'implementation_constraints',
  'key_technical_points',
]

function lines(value: string): string[] {
  return value.split('\n').map(item => item.trim()).filter(Boolean)
}

function buildOperations(source: TenderAnalysisConfirmationView, value: TenderAnalysisConfirmationView): TenderAnalysisEditOperation[] {
  const operations: TenderAnalysisEditOperation[] = []
  const fields: Extract<TenderAnalysisEditOperation, { type: 'update_project' }>['fields'] = {}
  for (const key of TEXT_FIELDS) if (value.project[key] !== source.project[key]) fields[key] = value.project[key]
  for (const key of ARRAY_FIELDS) {
    if (JSON.stringify(value.project[key]) !== JSON.stringify(source.project[key])) {
      fields[key] = [...value.project[key]]
    }
  }
  if (Object.keys(fields).length > 0) operations.push({ type: 'update_project', fields })
  for (const item of value.requirements.requirements) {
    const original = source.requirements.requirements.find(candidate => candidate.id === item.id)
    if (original === undefined) continue
    const changed: Extract<TenderAnalysisEditOperation, { type: 'update_requirement' }>['fields'] = {}
    if (item.normalized_requirement !== original.normalized_requirement) changed.normalized_requirement = item.normalized_requirement
    if (item.category !== original.category) changed.category = item.category
    if (item.mandatory !== original.mandatory) changed.mandatory = item.mandatory
    if (Object.keys(changed).length > 0) operations.push({ type: 'update_requirement', requirement_id: item.id, fields: changed })
  }
  for (const item of value.scoring.scoring_items) {
    const original = source.scoring.scoring_items.find(candidate => candidate.id === item.id)
    if (original === undefined) continue
    const changed: Extract<TenderAnalysisEditOperation, { type: 'update_scoring_item' }>['fields'] = {}
    if (item.title !== original.title) changed.title = item.title
    if (item.criterion !== original.criterion) changed.criterion = item.criterion
    if (item.must_answer !== original.must_answer) changed.must_answer = item.must_answer
    if (Object.keys(changed).length > 0) operations.push({ type: 'update_scoring_item', scoring_id: item.id, fields: changed })
  }
  for (const item of value.compliance.compliance_items) {
    const original = source.compliance.compliance_items.find(candidate => candidate.id === item.id)
    if (original === undefined) continue
    const changed: Extract<TenderAnalysisEditOperation, { type: 'update_compliance' }>['fields'] = {}
    if (item.type !== original.type) changed.type = item.type
    if (item.normalized_rule !== original.normalized_rule) changed.normalized_rule = item.normalized_rule
    if (item.severity !== original.severity) changed.severity = item.severity
    if (Object.keys(changed).length > 0) operations.push({ type: 'update_compliance', compliance_id: item.id, fields: changed })
  }
  return operations
}

type SectionCategory = 'all' | 'project' | 'requirements' | 'scoring' | 'compliance'

interface ReviewItem {
  key: string
  category: 'project' | 'requirements' | 'scoring' | 'compliance'
  categoryLabel: string
  id: string
  title: string
  subTitle?: string
  mandatory?: boolean
  score?: number | null
  rawText?: string
  severity?: string
}

/** S2 招标解析审核全屏工作台组件（对齐目录详情专业工作台风格） */
export function TenderAnalysisReview({
  value,
  pending,
  onConfirm,
  t,
  readOnly = false,
  notice,
}: {
  value: TenderAnalysisConfirmationView
  pending: boolean
  readOnly?: boolean
  notice?: ReactNode
  onConfirm: (operations: readonly TenderAnalysisEditOperation[]) => void
  t: TranslateBid
}) {
  const [draft, setDraft] = useState<TenderAnalysisConfirmationView>(() => structuredClone(value))
  const [selectedKey, setSelectedKey] = useState<string>('PROJ-project_name')
  const [activeCategory, setActiveCategory] = useState<SectionCategory>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [onlyMandatory, setOnlyMandatory] = useState(false)

  const mandatoryCount = draft.requirements.requirements.filter(r => r.mandatory).length
  const totalScore = draft.scoring.scoring_items.reduce((sum, item) => sum + (item.score ?? 0), 0)
  const modifiedOperations = buildOperations(value, draft)
  const docTitle = draft.project.tender_name || draft.project.project_name || t('analysis.title')

  // 构建扁平化的审查条目清单
  const allItems = useMemo<ReviewItem[]>(() => {
    const list: ReviewItem[] = []

    // 1. 项目基本要素
    for (const key of TEXT_FIELDS) {
      list.push({
        key: `PROJ-${key}`,
        category: 'project',
        categoryLabel: '基本概况',
        id: key,
        title: t(`analysis.project.${key}`),
        subTitle: draft.project[key] || '未填写',
      })
    }
    for (const key of ARRAY_FIELDS) {
      list.push({
        key: `PROJ-${key}`,
        category: 'project',
        categoryLabel: '建设要求',
        id: key,
        title: t(`analysis.project.${key}`),
        subTitle: draft.project[key].length > 0 ? `${draft.project[key].length} 项要点` : '未填写',
      })
    }

    // 2. 技术要求条款
    for (const req of draft.requirements.requirements) {
      list.push({
        key: `REQ-${req.id}`,
        category: 'requirements',
        categoryLabel: '技术要求',
        id: req.id,
        title: req.normalized_requirement || '未命名要求',
        subTitle: req.category,
        mandatory: req.mandatory,
        rawText: req.raw_text,
      })
    }

    // 3. 评分标准项
    for (const sc of draft.scoring.scoring_items) {
      list.push({
        key: `SCOR-${sc.id}`,
        category: 'scoring',
        categoryLabel: '评分标准',
        id: sc.id,
        title: sc.title || sc.criterion || '评分项',
        subTitle: sc.criterion,
        mandatory: sc.must_answer,
        score: sc.score,
        rawText: sc.raw_text,
      })
    }

    // 4. 合规要求
    for (const comp of draft.compliance.compliance_items) {
      list.push({
        key: `COMP-${comp.id}`,
        category: 'compliance',
        categoryLabel: '合规要求',
        id: comp.id,
        title: comp.normalized_rule || comp.id,
        subTitle: comp.type,
        mandatory: comp.severity === 'mandatory' || comp.severity === 'fatal',
        severity: comp.severity,
        rawText: comp.raw_text,
      })
    }

    return list
  }, [draft, t])

  // 列表过滤与搜索
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return allItems.filter((item) => {
      if (activeCategory !== 'all' && item.category !== activeCategory) return false
      if (onlyMandatory && !item.mandatory) return false
      if (!q) return true
      return (
        item.id.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        (item.subTitle && item.subTitle.toLowerCase().includes(q)) ||
        (item.rawText && item.rawText.toLowerCase().includes(q))
      )
    })
  }, [allItems, activeCategory, onlyMandatory, searchQuery])

  // 当前选中项，若过滤后丢失则自动定位至第一项
  const activeItem = useMemo(() => {
    const found = filteredItems.find(it => it.key === selectedKey)
    if (found) return found
    return filteredItems[0] ?? null
  }, [filteredItems, selectedKey])

  // 导航上一条 / 下一条
  const currentIndex = filteredItems.findIndex(it => it.key === activeItem?.key)
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex >= 0 && currentIndex < filteredItems.length - 1

  const handlePrev = () => {
    const previous = filteredItems[currentIndex - 1]
    if (hasPrev && previous) setSelectedKey(previous.key)
  }
  const handleNext = () => {
    const next = filteredItems[currentIndex + 1]
    if (hasNext && next) setSelectedKey(next.key)
  }

  // 状态更新方法
  const updateProjectField = (key: ProjectTextKey, val: string) => {
    setDraft(current => ({
      ...current,
      project: { ...current.project, [key]: val || null },
    }))
  }

  const updateProjectArrayField = (key: ProjectArrayKey, val: string) => {
    setDraft(current => ({
      ...current,
      project: { ...current.project, [key]: lines(val) },
    }))
  }

  const updateRequirement = (id: string, partial: Partial<TenderAnalysisConfirmationView['requirements']['requirements'][number]>) => {
    setDraft(current => ({
      ...current,
      requirements: {
        ...current.requirements,
        requirements: current.requirements.requirements.map(item => (item.id === id ? { ...item, ...partial } : item)),
      },
    }))
  }

  const updateScoring = (id: string, partial: Partial<TenderAnalysisConfirmationView['scoring']['scoring_items'][number]>) => {
    setDraft(current => ({
      ...current,
      scoring: {
        ...current.scoring,
        scoring_items: current.scoring.scoring_items.map(item => (item.id === id ? { ...item, ...partial } : item)),
      },
    }))
  }

  const updateCompliance = (id: string, partial: Partial<TenderAnalysisConfirmationView['compliance']['compliance_items'][number]>) => {
    setDraft(current => ({
      ...current,
      compliance: {
        ...current.compliance,
        compliance_items: current.compliance.compliance_items.map(item => (item.id === id ? { ...item, ...partial } : item)),
      },
    }))
  }

  return (
    <div className={css.root} aria-label={t('analysis.title')}>
      {/* 顶部 Header：吸顶概览卡片 + 工具栏（完全对标目录详情） */}
      <header className={css.header}>
        <div className={css.titleRow}>
          <div className={css.titleArea}>
            <span className={css.docTitle} title={docTitle}>
              {docTitle}
            </span>
            <span className={css.stagePill}>{readOnly ? '招标详情' : 'S2 · 招标解析确认'}</span>
          </div>
        </div>
        <div className={css.statsRow}>
          <div className={css.statsGrid}>
            <div className={css.statCard}>
              <span className={css.statLabel}>项目基本概况</span>
              <span className={css.statValue}>
                {TEXT_FIELDS.length + ARRAY_FIELDS.length}
                <span className={css.statSub}>项要素</span>
              </span>
            </div>
            <div className={css.statCard}>
              <span className={css.statLabel}>技术要求条款</span>
              <span className={css.statValue}>
                {draft.requirements.requirements.length}
                <span className={css.statSub}>项（{mandatoryCount} 强制）</span>
              </span>
            </div>
            <div className={css.statCard}>
              <span className={css.statLabel}>评分项标准</span>
              <span className={css.statValue}>
                {draft.scoring.scoring_items.length}
                <span className={css.statSub}>项（总分 {totalScore > 0 ? `${totalScore}分` : '待定'}）</span>
              </span>
            </div>
            <div className={css.statCard}>
              <span className={css.statLabel}>合规要求条目</span>
              <span className={css.statValue}>
                {draft.compliance.compliance_items.length}
                <span className={css.statSub}>项合规</span>
              </span>
            </div>
          </div>

          {!readOnly && (
            <div className={css.actionCard}>
              <Button
                size="sm"
                variant="primary"
                disabled={pending || readOnly}
                onClick={() => { onConfirm(modifiedOperations) }}
              >
                {pending ? t('analysis.confirming') : t('analysis.confirm')}
              </Button>
              <span className={css.actionHint}>
                {modifiedOperations.length > 0 ? `已调整 ${modifiedOperations.length} 项修改` : '审查完毕请确认结果'}
              </span>
            </div>
          )}
        </div>
        {notice}

        {/* 交互控制栏（Toolbar，对齐目录详情） */}
        <div className={css.toolbar}>
          <div className={css.toolbarLeft}>
            <input
              className={css.searchInput}
              type="search"
              placeholder="搜索条款、评分或要素..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            <div className={css.filterTabs} aria-label="模块筛选">
              {(
                [
                  ['all', '全部', allItems.length],
                  ['project', '项目整体情况', TEXT_FIELDS.length + ARRAY_FIELDS.length],
                  ['requirements', '技术要求', draft.requirements.requirements.length],
                  ['scoring', '技术评分要点', draft.scoring.scoring_items.length],
                  ['compliance', '合规要求条款', draft.compliance.compliance_items.length],
                ] as const
              ).map(([cat, label, count]) => (
                <button
                  key={cat}
                  type="button"
                  aria-pressed={activeCategory === cat}
                  className={`${css.filterTab} ${activeCategory === cat ? css.filterTabActive : ''}`}
                  onClick={() => {
                    setActiveCategory(cat)
                    const first = (cat === 'all' ? allItems : allItems.filter(i => i.category === cat))[0]
                    if (first) setSelectedKey(first.key)
                  }}
                >
                  <span>{label}</span>
                  <span className={css.tabCount}>{count}</span>
                </button>
              ))}
            </div>
          </div>
          <div className={css.toolbarRight}>
            <label className={css.toggleOption}>
              <input
                type="checkbox"
                checked={onlyMandatory}
                onChange={e => setOnlyMandatory(e.target.checked)}
              />
              <span>仅看强制/必答项</span>
            </label>
          </div>
        </div>
      </header>

      {/* 主体工作台：双栏专业工作台风格（左侧条目索引 + 右侧详情卡片） */}
      <div className={css.workbench}>
        {/* 左侧：条目列表面板 */}
        <aside className={css.listColumn} aria-label="条款要素导航">
          <div className={css.listHeader}>
            <span>解析条目清单</span>
            <span className={css.tabCount}>共 {filteredItems.length} 项</span>
          </div>
          <div className={css.listBody}>
            {filteredItems.length === 0 ? (
              <div className={css.emptyList}>
                {searchQuery ? `未找到匹配 "${searchQuery}" 的条目` : '暂无条目'}
              </div>
            ) : (
              filteredItems.map((item) => {
                const isSelected = activeItem?.key === item.key
                return (
                  <div
                    key={item.key}
                    className={`${css.itemRow} ${isSelected ? css.selected : ''}`}
                    onClick={() => setSelectedKey(item.key)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setSelectedKey(item.key)
                    }}
                  >
                    <div className={css.itemMain}>
                      <div className={css.itemIdRow}>
                        <span className={css.itemId}>{item.id}</span>
                        <span className={css.badgeCategory}>{item.categoryLabel}</span>
                        {item.mandatory && <span className={css.badgeMandatory}>强制</span>}
                        {item.score !== null && item.score !== undefined && (
                          <span className={css.badgeScore}>{item.score}分</span>
                        )}
                        {item.severity && item.severity !== 'mandatory' && (
                          <span className={css.badgeNormal}>{item.severity}</span>
                        )}
                      </div>
                      <div className={css.itemTitle} title={item.title}>
                        {item.title}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </aside>

        {/* 右侧：当前选中项详情与就地编辑工作区 */}
        <main className={css.detailColumn} aria-label="条款详情与编辑">
          {activeItem === null ? (
            <div className={css.emptyList}>请在左侧选择要查看或编辑的条目</div>
          ) : (
            <div className={css.cardDetails}>
              {/* 详情标题头 */}
              <div className={css.detailHeader}>
                <div className={css.detailHeaderTitle}>
                  <div className={css.detailId}>
                    <span>{activeItem.id}</span>
                    <span className={css.badgeCategory}>{activeItem.categoryLabel}</span>
                    {activeItem.mandatory && <span className={css.badgeMandatory}>强制/必答</span>}
                    {activeItem.score !== null && activeItem.score !== undefined && (
                      <span className={css.badgeScore}>{activeItem.score}分</span>
                    )}
                  </div>
                  <div className={css.detailCategoryTag}>{activeItem.title}</div>
                </div>
                <div className={css.detailNavButtons}>
                  <Button size="sm" variant="ghost" disabled={!hasPrev} onClick={handlePrev}>
                    上一项
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!hasNext} onClick={handleNext}>
                    下一项
                  </Button>
                </div>
              </div>

              {/* 1. 项目概况编辑表单 */}
              {activeItem.category === 'project' && (
                <div className={css.detailSection}>
                  <div className={css.detailSectionTitle}>
                    <span>要素内容设置</span>
                  </div>
                  {TEXT_FIELDS.includes(activeItem.id as ProjectTextKey) ? (
                    <div className={css.detailField}>
                      <label className={css.detailLabel}>属性内容</label>
                      <input
                        className={css.detailInput}
                        disabled={pending || readOnly}
                        aria-label={activeItem.title}
                        value={draft.project[activeItem.id as ProjectTextKey] ?? ''}
                        onChange={e => updateProjectField(activeItem.id as ProjectTextKey, e.target.value)}
                        placeholder="请输入属性内容..."
                      />
                    </div>
                  ) : (
                    <div className={css.detailField}>
                      <label className={css.detailLabel}>要点清单（每行一项）</label>
                      <textarea
                        className={css.detailTextarea}
                        rows={6}
                        disabled={pending || readOnly}
                        aria-label={activeItem.title}
                        value={draft.project[activeItem.id as ProjectArrayKey].join('\n')}
                        onChange={e => updateProjectArrayField(activeItem.id as ProjectArrayKey, e.target.value)}
                        placeholder="请输入要点清单，每行一条..."
                      />
                    </div>
                  )}
                </div>
              )}

              {/* 2. 技术要求编辑表单 */}
              {activeItem.category === 'requirements' && (() => {
                const req = draft.requirements.requirements.find(r => r.id === activeItem.id)
                if (!req) return null
                return (
                  <>
                    <div className={css.detailSection}>
                      <div className={css.detailSectionTitle}>
                        <span>技术要求内容</span>
                      </div>
                      <div className={css.detailField}>
                        <label className={css.detailLabel}>规范化技术要求条款描述（就地直接修改）</label>
                        <textarea
                          className={css.detailTextarea}
                          rows={4}
                          disabled={pending || readOnly}
                          aria-label="规范化技术要求"
                          value={req.normalized_requirement}
                          onChange={e => updateRequirement(req.id, { normalized_requirement: e.target.value })}
                        />
                      </div>
                      <div className={css.detailRow}>
                        <div className={css.inlineField}>
                          <label className={css.detailLabel}>条款性质：</label>
                          <label className={css.toggleOption}>
                            <input
                              type="checkbox"
                              disabled={pending || readOnly}
                              checked={req.mandatory}
                              onChange={e => updateRequirement(req.id, { mandatory: e.target.checked })}
                            />
                            <span style={{ fontWeight: req.mandatory ? 600 : 'normal' }}>
                              {req.mandatory ? '强制条款（必须响应）' : '一般技术条款'}
                            </span>
                          </label>
                        </div>
                        <div className={css.inlineField}>
                          <label className={css.detailLabel}>技术分类：</label>
                          <input
                            className={css.detailInput}
                            style={{ width: '160px', height: '28px' }}
                            disabled={pending || readOnly}
                            value={req.category}
                            onChange={e => updateRequirement(req.id, { category: e.target.value })}
                          />
                        </div>
                      </div>
                    </div>

                    {req.raw_text && (
                      <div className={css.rawTextCard}>
                        <div className={css.rawTextLabel}>
                          <span>招标原文依据 · Raw Text</span>
                        </div>
                        <div className={css.rawTextContent}>{req.raw_text}</div>
                      </div>
                    )}
                  </>
                )
              })()}

              {/* 3. 评分标准编辑表单 */}
              {activeItem.category === 'scoring' && (() => {
                const sc = draft.scoring.scoring_items.find(s => s.id === activeItem.id)
                if (!sc) return null
                return (
                  <>
                    <div className={css.detailSection}>
                      <div className={css.detailSectionTitle}>
                        <span>评分项设置</span>
                      </div>
                      <div className={css.detailField}>
                        <label className={css.detailLabel}>评分项名称</label>
                        <input
                          className={css.detailInput}
                          disabled={pending || readOnly}
                          aria-label="评分项名称"
                          value={sc.title}
                          onChange={e => updateScoring(sc.id, { title: e.target.value })}
                        />
                      </div>
                      <div className={css.detailField}>
                        <label className={css.detailLabel}>评分标准细则与判定准则</label>
                        <textarea
                          className={css.detailTextarea}
                          rows={4}
                          disabled={pending || readOnly}
                          aria-label="评分目标理解"
                          value={sc.criterion}
                          onChange={e => updateScoring(sc.id, { criterion: e.target.value })}
                        />
                      </div>
                      <div className={css.detailRow}>
                        <div className={css.inlineField}>
                          <label className={css.detailLabel}>响应要求：</label>
                          <label className={css.toggleOption}>
                            <input
                              type="checkbox"
                              disabled={pending || readOnly}
                              checked={sc.must_answer}
                              onChange={e => updateScoring(sc.id, { must_answer: e.target.checked })}
                            />
                            <span>{sc.must_answer ? '必答评分点' : '选答/普通评分'}</span>
                          </label>
                        </div>
                        {sc.score !== null && sc.score !== undefined && (
                          <div className={css.inlineField}>
                            <span className={css.detailLabel}>分值权重：</span>
                            <span className={css.badgeScore}>{sc.score} 分</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {sc.raw_text && (
                      <div className={css.rawTextCard}>
                        <div className={css.rawTextLabel}>
                          <span>招标原文依据 · Raw Text</span>
                        </div>
                        <div className={css.rawTextContent}>{sc.raw_text}</div>
                      </div>
                    )}
                  </>
                )
              })()}

              {/* 4. 合规要求编辑表单 */}
              {activeItem.category === 'compliance' && (() => {
                const comp = draft.compliance.compliance_items.find(c => c.id === activeItem.id)
                if (!comp) return null
                return (
                  <>
                    <div className={css.detailSection}>
                      <div className={css.detailSectionTitle}>
                        <span>合规规则设置</span>
                      </div>
                      <div className={css.detailField}>
                        <label className={css.detailLabel}>规范化合规规则（双击单元格模式升级为直接编辑）</label>
                        <textarea
                          className={css.detailTextarea}
                          rows={4}
                          disabled={pending || readOnly}
                          aria-label="规范化合规规则"
                          value={comp.normalized_rule}
                          onChange={e => updateCompliance(comp.id, { normalized_rule: e.target.value })}
                        />
                      </div>
                      <div className={css.detailRow}>
                        <div className={css.inlineField}>
                          <label className={css.detailLabel}>合规类型：</label>
                          <input
                            className={css.detailInput}
                            style={{ width: '160px', height: '28px' }}
                            disabled={pending || readOnly}
                            value={comp.type}
                            onChange={e => updateCompliance(comp.id, { type: e.target.value })}
                          />
                        </div>
                        <div className={css.inlineField}>
                          <label className={css.detailLabel}>严重级别：</label>
                          <span
                            className={
                              comp.severity === 'mandatory' || comp.severity === 'fatal'
                                ? css.badgeMandatory
                                : css.badgeNormal
                            }
                          >
                            {comp.severity}
                          </span>
                        </div>
                      </div>
                    </div>

                    {comp.raw_text && (
                      <div className={css.rawTextCard}>
                        <div className={css.rawTextLabel}>
                          <span>招标原文依据 · Raw Text</span>
                        </div>
                        <div className={css.rawTextContent}>{comp.raw_text}</div>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          )}
        </main>
      </div>

      {/* 底部轻量提示底栏 */}
      <footer className={css.footer}>
        <div className={css.footerHint}>
          {modifiedOperations.length > 0 ? (
            <span>
              已调整 <strong>{modifiedOperations.length}</strong> 个修改项，请点击右上角确认按钮完成确认
            </span>
          ) : (
            <span>支持左侧条目快速检索与分类切换 · 右侧就地编辑条目与核对原文依据 · 审查完毕请点击右上角确认进入下一步</span>
          )}
        </div>
      </footer>
    </div>
  )
}
