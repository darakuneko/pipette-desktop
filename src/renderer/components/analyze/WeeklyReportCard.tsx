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
    return [
      {
        labelKey: 'analyze.summary.weeklyReport.keystrokesLabel',
        value: report.current.keystrokes.toLocaleString(),
        unit: t('analyze.unit.keys'),
        context: deltaContext(report.keystrokesDelta, t),
        descriptionKey: 'analyze.summary.weeklyReport.keystrokesDesc',
      },
      {
        labelKey: 'analyze.summary.weeklyReport.wpmLabel',
        value: report.currentWpm > 0 ? formatWpm(report.currentWpm) : '—',
        context: deltaContext(report.wpmDelta, t),
        descriptionKey: 'analyze.summary.weeklyReport.wpmDesc',
      },
      {
        labelKey: 'analyze.summary.weeklyReport.activeDaysLabel',
        value: String(report.current.activeDays),
        unit: t('analyze.summary.weeklyReport.activeDaysUnit'),
        context: deltaContext(report.activeDaysDelta, t),
        descriptionKey: 'analyze.summary.weeklyReport.activeDaysDesc',
      },
    ]
  }, [report, t])

  return (
    <section className="flex flex-col gap-2" data-testid="analyze-weekly-report-section">
      <div className="flex items-baseline gap-3">
        <h3 className="text-[13px] font-semibold text-content">
          {t('analyze.summary.weeklyReport.sectionTitle')}
        </h3>
        <span className="text-[11px] text-content-muted">
          {t('analyze.summary.weeklyReport.activeMsContext', {
            current: formatActiveDuration(report.current.activeMs),
            previous: formatActiveDuration(report.previous.activeMs),
          })}
        </span>
      </div>
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
