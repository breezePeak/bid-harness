import { useState, useEffect } from 'react'
import type {
  TenderAnalysisConfirmationView,
  TenderAnalysisEditOperation,
  TenderProjectArtifact,
} from '@deepseek-ai/dsh-bid/control-plane'
import { Button, Input, Textarea, IconEditOutline16, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
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
const ARRAY_FIELDS: readonly ProjectArrayKey[] = ['project_background', 'project_objectives', 'project_scope', 'technical_scope', 'delivery_scope', 'implementation_constraints', 'key_technical_points']

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

interface EditableCellProps {
  label: string
  value: string
  multiline?: boolean | undefined
  disabled?: boolean | undefined
  testLabel?: string | undefined
  onChange: (next: string) => void
}

/** 表格单元格双击编辑组件：默认直观展示，双击激活编辑 */
function EditableCell({
  label,
  value,
  multiline = false,
  disabled = false,
  testLabel,
  onChange,
}: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(value)

  useEffect(() => {
    setEditValue(value)
  }, [value])

  const handleDoubleClick = () => {
    if (disabled) return
    setIsEditing(true)
  }

  const handleSave = () => {
    setIsEditing(false)
    if (editValue !== value) {
      onChange(editValue)
    }
  }

  const handleCancel = () => {
    setEditValue(value)
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleCancel()
    } else if (e.key === 'Enter' && !multiline) {
      handleSave()
    }
  }

  const renderContent = () => {
    if (!value || value.trim() === '') {
      return <span className={css.cellValueEmpty}>（未填写，双击编辑）</span>
    }
    if (multiline) {
      const items = value.split('\n').filter(Boolean)
      if (items.length <= 1) {
        return <div className={css.cellValue}>{value}</div>
      }
      return (
        <ul className={css.valueList}>
          {items.map((lineText, idx) => (
            <li key={idx} className={css.valueListItem}>{lineText}</li>
          ))}
        </ul>
      )
    }
    return <div className={css.cellValue}>{value}</div>
  }

  if (isEditing) {
    return (
      <div className={css.cellEditing} onClick={e => e.stopPropagation()}>
        {multiline ? (
          <Textarea
            autoFocus
            aria-label={testLabel ?? label}
            disabled={disabled}
            value={editValue}
            onChange={(e) => {
              setEditValue(e.target.value)
              onChange(e.target.value)
            }}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <Input
            autoFocus
            aria-label={testLabel ?? label}
            disabled={disabled}
            value={editValue}
            onChange={(e) => {
              setEditValue(e.target.value)
              onChange(e.target.value)
            }}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
          />
        )}
        <div className={css.editActions}>
          <Button size="sm" variant="ghost" onClick={handleCancel}>取消</Button>
          <Button size="sm" variant="primary" onClick={handleSave}>完成</Button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={css.cellEditable}
      onDoubleClick={handleDoubleClick}
      title="双击可就地编辑内容"
    >
      <div className={css.hiddenInput}>
        {multiline ? (
          <Textarea
            aria-label={testLabel ?? label}
            disabled={disabled}
            value={value}
            onChange={(e) => {
              setEditValue(e.target.value)
              onChange(e.target.value)
            }}
          />
        ) : (
          <Input
            aria-label={testLabel ?? label}
            disabled={disabled}
            value={value}
            onChange={(e) => {
              setEditValue(e.target.value)
              onChange(e.target.value)
            }}
          />
        )}
      </div>
      <div className={css.cellHeader}>
        {renderContent()}
        <span className={css.hintText}>双击编辑</span>
        <button
          type="button"
          className={css.editIconBtn}
          title="编辑"
          aria-label={`编辑 ${label}`}
          onClick={(e) => {
            e.stopPropagation()
            handleDoubleClick()
          }}
        >
          <IconEditOutline16 />
        </button>
      </div>
    </div>
  )
}
/** S2 标书分析审核全屏工作台组件 */
export function TenderAnalysisReview({ value, pending, onConfirm, t }: {
  value: TenderAnalysisConfirmationView
  pending: boolean
  onConfirm: (operations: readonly TenderAnalysisEditOperation[]) => void
  t: TranslateBid
}) {
  const [draft, setDraft] = useState<TenderAnalysisConfirmationView>(() => structuredClone(value))
  // 4 个板块折叠状态管理（打开后默认折叠为 4 行，用户点击后展开对应板块）
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(['project', 'requirements', 'scoring', 'compliance']))

  const toggleSection = (sectionKey: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(sectionKey)) {
        next.delete(sectionKey)
      } else {
        next.add(sectionKey)
      }
      return next
    })
  }

  const updateProject = <K extends keyof TenderProjectArtifact>(key: K, next: TenderProjectArtifact[K]): void => {
    setDraft(current => ({ ...current, project: { ...current.project, [key]: next } }))
  }

  const mandatoryCount = draft.requirements.requirements.filter(r => r.mandatory).length
  const totalScore = draft.scoring.scoring_items.reduce((sum, item) => sum + (item.score ?? 0), 0)
  const modifiedOperations = buildOperations(value, draft)
  const docTitle = draft.project.tender_name || draft.project.project_name || t('analysis.title')

  return (
    <div className={css.root} aria-label={t('analysis.title')}>
      {/* 顶部 Header：概览卡片 + 右侧操作区（对应用户红框位置） */}
      <header className={css.header}>
        <div className={css.titleRow}>
          <div className={css.titleArea}>
            <span className={css.docTitle} title={docTitle}>
              {docTitle}
            </span>
            <span className={css.stagePill}>S2 · 招标解析确认</span>
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

          {/* 右侧红框位置：确认操作按钮卡片 */}
          <div className={css.actionCard}>
            <Button
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={() => { onConfirm(modifiedOperations) }}
            >
              {pending ? t('analysis.confirming') : t('analysis.confirm')}
            </Button>
            <span className={css.actionHint}>
              {modifiedOperations.length > 0 ? `已调整 ${modifiedOperations.length} 项修改` : '审查完毕请确认结果'}
            </span>
          </div>
        </div>
      </header>

      {/* 主体滚动区：四大业务板块，支持折叠成 4 行与展开表格展示 */}
      <div className={css.body}>
        {/* 板块 1: 项目整体情况 */}
        <section className={css.accordionSection}>
          <button
            type="button"
            className={css.accordionHeader}
            onClick={() => toggleSection('project')}
            aria-expanded={!collapsed.has('project')}
          >
            <span className={css.accordionTitle}>
              <span className={`${css.chevronIcon} ${!collapsed.has('project') ? css.chevronExpanded : ''}`}>
                <IconChevronRightOutline14 />
              </span>
              <span>{t('analysis.project')}</span>
              <span className={css.badge}>{TEXT_FIELDS.length + ARRAY_FIELDS.length} 项属性</span>
            </span>
            <span className={css.accordionSummary}>
              {collapsed.has('project') ? '点击展开表格' : '点击折叠'}
            </span>
          </button>
          {!collapsed.has('project') && (
            <div className={css.accordionContent}>
              <table className={css.reviewTable}>
                <thead>
                  <tr>
                    <th style={{ width: '60px', textAlign: 'center' }}>序号</th>
                    <th style={{ width: '120px' }}>要素分类</th>
                    <th style={{ width: '160px' }}>要素名称</th>
                    <th>要素内容（双击单元格可就地编辑）</th>
                  </tr>
                </thead>
                <tbody>
                  {TEXT_FIELDS.map((key, index) => (
                    <tr key={key}>
                      <td style={{ textAlign: 'center' }}>{index + 1}</td>
                      <td>基本信息</td>
                      <td style={{ fontWeight: 500 }}>{t(`analysis.project.${key}`)}</td>
                      <td>
                        <EditableCell
                          label={t(`analysis.project.${key}`)}
                          value={draft.project[key] ?? ''}
                          disabled={pending}
                          onChange={(next) => { updateProject(key, next || null) }}
                        />
                      </td>
                    </tr>
                  ))}
                  {ARRAY_FIELDS.map((key, index) => (
                    <tr key={key}>
                      <td style={{ textAlign: 'center' }}>{TEXT_FIELDS.length + index + 1}</td>
                      <td>建设范围与要求</td>
                      <td style={{ fontWeight: 500 }}>{t(`analysis.project.${key}`)}</td>
                      <td>
                        <EditableCell
                          label={t(`analysis.project.${key}`)}
                          value={draft.project[key].join('\n')}
                          multiline
                          disabled={pending}
                          onChange={(next) => { updateProject(key, lines(next)) }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 板块 2: 技术要求 */}
        <section className={css.accordionSection}>
          <button
            type="button"
            className={css.accordionHeader}
            onClick={() => toggleSection('requirements')}
            aria-expanded={!collapsed.has('requirements')}
          >
            <span className={css.accordionTitle}>
              <span className={`${css.chevronIcon} ${!collapsed.has('requirements') ? css.chevronExpanded : ''}`}>
                <IconChevronRightOutline14 />
              </span>
              <span>技术要求</span>
              <span className={css.badge}>{draft.requirements.requirements.length} 项要求</span>
              <span className={css.badgeMandatory}>{mandatoryCount} 强制</span>
            </span>
            <span className={css.accordionSummary}>
              {collapsed.has('requirements') ? '点击展开表格' : '点击折叠'}
            </span>
          </button>
          {!collapsed.has('requirements') && (
            <div className={css.accordionContent}>
              <table className={css.reviewTable}>
                <thead>
                  <tr>
                    <th style={{ width: '100px' }}>需求编号</th>
                    <th style={{ width: '120px' }}>技术分类</th>
                    <th style={{ width: '90px' }}>性质</th>
                    <th>规范化技术要求（双击单元格可就地编辑）</th>
                    <th style={{ width: '30%' }}>招标原文依据</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.requirements.requirements.map(item => (
                    <tr key={item.id}>
                      <td style={{ fontWeight: 600 }}>{item.id}</td>
                      <td>
                        <span className={css.badgeCategory}>{item.category}</span>
                      </td>
                      <td>
                        {item.mandatory ? (
                          <span className={css.badgeMandatory}>强制</span>
                        ) : (
                          <span className={css.badgeNormal}>一般</span>
                        )}
                      </td>
                      <td>
                        <EditableCell
                          label={item.id}
                          value={item.normalized_requirement}
                          multiline
                          disabled={pending}
                          onChange={(next) => {
                            setDraft(current => ({
                              ...current,
                              requirements: {
                                ...current.requirements,
                                requirements: current.requirements.requirements.map(candidate => candidate.id === item.id
                                  ? { ...candidate, normalized_requirement: next }
                                  : candidate),
                              },
                            }))
                          }}
                        />
                      </td>
                      <td className={css.rawText}>{item.raw_text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 板块 3: 评分标准 */}
        <section className={css.accordionSection}>
          <button
            type="button"
            className={css.accordionHeader}
            onClick={() => toggleSection('scoring')}
            aria-expanded={!collapsed.has('scoring')}
          >
            <span className={css.accordionTitle}>
              <span className={`${css.chevronIcon} ${!collapsed.has('scoring') ? css.chevronExpanded : ''}`}>
                <IconChevronRightOutline14 />
              </span>
              <span>{t('analysis.scoring')}</span>
              <span className={css.badge}>{draft.scoring.scoring_items.length} 条款</span>
              {totalScore > 0 && <span className={css.badgeScore}>总分 {totalScore} 分</span>}
            </span>
            <span className={css.accordionSummary}>
              {collapsed.has('scoring') ? '点击展开表格' : '点击折叠'}
            </span>
          </button>
          {!collapsed.has('scoring') && (
            <div className={css.accordionContent}>
              <table className={css.reviewTable}>
                <thead>
                  <tr>
                    <th style={{ width: '90px' }}>条款编号</th>
                    <th style={{ width: '200px' }}>评分项名称（双击编辑）</th>
                    <th style={{ width: '80px', textAlign: 'center' }}>分值</th>
                    <th style={{ width: '80px', textAlign: 'center' }}>必答</th>
                    <th>评分目标理解与细则（双击单元格可就地编辑）</th>
                    <th style={{ width: '28%' }}>招标评分条款原文</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.scoring.scoring_items.map(item => (
                    <tr key={item.id}>
                      <td style={{ fontWeight: 600 }}>{item.id}</td>
                      <td>
                        <EditableCell
                          label={`${item.id} · ${t('analysis.scoring.title')}`}
                          testLabel={t('analysis.scoring.title')}
                          value={item.title}
                          disabled={pending}
                          onChange={(next) => {
                            setDraft(current => ({
                              ...current,
                              scoring: {
                                ...current.scoring,
                                scoring_items: current.scoring.scoring_items.map(candidate => candidate.id === item.id
                                  ? { ...candidate, title: next }
                                  : candidate),
                              },
                            }))
                          }}
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {item.score !== null && item.score !== undefined ? (
                          <span className={css.badgeScore}>{item.score}分</span>
                        ) : '-'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {item.must_answer ? (
                          <span className={css.badgeMandatory}>必答</span>
                        ) : (
                          <span className={css.badgeNormal}>选答</span>
                        )}
                      </td>
                      <td>
                        <EditableCell
                          label={`${item.id} · ${t('analysis.scoring.criterion')}`}
                          testLabel={t('analysis.scoring.criterion')}
                          value={item.criterion}
                          multiline
                          disabled={pending}
                          onChange={(next) => {
                            setDraft(current => ({
                              ...current,
                              scoring: {
                                ...current.scoring,
                                scoring_items: current.scoring.scoring_items.map(candidate => candidate.id === item.id
                                  ? { ...candidate, criterion: next }
                                  : candidate),
                              },
                            }))
                          }}
                        />
                      </td>
                      <td className={css.rawText}>{item.raw_text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 板块 4: 合规要求 */}
        <section className={css.accordionSection}>
          <button
            type="button"
            className={css.accordionHeader}
            onClick={() => toggleSection('compliance')}
            aria-expanded={!collapsed.has('compliance')}
          >
            <span className={css.accordionTitle}>
              <span className={`${css.chevronIcon} ${!collapsed.has('compliance') ? css.chevronExpanded : ''}`}>
                <IconChevronRightOutline14 />
              </span>
              <span>合规要求</span>
              <span className={css.badge}>{draft.compliance.compliance_items.length} 项合规条款</span>
            </span>
            <span className={css.accordionSummary}>
              {collapsed.has('compliance') ? '点击展开表格' : '点击折叠'}
            </span>
          </button>
          {!collapsed.has('compliance') && (
            <div className={css.accordionContent}>
              <table className={css.reviewTable}>
                <thead>
                  <tr>
                    <th style={{ width: '100px' }}>合规编号</th>
                    <th style={{ width: '120px' }}>合规类型</th>
                    <th style={{ width: '100px' }}>严重级别</th>
                    <th>规范化合规规则（双击单元格可就地编辑）</th>
                    <th style={{ width: '30%' }}>招标原文依据</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.compliance.compliance_items.map(item => (
                    <tr key={item.id}>
                      <td style={{ fontWeight: 600 }}>{item.id}</td>
                      <td>
                        <span className={css.badgeCategory}>{item.type}</span>
                      </td>
                      <td>
                        <span className={item.severity === 'mandatory' ? css.badgeMandatory : css.badgeNormal}>
                          {item.severity}
                        </span>
                      </td>
                      <td>
                        <EditableCell
                          label={item.id}
                          value={item.normalized_rule}
                          multiline
                          disabled={pending}
                          onChange={(next) => {
                            setDraft(current => ({
                              ...current,
                              compliance: {
                                ...current.compliance,
                                compliance_items: current.compliance.compliance_items.map(candidate => candidate.id === item.id
                                  ? { ...candidate, normalized_rule: next }
                                  : candidate),
                              },
                            }))
                          }}
                        />
                      </td>
                      <td className={css.rawText}>{item.raw_text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* 底部保留轻量提示底栏 */}
      <footer className={css.footer}>
        <div className={css.footerHint}>
          {modifiedOperations.length > 0 ? (
            <span>已调整 <strong>{modifiedOperations.length}</strong> 个修改项，请点击右上角确认按钮完成确认</span>
          ) : (
            <span>支持双击单元格就地编辑 · 各板块可点击标题折叠成四行/展开 · 审查完毕请点击右上角确认进入下一步</span>
          )}
        </div>
      </footer>
    </div>
  )
}
