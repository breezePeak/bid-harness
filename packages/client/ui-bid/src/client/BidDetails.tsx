/** 已发布详情读取器；待确认阶段承载现有编辑面板。 */
import { useCallback, useEffect, useState } from 'react'
import type { BidDetailsView } from '@deepseek-ai/dsh-bid/control-plane'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TenderAnalysisReview } from './TenderAnalysisReview.tsx'
import { OutlineConfirmationReview } from './OutlineConfirmationReview.tsx'
import { zh } from './locales.ts'
import css from './BidReviewWorkbench.module.css'

interface BidDetailsProps extends ConvViewProps {
  kind: 'tender' | 'outline' | 'confirmation'
  getDetails: () => Promise<BidDetailsView>
  setReviewSurface: (element: HTMLElement | null) => void
}

/**
 * @param props 当前会话及只读详情请求。
 * @returns 已确认招标信息或目录；阶段更新后重新读取持久产物。
 */
export function BidDetails({ sessionId, useSessions, useProjection, kind, getDetails, setReviewSurface }: BidDetailsProps) {
  const isBid = useSessions(state => state.byId[sessionId]?.agentPreset === 'bid')
  const projection = useProjection('bid.runtime')
  const [details, setDetails] = useState<BidDetailsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const surface = useCallback((element: HTMLDivElement | null) => { setReviewSurface(element) }, [setReviewSurface])
  const label = kind === 'confirmation' ? '审核项' : kind === 'tender' ? '招标详情' : '目录详情'
  const confirming = kind === 'confirmation' || (kind === 'tender'
    ? projection?.allowedActions.includes('confirm_tender_analysis')
    : projection?.runtime.stage === 'evidence_mapping' && projection.allowedActions.includes('confirm_outline'))
  useEffect(() => {
    let active = true
    setDetails(null)
    setError(null)
    if ((isBid || confirming) && projection !== undefined && !confirming) {
      void getDetails().then((value) => { if (active) setDetails(value) }, (reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
    }
    return () => { active = false }
  }, [sessionId, isBid, projection?.runtime.stage, projection?.runtime.status, confirming, getDetails])
  if (projection === undefined || (!isBid && !confirming)) return null
  if (confirming) return (
    <section className={css.confirmationContainer} aria-label={label}>
      <div ref={surface} className={css.reviewSurfaceHost} />
    </section>
  )
  if (error !== null) return <section role="alert" className={css.error}>{error}</section>
  if (details === null) return <section className={css.loading}>正在读取详情…</section>
  if (kind === 'tender') return details.tender === null ? null : (
    <section className={css.confirmationContainer} aria-label="招标详情">
      <TenderAnalysisReview value={details.tender} pending={false} readOnly onConfirm={() => {}} t={key => zh[key]} />
    </section>
  )
  if (details.outline === null) return null
  const presentation = details.outlinePresentation
  if (presentation === null) return <section role="alert">目录来源与发布状态缺失，请刷新详情。</section>
  return (
    <section className={css.confirmationContainer} aria-label="目录详情">
      <OutlineConfirmationReview key={`${sessionId}:${presentation.source}`} outline={details.outline} readOnly
        hideStats
        stage={projection.runtime.stage}
        displayMode={presentation.source === 'initial_confirmed' ? 'initial' : presentation.source}
        notice={presentation.errors.map(message => <p role="alert" key={message}>{message}</p>)}
        reviewContext={details.tender === null ? null : {
          requirements: details.tender.requirements, scoring: details.tender.scoring,
          baseline: presentation.baseline, evidence: presentation.evidence,
        }}
        onUpdateSection={() => {}} onStructureOperation={() => {}}
        onIndentSection={() => {}} onOutdentSection={() => {}} t={key => zh[key]} />
    </section>
  )
}
