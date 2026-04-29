// SPDX-License-Identifier: GPL-2.0-or-later
// Pure builders for the Activity tab's summary rows. Lives outside
// ActivityChart.tsx so the React-heavy component stays focused on
// rendering and so these helpers can be unit-tested without dragging
// Recharts / jsdom in.

import type { AnalyzeSummaryItem } from './analyze-summary-table'
import type {
  ActivityCell,
  ActivityKeystrokesSummary,
  ActivityWpmSummary,
} from './analyze-activity'
import { ACTIVITY_CELL_COUNT } from './analyze-activity'
import type { SessionDistributionSummary } from './analyze-sessions'
import type { ActivityMetric } from './analyze-types'
import { formatActiveDuration, formatHourLabel, formatSharePercent } from './analyze-format'
import { formatWpm } from './analyze-wpm'

type T = (key: string, opts?: Record<string, unknown>) => string

/** Keystroke count with the share-of-total appended so both signals
 * sit on the card without a normalize toggle. Callers pass `total`
 * from the same grid's summary; a `0` total collapses the share to
 * `'0.0'` (never divides by zero). */
function keysContext(t: T, keystrokes: number, total: number): string {
  return t('analyze.activity.summary.keysContext', {
    count: keystrokes.toLocaleString(),
    share: formatSharePercent(total > 0 ? keystrokes / total : 0),
  })
}

function cellValueContext(
  cell: ActivityCell,
  t: T,
  metric: ActivityMetric,
  total = 0,
): { value: string; context: string } {
  const dow = t(`analyze.activity.dow.${cell.dow}`)
  const hour = formatHourLabel(cell.hour)
  if (metric === 'wpm') {
    return {
      value: `${dow} ${hour}`,
      context: t('analyze.activity.summary.wpmContext', { wpm: formatWpm(cell.wpm) }),
    }
  }
  return {
    value: `${dow} ${hour}`,
    context: keysContext(t, cell.keystrokes, total),
  }
}

export function toKeystrokesItems(
  summary: ActivityKeystrokesSummary,
  t: T,
): AnalyzeSummaryItem[] {
  const dow = summary.mostFrequentDow
  const hour = summary.mostFrequentHour
  const peak = summary.peakCell
  const total = summary.totalKeystrokes
  return [
    {
      labelKey: 'analyze.activity.keystrokes.summary.mostFrequentDow',
      descriptionKey: 'analyze.activity.keystrokes.summary.mostFrequentDowDesc',
      value: dow === null ? '—' : t(`analyze.activity.dow.${dow.dow}`),
      context: dow === null ? undefined : keysContext(t, dow.keystrokes, total),
    },
    {
      labelKey: 'analyze.activity.keystrokes.summary.mostFrequentHour',
      descriptionKey: 'analyze.activity.keystrokes.summary.mostFrequentHourDesc',
      value: hour === null ? '—' : `${hour.hour.toString().padStart(2, '0')}:00`,
      context: hour === null ? undefined : keysContext(t, hour.keystrokes, total),
    },
    {
      labelKey: 'analyze.activity.keystrokes.summary.peakCell',
      descriptionKey: 'analyze.activity.keystrokes.summary.peakCellDesc',
      ...(peak === null
        ? { value: '—' }
        : cellValueContext(peak, t, 'keystrokes', total)),
    },
    {
      labelKey: 'analyze.activity.keystrokes.summary.activeCells',
      descriptionKey: 'analyze.activity.keystrokes.summary.activeCellsDesc',
      value: `${summary.activeCells} / ${ACTIVITY_CELL_COUNT}`,
    },
  ]
}

export function toWpmItems(summary: ActivityWpmSummary, t: T): AnalyzeSummaryItem[] {
  const peak = summary.peakCell
  const lowest = summary.lowestCell
  return [
    {
      labelKey: 'analyze.activity.wpm.summary.overallWpm',
      value: formatWpm(summary.overallWpm),
    },
    {
      labelKey: 'analyze.activity.wpm.summary.peakCell',
      descriptionKey: 'analyze.activity.wpm.summary.peakCellDesc',
      ...(peak === null ? { value: '—' } : cellValueContext(peak, t, 'wpm')),
    },
    {
      labelKey: 'analyze.activity.wpm.summary.lowestCell',
      descriptionKey: 'analyze.activity.wpm.summary.lowestCellDesc',
      ...(lowest === null ? { value: '—' } : cellValueContext(lowest, t, 'wpm')),
    },
    {
      labelKey: 'analyze.activity.wpm.summary.activeCells',
      descriptionKey: 'analyze.activity.wpm.summary.activeCellsDesc',
      value: `${summary.activeCells} / ${ACTIVITY_CELL_COUNT}`,
    },
  ]
}

export function toSessionsItems(summary: SessionDistributionSummary): AnalyzeSummaryItem[] {
  return [
    {
      labelKey: 'analyze.activity.sessions.summary.sessionCount',
      value: summary.sessionCount.toLocaleString(),
    },
    {
      labelKey: 'analyze.activity.sessions.summary.totalDuration',
      value: formatActiveDuration(summary.totalDurationMs),
    },
    {
      labelKey: 'analyze.activity.sessions.summary.meanDuration',
      value: summary.meanDurationMs === null ? '—' : formatActiveDuration(summary.meanDurationMs),
    },
    {
      labelKey: 'analyze.activity.sessions.summary.medianDuration',
      value: summary.medianDurationMs === null ? '—' : formatActiveDuration(summary.medianDurationMs),
    },
    {
      labelKey: 'analyze.activity.sessions.summary.longestDuration',
      value: summary.longestDurationMs === null ? '—' : formatActiveDuration(summary.longestDurationMs),
    },
    {
      labelKey: 'analyze.activity.sessions.summary.shortestDuration',
      value: summary.shortestDurationMs === null ? '—' : formatActiveDuration(summary.shortestDurationMs),
    },
  ]
}
