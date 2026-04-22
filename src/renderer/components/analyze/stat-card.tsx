// SPDX-License-Identifier: GPL-2.0-or-later
// Shared compact stat card used by Peak Records and the Activity
// summary. Keeps the Analyze stat grids visually consistent — same
// label / value / unit / context stack, same typography, same
// surface/border tokens.

import { useTranslation } from 'react-i18next'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { Tooltip as UITooltip } from '../ui/Tooltip'

interface Props {
  label: string
  value: string
  unit?: string
  context?: string
  testid?: string
  /** Description shown in a hover tooltip over the whole card. When
   * unset the card is rendered plain, without a tooltip wrapper. */
  description?: string
}

export function StatCard({ label, value, unit, context, testid, description }: Props) {
  const card = (
    <div
      className="flex h-full flex-col gap-0.5 rounded-md border border-edge bg-surface px-3 py-2"
      data-testid={testid}
    >
      <span className="text-[10px] font-semibold uppercase tracking-widest text-content-muted">
        {label}
      </span>
      <div className="flex items-baseline gap-1">
        <span className="text-[18px] font-bold text-content">{value}</span>
        {unit && <span className="text-[11px] text-content-muted">{unit}</span>}
      </div>
      {/* Non-breaking space keeps heights aligned when context is empty */}
      <span className="text-[10px] text-content-muted">{context || ' '}</span>
    </div>
  )

  if (!description) return card

  return (
    <UITooltip
      content={description}
      wrapperClassName="w-full"
      className="max-w-xs whitespace-normal"
    >
      {card}
    </UITooltip>
  )
}

interface GridProps {
  items: ReadonlyArray<AnalyzeSummaryItem>
  ariaLabelKey: string
  testId?: string
}

/** Grid renderer for {@link AnalyzeSummaryItem}s that honours `unit`
 * and `context` — same API shape as {@link AnalyzeSummaryTable} so
 * callers can swap between the two without rewriting their item
 * generator. */
export function AnalyzeStatGrid({ items, ariaLabelKey, testId }: GridProps) {
  const { t } = useTranslation()
  return (
    <div
      className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4"
      aria-label={t(ariaLabelKey)}
      data-testid={testId}
    >
      {items.map((item) => (
        <StatCard
          key={item.labelKey}
          label={t(item.labelKey)}
          value={item.value}
          unit={item.unit}
          context={item.context}
          description={item.descriptionKey ? t(item.descriptionKey) : undefined}
        />
      ))}
    </div>
  )
}
