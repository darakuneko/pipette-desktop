// SPDX-License-Identifier: GPL-2.0-or-later
// Shared compact stat card used by Peak Records and the Activity
// summary. Keeps the Analyze stat grids visually consistent — same
// label / value / unit / context stack, same typography, same
// surface/border tokens.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { Tooltip as UITooltip, type TooltipAlign, type TooltipSide } from '../ui/Tooltip'

const GRID_COLS = 4

interface Props {
  label: string
  value: ReactNode
  unit?: string
  context?: ReactNode
  testid?: string
  /** Description shown in a hover tooltip over the whole card. When
   * unset the card is rendered plain, without a tooltip wrapper. */
  description?: string
  /** Alignment for the tooltip bubble relative to the card. Defaults to
   * `center`; callers may set `end` for the right-most card in a row so
   * the bubble cannot overflow the viewport on the right. */
  tooltipAlign?: TooltipAlign
  /** Side the tooltip bubble pops from. Defaults to `top`; callers can
   * pass `bottom` for cards that sit at the very top of the viewport
   * (e.g. Today's Summary) so the bubble doesn't get clipped above. */
  tooltipSide?: TooltipSide
  /** Optional affordance rendered in the card's top-right corner —
   * used e.g. by the Daily Goal card to expose an inline edit button.
   * Kept generic so future cards can drop in their own trigger
   * without bespoke layout code. The action sits outside the tooltip
   * trigger area so clicking it doesn't fight the description bubble. */
  action?: ReactNode
}

export function StatCard({ label, value, unit, context, testid, description, tooltipAlign = 'center', tooltipSide = 'top', action }: Props) {
  const body = (
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

  const content = description ? (
    <UITooltip
      content={description}
      side={tooltipSide}
      align={tooltipAlign}
      wrapperClassName="block h-full w-full"
      className="max-w-xs"
    >
      {body}
    </UITooltip>
  ) : body

  // Render `action` as a sibling of the tooltip trigger (not inside it)
  // so that hovering/focusing the action doesn't also pop the card's
  // description tooltip.
  if (!action) return content
  return (
    <div className="relative h-full">
      {content}
      <div className="absolute right-2 top-2">{action}</div>
    </div>
  )
}

interface GridProps {
  items: ReadonlyArray<AnalyzeSummaryItem>
  ariaLabelKey: string
  testId?: string
  /** Side the per-card tooltip bubble pops from. Forwarded uniformly to
   * every card in the grid so the caller doesn't have to override per
   * cell. Defaults to `top`; pass `bottom` for grids at the top of the
   * viewport where an upward bubble would clip. */
  tooltipSide?: TooltipSide
}

/** Grid renderer for {@link AnalyzeSummaryItem}s that honours `unit`
 * and `context` — same API shape as {@link AnalyzeSummaryTable} so
 * callers can swap between the two without rewriting their item
 * generator. The grid is always 4 columns (Electron main window enforces
 * `minWidth: 1320` so the Tailwind `sm` breakpoint is always met). */
export function AnalyzeStatGrid({ items, ariaLabelKey, testId, tooltipSide }: GridProps) {
  const { t } = useTranslation()
  return (
    <div
      className="grid shrink-0 grid-cols-4 gap-2 overflow-x-clip"
      aria-label={t(ariaLabelKey)}
      data-testid={testId}
    >
      {items.map((item, index) => {
        // Anchor tooltips inward on the edge columns so their bubbles
        // can't overflow the viewport; partial final rows leave middle
        // cells that still look best center-aligned.
        const col = index % GRID_COLS
        const tooltipAlign = col === 0 ? 'start' : col === GRID_COLS - 1 ? 'end' : 'center'
        return (
          <StatCard
            key={item.labelKey}
            label={t(item.labelKey)}
            value={item.value}
            unit={item.unit}
            context={item.context}
            description={item.descriptionKey ? t(item.descriptionKey) : undefined}
            tooltipAlign={tooltipAlign}
            tooltipSide={tooltipSide}
            action={item.action}
          />
        )
      })}
    </div>
  )
}
