// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Summary — at-a-glance card for the user's local calendar
// day. Daily summaries and the day pivot are owned by SummaryView so
// the card renders from props alone; that keeps the card cheap to
// re-render and lets the streak/goal sibling read the same payload
// without firing a second IPC.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingDailySummary } from '../../../shared/types/typing-analytics'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { AnalyzeStatGrid } from './stat-card'
import { EMPTY_STAT_VALUE } from './analyze-constants'
import { formatActiveDuration } from './analyze-format'
import { computeWpm, formatWpm } from './analyze-wpm'

interface Props {
  daily: ReadonlyArray<TypingDailySummary>
  today: string
}

export function TodaySummaryCard({ daily, today }: Props) {
  const { t } = useTranslation()

  const todaysEntry = useMemo(
    () => daily.find((d) => d.date === today) ?? null,
    [daily, today],
  )

  const items: AnalyzeSummaryItem[] = useMemo(() => {
    const keystrokes = todaysEntry?.keystrokes ?? 0
    const activeMs = todaysEntry?.activeMs ?? 0
    const wpm = computeWpm(keystrokes, activeMs)
    return [
      {
        labelKey: 'analyze.summary.today.keystrokesLabel',
        value: keystrokes > 0 ? keystrokes.toLocaleString() : EMPTY_STAT_VALUE,
        unit: t('analyze.unit.keys'),
      },
      {
        labelKey: 'analyze.summary.today.wpmLabel',
        value: wpm > 0 ? formatWpm(wpm) : EMPTY_STAT_VALUE,
        // Reuse the WPM tab's canonical description so the formula
        // explanation lives in one place; the today-specific blurb
        // duplicated it without adding new context.
        descriptionKey: 'analyze.wpm.description',
      },
      {
        labelKey: 'analyze.summary.today.activeDurationLabel',
        value: activeMs > 0 ? formatActiveDuration(activeMs) : EMPTY_STAT_VALUE,
      },
    ]
  }, [todaysEntry, t])

  return (
    <section className="flex flex-col gap-2" data-testid="analyze-today-summary-section">
      <h3 className="text-[13px] font-semibold text-content">
        {t('analyze.summary.today.sectionTitle')}
      </h3>
      <AnalyzeStatGrid
        items={items}
        ariaLabelKey="analyze.summary.today.ariaLabel"
        testId="analyze-today-summary"
        tooltipSide="bottom"
      />
    </section>
  )
}
