import css from './BidProgressBar.module.css'

interface BidProgressBarProps {
  readonly value: number
  readonly max: number
  readonly ariaLabel?: string
  readonly warning?: boolean
}

/**
 * Render the shared S4 and S5 progress track.
 * @param props - Current value, total, accessible label, and warning state.
 * @returns A native progress element hidden from accessibility APIs when its parent owns the status label.
 */
export function BidProgressBar({ value, max, ariaLabel, warning = false }: BidProgressBarProps) {
  const safeMax = Math.max(max, 1)
  return (
    <progress
      className={`${css.bar}${warning ? ` ${css.warning}` : ''}`}
      data-bid-progress=""
      aria-label={ariaLabel}
      aria-hidden={ariaLabel === undefined ? true : undefined}
      value={Math.min(Math.max(value, 0), safeMax)}
      max={safeMax}
    />
  )
}
