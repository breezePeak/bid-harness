import { useState } from 'react'
import type {
  TenderAnalysisConfirmationView,
  TenderAnalysisEditOperation,
  TenderProjectArtifact,
  TenderScoringArtifact,
} from '@deepseek-ai/dsh-bid/control-plane'
import {
  Button,
  DisclosureRow,
  IconChecklistOutline14,
  Input,
  Pill,
  Textarea,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BidKey } from './locales.ts'
import css from './TenderAnalysisReview.module.css'

type TranslateBid = (key: BidKey, vars?: Record<string, string | number>) => string
type ProjectArrayKey =
  | 'project_background' | 'project_objectives' | 'project_scope' | 'technical_scope'
  | 'delivery_scope' | 'implementation_constraints' | 'key_technical_points'
type ProjectTextKey = 'project_name' | 'tender_name' | 'purchaser' | 'owner'

const TEXT_FIELDS: readonly ProjectTextKey[] = ['project_name', 'tender_name', 'purchaser', 'owner']
const ARRAY_FIELDS: readonly ProjectArrayKey[] = ['project_background', 'project_objectives', 'project_scope', 'technical_scope', 'delivery_scope', 'implementation_constraints', 'key_technical_points']

function lines(value: string): string[] {
  return value.split('\n').map(item => item.trim()).filter(Boolean)
}

function buildOperations(
  source: TenderAnalysisConfirmationView,
  project: TenderProjectArtifact,
  scoring: TenderScoringArtifact,
): TenderAnalysisEditOperation[] {
  const fields: Extract<TenderAnalysisEditOperation, { type: 'update_project' }>['fields'] = {}
  for (const key of TEXT_FIELDS) {
    const value = project[key]?.trim() || null
    if (value !== source.project[key]) fields[key] = value
  }
  for (const key of ARRAY_FIELDS) {
    if (JSON.stringify(project[key]) !== JSON.stringify(source.project[key])) fields[key] = [...project[key]]
  }
  const operations: TenderAnalysisEditOperation[] = Object.keys(fields).length === 0
    ? []
    : [{ type: 'update_project', fields }]
  for (const item of scoring.scoring_items) {
    const original = source.scoring.scoring_items.find(candidate => candidate.id === item.id)
    if (original === undefined) continue
    const operation: Extract<TenderAnalysisEditOperation, { type: 'update_scoring_item' }> = {
      type: 'update_scoring_item', scoring_id: item.id,
      ...(item.title === original.title ? {} : { title: item.title }),
      ...(item.criterion === original.criterion ? {} : { criterion: item.criterion }),
    }
    const changed = operation.title !== undefined || operation.criterion !== undefined
    if (changed) operations.push(operation)
    const catalog = source.response_point_catalog.points.filter(point => point.scoring_id === item.id)
      .sort((left, right) => left.order - right.order)
    const common = Math.min(catalog.length, item.response_points.length)
    for (let index = 0; index < common; index++) {
      const point = catalog[index]
      const next = item.response_points[index]
      if (point !== undefined && next !== undefined && point.text !== next) operations.push({
        type: 'update_response_point', scoring_id: item.id, response_point_id: point.id, text: next,
      })
    }
    for (const point of catalog.slice(item.response_points.length)) operations.push({
      type: 'delete_response_point', scoring_id: item.id, response_point_id: point.id,
    })
    for (let index = catalog.length; index < item.response_points.length; index++) {
      const pointText = item.response_points[index]
      if (pointText !== undefined) operations.push({ type: 'add_response_point', scoring_id: item.id, order: index + 1, text: pointText })
    }
  }
  return operations
}

/** Editable S2 project and technical-scoring review backed by controlled Host operations. */
export function TenderAnalysisReview({
  value,
  pending,
  onConfirm,
  t,
}: {
  value: TenderAnalysisConfirmationView
  pending: boolean
  onConfirm: (operations: readonly TenderAnalysisEditOperation[]) => void
  t: TranslateBid
}) {
  const [project, setProject] = useState<TenderProjectArtifact>(() => structuredClone(value.project))
  const [scoring, setScoring] = useState<TenderScoringArtifact>(() => structuredClone(value.scoring))
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  const updateScoring = (id: string, patch: Partial<Pick<TenderScoringArtifact['scoring_items'][number], 'title' | 'criterion' | 'response_points'>>): void => {
    setScoring(current => ({
      ...current,
      scoring_items: current.scoring_items.map(item => item.id === id ? { ...item, ...patch } : item),
    }))
  }

  return (
    <div className={css.root} aria-label={t('analysis.title')}>
      <section className={css.section}>
        <h3>{t('analysis.project')}</h3>
        <div className={css.projectGrid}>
          {TEXT_FIELDS.map(key => <label key={key} className={css.field}>
            <span>{t(`analysis.project.${key}`)}</span>
            <Input
              aria-label={t(`analysis.project.${key}`)}
              disabled={pending}
              value={project[key] ?? ''}
              onChange={(event) => {
                setProject(current => ({ ...current, [key]: event.target.value }))
              }}
            />
          </label>)}
          {ARRAY_FIELDS.map(key => <label key={key} className={css.field}>
            <span>{t(`analysis.project.${key}`)}</span>
            <Textarea
              aria-label={t(`analysis.project.${key}`)}
              disabled={pending}
              value={project[key].join('\n')}
              onChange={(event) => {
                setProject(current => ({ ...current, [key]: lines(event.target.value) }))
              }}
            />
          </label>)}
        </div>
      </section>
      <section className={css.section}>
        <h3>{t('analysis.scoring')}</h3>
        <div className={css.scoringList}>
          {scoring.scoring_items.map((item) => {
            const expanded = open.has(item.id)
            const score = item.score === null
              ? item.score_range === null ? '—' : `${String(item.score_range.min)}–${String(item.score_range.max)}`
              : String(item.score)
            return <DisclosureRow
              key={item.id}
              icon={<IconChecklistOutline14 />}
              title={item.title}
              open={expanded}
              expandable
              expandOnRowClick
              collapsedContent={<span className={css.summary}><Pill>{`${score} ${t('analysis.points')}`}</Pill><span>{item.response_points.slice(0, 2).join('；')}</span></span>}
              onToggle={() => {
                setOpen((current) => {
                  const next = new Set(current)
                  if (next.has(item.id)) next.delete(item.id); else next.add(item.id)
                  return next
                })
              }}
            >
              <div className={css.scoringBody}>
                <div className={css.meta}><Pill>{item.group ?? t('analysis.technical_group')}</Pill><Pill>{`${score} ${t('analysis.points')}`}</Pill></div>
                <label className={css.field}>
                  <span>{t('analysis.scoring.title')}</span>
                  <Input
                    aria-label={`${item.id} ${t('analysis.scoring.title')}`}
                    disabled={pending}
                    value={item.title}
                    onChange={(event) => { updateScoring(item.id, { title: event.target.value }) }}
                  />
                </label>
                <div className={css.readOnly}><strong>{t('analysis.scoring.raw_text')}</strong><p>{item.raw_text}</p></div>
                <label className={css.field}>
                  <span>{t('analysis.scoring.criterion')}</span>
                  <Textarea
                    aria-label={`${item.id} ${t('analysis.scoring.criterion')}`}
                    disabled={pending}
                    value={item.criterion}
                    onChange={(event) => { updateScoring(item.id, { criterion: event.target.value }) }}
                  />
                </label>
                <label className={css.field}>
                  <span>{t('analysis.scoring.response_points')}</span>
                  <Textarea
                    aria-label={`${item.id} ${t('analysis.scoring.response_points')}`}
                    disabled={pending}
                    value={item.response_points.join('\n')}
                    onChange={(event) => {
                      updateScoring(item.id, { response_points: lines(event.target.value) })
                    }}
                  />
                </label>
                <div className={css.readOnly}><strong>{t('analysis.scoring.source')}</strong><p>{item.source_refs.map(ref => `${ref.file_id} · ${ref.chunk}:${String(ref.line_start)}-${String(ref.line_end)}`).join('\n')}</p></div>
              </div>
            </DisclosureRow>
          })}
        </div>
      </section>
      <div className={css.footer}>
        <Button
          size="sm"
          variant="primary"
          disabled={pending}
          onClick={() => { onConfirm(buildOperations(value, project, scoring)) }}
        >
          {pending ? t('analysis.confirming') : t('analysis.confirm')}
        </Button>
      </div>
    </div>
  )
}
