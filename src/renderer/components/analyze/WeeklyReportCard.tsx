// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Summary — last-7-days vs prior-7-days comparison card.
// Reads from the same `daily` payload the parent already fetched so
// the card stays cheap; the heavy lifting (sample-size guard, trend
// classification) is in `analyze-weekly-report.ts` and is unit-tested.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingDailySummary } from '../../../shared/types/typing-analytics'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { AnalyzeStatGrid } from './stat-card'
import { formatActiveDuration } from './analyze-format'
import { formatWpm } from './analyze-wpm'
import {
  computeWeeklyReport,
  type Trend,
  type WeeklyDelta,
} from './analyze-weekly-report'

interface Props {
  daily: ReadonlyArray<TypingDailySummary>
  today: string
}

const TREND_GLYPH: Record<Trend, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
}

export function WeeklyReportCard({ daily, today }: Props) {
  const { t } = useTranslation()
  const report = useMemo(() => computeWeeklyReport(daily, today), [daily, today])

  const items: AnalyzeSummaryItem[] = useMemo(() => {
    // Order: Keystrokes → WPM → Typing → Active days. WPM is the only
    // card that keeps a tooltip, reusing the WPM tab's canonical
    // formula description; the other three are self-explanatory once
    // their delta context lands underneath the value.
    return [
      {
        labelKey: 'analyze.summary.weeklyReport.keystrokesLabel',
        value: report.current.keystrokes.toLocaleString(),
        unit: t('analyze.unit.keys'),
        context: deltaContext(report.keystrokesDelta, t),
      },
      {
        labelKey: 'analyze.summary.weeklyReport.wpmLabel',
        value: report.currentWpm > 0 ? formatWpm(report.currentWpm) : '—',
        context: deltaContext(report.wpmDelta, t),
        descriptionKey: 'analyze.wpm.description',
      },
      {
        labelKey: 'analyze.summary.weeklyReport.activeDurationLabel',
        value: report.current.activeMs > 0 ? formatActiveDuration(report.current.activeMs) : '—',
        context: t('analyze.summary.weeklyReport.activeDurationContext', {
          previous: formatActiveDuration(report.previous.activeMs),
        }),
      },
      {
        labelKey: 'analyze.summary.weeklyReport.activeDaysLabel',
        value: String(report.current.activeDays),
        unit: t('analyze.summary.weeklyReport.activeDaysUnit'),
        context: deltaContext(report.activeDaysDelta, t),
      },
    ]
  }, [report, t])

  return (
    <section className="flex flex-col gap-2" data-testid="analyze-weekly-report-section">
      <h3 className="text-[13px] font-semibold text-content">
        {t('analyze.summary.weeklyReport.sectionTitle')}
      </h3>
      <AnalyzeStatGrid
        items={items}
        ariaLabelKey="analyze.summary.weeklyReport.ariaLabel"
        testId="analyze-weekly-report"
      />
    </section>
  )
}

function deltaContext(
  delta: WeeklyDelta,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const glyph = TREND_GLYPH[delta.trend]
  if (delta.changePct === null) {
    return t('analyze.summary.weeklyReport.deltaInsufficient', { glyph })
  }
  const sign = delta.changePct > 0 ? '+' : ''
  return t('analyze.summary.weeklyReport.delta', {
    glyph,
    sign,
    pct: delta.changePct.toFixed(1),
  })
}
