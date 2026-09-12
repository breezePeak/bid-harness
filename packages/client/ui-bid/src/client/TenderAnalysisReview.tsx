import { useEffect, useMemo, useRef, useState } from 'react'
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

type SectionCategory = 'project' | 'requirements' | 'scoring' | 'compliance'

/** S2 招标解析审核全屏工作台组件（对齐目录详情与导出 Word 专业表格风格） */
export function TenderAnalysisReview({
  value,
  pending,
  autoConfirm = false,
  onConfirm,
  t,
  readOnly = false,
  notice,
  onScoringSelectionChange,
}: {
  value: TenderAnalysisConfirmationView
  pending: boolean
  autoConfirm?: boolean
  readOnly?: boolean
  notice?: ReactNode
  onScoringSelectionChange?: (scoringId: string, selected: boolean) => Promise<TenderAnalysisConfirmationView>
  onConfirm: (operations: readonly TenderAnalysisEditOperation[]) => void
  t: TranslateBid
}) {
  const [draft, setDraft] = useState<TenderAnalysisConfirmationView>(() => structuredClone(value))
  const [activeCategory, setActiveCategory] = useState<SectionCategory>('project')
  const [searchQuery, setSearchQuery] = useState('')
  const [onlyMandatory, setOnlyMandatory] = useState(false)
  const [selectionPending, setSelectionPending] = useState<string | null>(null)

  const selectedScoringIds = new Set(draft.selected_scoring_ids)
  const modifiedOperations = buildOperations(value, draft)
  const automaticConfirmation = useRef({ onConfirm, operations: modifiedOperations })
  const automaticAttempted = useRef(false)
  automaticConfirmation.current = { onConfirm, operations: modifiedOperations }
  const docTitle = draft.project.tender_name || draft.project.project_name || t('analysis.title')

  useEffect(() => {
    if (!autoConfirm) {
      automaticAttempted.current = false
      return
    }
    if (pending || selectionPending !== null || automaticAttempted.current) return
    automaticAttempted.current = true
    automaticConfirmation.current.onConfirm(automaticConfirmation.current.operations)
  }, [autoConfirm, pending, selectionPending])


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

  const updateScoringSelection = (id: string, selected: boolean) => {
    if (onScoringSelectionChange === undefined || selectionPending !== null) return
    setSelectionPending(id)
    void onScoringSelectionChange(id, selected).then((next) => {
      setDraft(current => ({ ...current, selected_scoring_ids: [...next.selected_scoring_ids] }))
    }).catch(() => {}).finally(() => { setSelectionPending(null) })
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

  const filteredRequirements = useMemo(() => draft.requirements.requirements.filter((req) => {
    if (onlyMandatory && !req.mandatory) return false
    if (!searchQuery.trim()) return true
    const q = searchQuery.trim().toLowerCase()
    return req.id.toLowerCase().includes(q) ||
      req.normalized_requirement.toLowerCase().includes(q) ||
      req.category.toLowerCase().includes(q) ||
      (req.raw_text && req.raw_text.toLowerCase().includes(q))
  }), [draft.requirements.requirements, onlyMandatory, searchQuery])

  const filteredScoring = useMemo(() => draft.scoring.scoring_items.filter((sc) => {
    if (onlyMandatory && !sc.must_answer) return false
    if (!searchQuery.trim()) return true
    const q = searchQuery.trim().toLowerCase()
    return sc.id.toLowerCase().includes(q) ||
      sc.title.toLowerCase().includes(q) ||
      sc.criterion.toLowerCase().includes(q) ||
      (sc.raw_text && sc.raw_text.toLowerCase().includes(q))
  }), [draft.scoring.scoring_items, onlyMandatory, searchQuery])

  const filteredCompliance = useMemo(() => draft.compliance.compliance_items.filter((comp) => {
    if (onlyMandatory && comp.severity !== 'mandatory' && comp.severity !== 'fatal') return false
    if (!searchQuery.trim()) return true
    const q = searchQuery.trim().toLowerCase()
    return comp.id.toLowerCase().includes(q) ||
      comp.type.toLowerCase().includes(q) ||
      comp.normalized_rule.toLowerCase().includes(q) ||
      (comp.raw_text && comp.raw_text.toLowerCase().includes(q))
  }), [draft.compliance.compliance_items, onlyMandatory, searchQuery])

  return (
    <div className={css.root} aria-label={t('analysis.title')}>
      {/* 顶部 Header：标题与确认操作区 + 紧凑工具栏 */}
      <header className={css.header}>
        <div className={css.titleRow}>
          <div className={css.titleArea}>
            <span className={css.docTitle} title={docTitle}>
              {docTitle}
            </span>
            <span className={css.stagePill}>{readOnly ? '招标详情' : 'S2 · 招标解析确认'}</span>
          </div>

          {!readOnly && (
            <div className={css.headerActions}>
              <span className={css.actionHint}>
                {modifiedOperations.length > 0 ? `已调整 ${modifiedOperations.length} 项修改` : '审查完毕请确认结果'}
              </span>
              <Button
                size="sm"
                variant="primary"
                disabled={pending || selectionPending !== null || readOnly}
                onClick={() => { onConfirm(modifiedOperations) }}
              >
                {pending ? t('analysis.confirming') : t('analysis.confirm')}
              </Button>
            </div>
          )}
        </div>
        {notice}

        {/* 交互控制栏（Toolbar） */}
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
                  onClick={() => { setActiveCategory(cat) }}
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

      {/* 主体工作台：四大板块全量表格化展示（对齐导出 Word 页面表格样式） */}
      <div className={css.tableContainer}>
        {activeCategory === 'project' && (
          <table className={css.summaryTable}>
            <caption>项目整体情况要素表</caption>
            <thead>
              <tr>
                <th style={{ width: '60px', textAlign: 'center' }}>序号</th>
                <th style={{ width: '120px' }}>要素分类</th>
                <th style={{ width: '160px' }}>要素名称</th>
                <th>要素内容</th>
              </tr>
            </thead>
            <tbody>
              {TEXT_FIELDS.filter((key) => {
                if (!searchQuery.trim()) return true
                const q = searchQuery.trim().toLowerCase()
                const label = t(`analysis.project.${key}`).toLowerCase()
                const val = (draft.project[key] ?? '').toLowerCase()
                return label.includes(q) || val.includes(q) || key.toLowerCase().includes(q)
              }).map((key, index) => (
                <tr key={key}>
                  <td style={{ textAlign: 'center' }}>{index + 1}</td>
                  <td>基本概况</td>
                  <td style={{ fontWeight: 500 }}>{t(`analysis.project.${key}`)}</td>
                  <td>
                    {readOnly ? (
                      <div className={draft.project[key] ? css.tableTextReadonly : css.tableTextEmpty}>
                        {draft.project[key] || '未填写'}
                      </div>
                    ) : (
                      <input
                        className={css.tableInput}
                        disabled={pending || readOnly}
                        aria-label={t(`analysis.project.${key}`)}
                        value={draft.project[key] ?? ''}
                        onChange={e => updateProjectField(key, e.target.value)}
                        placeholder={`请输入${t(`analysis.project.${key}`)}...`}
                      />
                    )}
                  </td>
                </tr>
              ))}
              {ARRAY_FIELDS.filter((key) => {
                if (!searchQuery.trim()) return true
                const q = searchQuery.trim().toLowerCase()
                const label = t(`analysis.project.${key}`).toLowerCase()
                const val = draft.project[key].join('\n').toLowerCase()
                return label.includes(q) || val.includes(q) || key.toLowerCase().includes(q)
              }).map((key, index) => (
                <tr key={key}>
                  <td style={{ textAlign: 'center' }}>{TEXT_FIELDS.length + index + 1}</td>
                  <td>建设要求</td>
                  <td style={{ fontWeight: 500 }}>{t(`analysis.project.${key}`)}</td>
                  <td>
                    {readOnly ? (
                      <div className={draft.project[key].length > 0 ? css.tableTextReadonly : css.tableTextEmpty}>
                        {draft.project[key].length > 0 ? draft.project[key].join('\n') : '未填写'}
                      </div>
                    ) : (
                      <textarea
                        className={css.tableTextarea}
                        rows={Math.max(2, Math.min(draft.project[key].length, 6))}
                        disabled={pending || readOnly}
                        aria-label={t(`analysis.project.${key}`)}
                        value={draft.project[key].join('\n')}
                        onChange={e => updateProjectArrayField(key, e.target.value)}
                        placeholder={`请输入${t(`analysis.project.${key}`)}，每行一条...`}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeCategory === 'requirements' && (
          <table className={css.summaryTable}>
            <caption>技术要求条款清单</caption>
            <thead>
              <tr>
                <th style={{ width: '90px', textAlign: 'center' }}>需求编号</th>
                <th style={{ width: '130px' }}>技术分类</th>
                <th style={{ width: '90px', textAlign: 'center' }}>强制条款</th>
                <th>规范化技术要求条款描述</th>
                <th style={{ width: '30%' }}>招标原文依据</th>
              </tr>
            </thead>
            <tbody>
              {filteredRequirements.length === 0 ? (
                <tr>
                  <td colSpan={5} className={css.emptyList}>
                    {searchQuery ? `未找到匹配 "${searchQuery}" 的技术要求` : '暂无技术要求'}
                  </td>
                </tr>
              ) : (
                filteredRequirements.map(req => (
                  <tr key={req.id}>
                    <td className={css.cellCenter} style={{ fontWeight: 600 }}>{req.id}</td>
                    <td>
                      {readOnly ? (
                        <span className={css.badgeCategory}>{req.category}</span>
                      ) : (
                        <input
                          className={css.tableInput}
                          disabled={pending || readOnly}
                          value={req.category}
                          onChange={e => updateRequirement(req.id, { category: e.target.value })}
                        />
                      )}
                    </td>
                    <td className={css.cellCenter}>
                      <label className={css.tableCheckboxLabel}>
                        <input
                          type="checkbox"
                          disabled={pending || readOnly}
                          checked={req.mandatory}
                          onChange={e => updateRequirement(req.id, { mandatory: e.target.checked })}
                        />
                        <span className={req.mandatory ? css.badgeMandatory : css.badgeNormal}>
                          {req.mandatory ? '强制' : '一般'}
                        </span>
                      </label>
                    </td>
                    <td>
                      {readOnly ? (
                        <div className={css.tableTextReadonly}>{req.normalized_requirement}</div>
                      ) : (
                        <textarea
                          className={css.tableTextarea}
                          rows={3}
                          disabled={pending || readOnly}
                          value={req.normalized_requirement}
                          onChange={e => updateRequirement(req.id, { normalized_requirement: e.target.value })}
                        />
                      )}
                    </td>
                    <td>
                      <div className={css.rawTextCell}>{req.raw_text || '—'}</div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeCategory === 'scoring' && (
          <table className={css.summaryTable}>
            <caption>技术评分要点清单</caption>
            <thead>
              <tr>
                <th style={{ width: '90px', textAlign: 'center' }}>条款编号</th>
                <th style={{ width: '180px' }}>评分项名称</th>
                <th style={{ width: '70px', textAlign: 'center' }}>分值</th>
                <th style={{ width: '130px', textAlign: 'center' }}>纳入响应</th>
                <th style={{ width: '110px', textAlign: 'center' }}>响应要求</th>
                <th>评分目标理解与细则</th>
                <th style={{ width: '28%' }}>招标评分条款原文</th>
              </tr>
            </thead>
            <tbody>
              {filteredScoring.length === 0 ? (
                <tr>
                  <td colSpan={7} className={css.emptyList}>
                    {searchQuery ? `未找到匹配 "${searchQuery}" 的评分要点` : '暂无评分要点'}
                  </td>
                </tr>
              ) : (
                filteredScoring.map(sc => (
                  <tr key={sc.id}>
                    <td className={css.cellCenter} style={{ fontWeight: 600 }}>{sc.id}</td>
                    <td>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{sc.title}</div>
                      {!readOnly && (
                        <input
                          className={css.tableInput}
                          disabled={pending || readOnly}
                          aria-label="评分项名称"
                          value={sc.title}
                          onChange={e => updateScoring(sc.id, { title: e.target.value })}
                        />
                      )}
                    </td>
                    <td className={css.cellCenter}>
                      {sc.score !== null && sc.score !== undefined ? (
                        <span className={css.badgeScore}>{sc.score}分</span>
                      ) : '—'}
                    </td>
                    <td className={css.cellCenter}>
                      <label className={css.tableCheckboxLabel}>
                        <input
                          type="checkbox"
                          disabled={pending || selectionPending !== null || readOnly || onScoringSelectionChange === undefined}
                          checked={selectedScoringIds.has(sc.id)}
                          onChange={e => updateScoringSelection(sc.id, e.target.checked)}
                        />
                        <span className={selectedScoringIds.has(sc.id) ? css.badgeScore : css.badgeNormal}>
                          {selectedScoringIds.has(sc.id) ? '已纳入后续响应' : '未纳入后续响应'}
                        </span>
                      </label>
                    </td>
                    <td className={css.cellCenter}>
                      <label className={css.tableCheckboxLabel}>
                        <input
                          type="checkbox"
                          disabled={pending || readOnly}
                          checked={sc.must_answer}
                          onChange={e => updateScoring(sc.id, { must_answer: e.target.checked })}
                        />
                        <span className={sc.must_answer ? css.badgeMandatory : css.badgeNormal}>
                          {sc.must_answer ? '必答评分点' : '选答'}
                        </span>
                      </label>
                    </td>
                    <td>
                      {readOnly ? (
                        <div className={css.tableTextReadonly}>{sc.criterion}</div>
                      ) : (
                        <textarea
                          className={css.tableTextarea}
                          rows={3}
                          disabled={pending || readOnly}
                          value={sc.criterion}
                          onChange={e => updateScoring(sc.id, { criterion: e.target.value })}
                        />
                      )}
                    </td>
                    <td>
                      <div className={css.rawTextCell}>{sc.raw_text || '—'}</div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}

        {activeCategory === 'compliance' && (
          <table className={css.summaryTable}>
            <caption>合规要求条款清单</caption>
            <thead>
              <tr>
                <th style={{ width: '90px', textAlign: 'center' }}>合规编号</th>
                <th style={{ width: '120px' }}>合规类型</th>
                <th style={{ width: '100px', textAlign: 'center' }}>严重级别</th>
                <th>规范化合规规则</th>
                <th style={{ width: '30%' }}>招标原文依据</th>
              </tr>
            </thead>
            <tbody>
              {filteredCompliance.length === 0 ? (
                <tr>
                  <td colSpan={5} className={css.emptyList}>
                    {searchQuery ? `未找到匹配 "${searchQuery}" 的合规要求` : '暂无合规要求'}
                  </td>
                </tr>
              ) : (
                filteredCompliance.map(comp => (
                  <tr key={comp.id}>
                    <td className={css.cellCenter} style={{ fontWeight: 600 }}>{comp.id}</td>
                    <td>
                      {readOnly ? (
                        <span className={css.badgeCategory}>{comp.type}</span>
                      ) : (
                        <input
                          className={css.tableInput}
                          disabled={pending || readOnly}
                          value={comp.type}
                          onChange={e => updateCompliance(comp.id, { type: e.target.value })}
                        />
                      )}
                    </td>
                    <td className={css.cellCenter}>
                      <span className={comp.severity === 'mandatory' || comp.severity === 'fatal' ? css.badgeMandatory : css.badgeNormal}>
                        {comp.severity}
                      </span>
                    </td>
                    <td>
                      {readOnly ? (
                        <div className={css.tableTextReadonly}>{comp.normalized_rule}</div>
                      ) : (
                        <textarea
                          className={css.tableTextarea}
                          rows={3}
                          disabled={pending || readOnly}
                          value={comp.normalized_rule}
                          onChange={e => updateCompliance(comp.id, { normalized_rule: e.target.value })}
                        />
                      )}
                    </td>
                    <td>
                      <div className={css.rawTextCell}>{comp.raw_text || '—'}</div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* 底部轻量提示底栏 */}
      <footer className={css.footer}>
        <div className={css.footerHint}>
          {modifiedOperations.length > 0 ? (
            <span>
              已调整 <strong>{modifiedOperations.length}</strong> 个修改项，请点击右上角确认按钮完成确认
            </span>
          ) : (
            <span>支持表格单元格就地编辑与勾选调整 · 审查完毕请点击右上角确认进入下一步</span>
          )}
        </div>
      </footer>
    </div>
  )
}
