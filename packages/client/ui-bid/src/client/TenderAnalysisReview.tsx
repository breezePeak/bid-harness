import { useState } from 'react'
import type {
  TenderAnalysisConfirmationView,
  TenderAnalysisEditOperation,
  TenderProjectArtifact,
} from '@deepseek-ai/dsh-bid/control-plane'
import { Button, Input, Textarea } from '@deepseek-ai/dsh-client-ui-primitives'
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

/** Editable confirmation view for the four raw or normalized S2 artifacts. */
export function TenderAnalysisReview({ value, pending, onConfirm, t }: {
  value: TenderAnalysisConfirmationView
  pending: boolean
  onConfirm: (operations: readonly TenderAnalysisEditOperation[]) => void
  t: TranslateBid
}) {
  const [draft, setDraft] = useState<TenderAnalysisConfirmationView>(() => structuredClone(value))
  const updateProject = <K extends keyof TenderProjectArtifact>(key: K, next: TenderProjectArtifact[K]): void => {
    setDraft(current => ({ ...current, project: { ...current.project, [key]: next } }))
  }
  return <div className={css.root} aria-label={t('analysis.title')}>
    <section className={css.section}><h3>{t('analysis.project')}</h3><div className={css.projectGrid}>
      {TEXT_FIELDS.map(key => <label key={key} className={css.field}><span>{t(`analysis.project.${key}`)}</span><Input disabled={pending} value={draft.project[key] ?? ''} onChange={(event) => { updateProject(key, event.target.value || null) }} /></label>)}
      {ARRAY_FIELDS.map(key => <label key={key} className={css.field}><span>{t(`analysis.project.${key}`)}</span><Textarea disabled={pending} value={draft.project[key].join('\n')} onChange={(event) => { updateProject(key, lines(event.target.value)) }} /></label>)}
    </div></section>
    <section className={css.section}>
      <h3>技术要求</h3>
      <div className={css.scoringList}>
        {draft.requirements.requirements.map(item => <label key={item.id} className={css.field}>
          <span>{item.id} · {item.category}{item.mandatory ? ' · 强制' : ''}</span>
          <Textarea
            disabled={pending}
            value={item.normalized_requirement}
            onChange={(event) => {
              setDraft(current => ({
                ...current,
                requirements: {
                  ...current.requirements,
                  requirements: current.requirements.requirements.map(candidate => candidate.id === item.id
                    ? { ...candidate, normalized_requirement: event.target.value }
                    : candidate),
                },
              }))
            }}
          />
          <small>{item.raw_text}</small>
        </label>)}
      </div>
    </section>
    <section className={css.section}>
      <h3>{t('analysis.scoring')}</h3>
      <div className={css.scoringList}>
        {draft.scoring.scoring_items.map(item => <div key={item.id} className={css.scoringBody}>
          <label className={css.field}>
            <span>{item.id} · {t('analysis.scoring.title')}</span>
            <Input
              disabled={pending}
              value={item.title}
              onChange={(event) => {
                setDraft(current => ({
                  ...current,
                  scoring: {
                    ...current.scoring,
                    scoring_items: current.scoring.scoring_items.map(candidate => candidate.id === item.id
                      ? { ...candidate, title: event.target.value }
                      : candidate),
                  },
                }))
              }}
            />
          </label>
          <label className={css.field}>
            <span>{t('analysis.scoring.criterion')}</span>
            <Textarea
              disabled={pending}
              value={item.criterion}
              onChange={(event) => {
                setDraft(current => ({
                  ...current,
                  scoring: {
                    ...current.scoring,
                    scoring_items: current.scoring.scoring_items.map(candidate => candidate.id === item.id
                      ? { ...candidate, criterion: event.target.value }
                      : candidate),
                  },
                }))
              }}
            />
          </label>
          <small>{item.raw_text}</small>
        </div>)}
      </div>
    </section>
    <section className={css.section}>
      <h3>合规要求</h3>
      <div className={css.scoringList}>
        {draft.compliance.compliance_items.map(item => <label key={item.id} className={css.field}>
          <span>{item.id} · {item.type} · {item.severity}</span>
          <Textarea
            disabled={pending}
            value={item.normalized_rule}
            onChange={(event) => {
              setDraft(current => ({
                ...current,
                compliance: {
                  ...current.compliance,
                  compliance_items: current.compliance.compliance_items.map(candidate => candidate.id === item.id
                    ? { ...candidate, normalized_rule: event.target.value }
                    : candidate),
                },
              }))
            }}
          />
          <small>{item.raw_text}</small>
        </label>)}
      </div>
    </section>
    <div className={css.footer}><Button size="sm" variant="primary" disabled={pending} onClick={() => { onConfirm(buildOperations(value, draft)) }}>{pending ? t('analysis.confirming') : t('analysis.confirm')}</Button></div>
  </div>
}
