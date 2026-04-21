// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Activity — 24 × 7 grid of either keystroke counts or WPM
// by (day-of-week × hour-of-day). Both metrics share the same grid
// (dow on the y-axis, hour on the x-axis); only the cell color and
// summary row change between modes. See `analyze-activity.ts` for the
// aggregation rules.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingMinuteStatsRow } from '../../../shared/types/typing-analytics'
import {
  ACTIVITY_CELL_COUNT,
  ACTIVITY_HOUR_COUNT,
  buildActivityGrid,
  type ActivityCell,
  type ActivityKeystrokesSummary,
  type ActivityWpmSummary,
} from './analyze-activity'
import { formatActiveDuration, formatHourLabel } from './analyze-format'
import { AnalyzeSummaryTable, type AnalyzeSummaryItem } from './analyze-summary-table'
import { formatWpm } from './analyze-wpm'
import type { ActivityMetric, DeviceScope, RangeMs } from './analyze-types'

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
  metric: ActivityMetric
  /** Minimum `activeMs` per cell to count toward WPM peak / lowest
   * selection. Shared with the WPM tab's Min-sample filter. Has no
   * effect in `keystrokes` mode. */
  minActiveMs: number
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DOWS = [0, 1, 2, 3, 4, 5, 6] as const

export function ActivityChart({ uid, range, deviceScope, metric, minActiveMs }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TypingMinuteStatsRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const data = deviceScope === 'own'
          ? await window.vialAPI.typingAnalyticsListMinuteStatsLocal(uid, range.fromMs, range.toMs)
          : await window.vialAPI.typingAnalyticsListMinuteStats(uid, range.fromMs, range.toMs)
        if (!cancelled) setRows(data)
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, deviceScope, range])

  const grid = useMemo(
    () => buildActivityGrid({ rows, range, minActiveMs }),
    [rows, range, minActiveMs],
  )

  const summaryItems = useMemo<AnalyzeSummaryItem[] | null>(() => {
    if (grid.cells.length === 0) return null
    return metric === 'wpm'
      ? toWpmItems(grid.wpmSummary, t)
      : toKeystrokesItems(grid.keystrokesSummary, t)
  }, [grid, metric, t])

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-activity-loading">
        {t('common.loading')}
      </div>
    )
  }

  const isEmpty = metric === 'wpm' ? grid.maxWpm <= 0 : grid.maxKeystrokes <= 0
  if (isEmpty || grid.cells.length !== ACTIVITY_CELL_COUNT) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-activity-empty">
        {t('analyze.noData')}
      </div>
    )
  }

  const peak = metric === 'wpm' ? grid.maxWpm : grid.maxKeystrokes

  return (
    <div className="flex flex-col gap-2 text-[11px]" data-testid="analyze-activity-chart">
      <div
        className="grid gap-[2px]"
        style={{ gridTemplateColumns: 'auto repeat(24, minmax(0, 1fr))' }}
        role="table"
        aria-label={t(metric === 'wpm' ? 'analyze.activity.tableLabelWpm' : 'analyze.activity.tableLabel')}
      >
        <div role="row" className="contents">
          <div role="columnheader" aria-hidden="true" />
          {HOURS.map((h) => (
            <div
              key={`h-${h}`}
              role="columnheader"
              aria-label={t('analyze.activity.hourHeader', { hour: h })}
              className="text-center text-content-muted"
            >
              {h % 3 === 0 ? h.toString().padStart(2, '0') : ''}
            </div>
          ))}
        </div>
        {DOWS.map((d) => (
          <div key={`row-${d}`} role="row" className="contents">
            <div role="rowheader" className="pr-2 text-right text-content-muted">
              {t(`analyze.activity.dow.${d}`)}
            </div>
            {HOURS.map((h) => {
              const cell = grid.cells[d * ACTIVITY_HOUR_COUNT + h]
              const { opacity, saturation, title } = cellAppearance(cell, metric, peak, t)
              return (
                <div
                  key={`c-${d}-${h}`}
                  className="aspect-square rounded-sm"
                  style={{
                    backgroundColor: peak === 0 || cell === undefined || cell.keystrokes === 0
                      ? 'var(--color-surface-dim)'
                      : 'var(--color-accent)',
                    opacity,
                    filter: saturation < 1 ? `saturate(${saturation})` : undefined,
                  }}
                  title={title}
                  aria-label={title}
                  role="cell"
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1 text-content-muted">
        <span title={t('analyze.activity.legendLowDesc')}>{t('analyze.activity.legendLow')}</span>
        <div
          className="h-2 flex-1 rounded-sm"
          title={t('analyze.activity.legendScaleDesc')}
          style={{ background: 'linear-gradient(to right, var(--color-surface-dim), var(--color-accent))' }}
        />
        <span title={metric === 'wpm'
          ? t('analyze.activity.legendHighDescWpm', { wpm: formatWpm(peak) })
          : t('analyze.activity.legendHighDesc', { count: peak.toLocaleString() })}>
          {metric === 'wpm'
            ? t('analyze.activity.legendHighWpm', { wpm: formatWpm(peak) })
            : t('analyze.activity.legendHigh', { count: peak.toLocaleString() })}
        </span>
      </div>
      {summaryItems !== null && (
        <AnalyzeSummaryTable
          items={summaryItems}
          ariaLabelKey={metric === 'wpm' ? 'analyze.activity.wpm.summary.label' : 'analyze.activity.keystrokes.summary.label'}
          testId="analyze-activity-summary"
        />
      )}
    </div>
  )
}

interface CellAppearance {
  opacity: number
  /** `< 1` desaturates the cell to flag "not enough sample to trust"
   * (only used in WPM mode for cells below `minActiveMs`). */
  saturation: number
  title: string
}

function cellAppearance(
  cell: ActivityCell | undefined,
  metric: ActivityMetric,
  peak: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): CellAppearance {
  const dowLabel = cell ? t(`analyze.activity.dow.${cell.dow}`) : ''
  if (cell === undefined || cell.keystrokes === 0) {
    return {
      opacity: 0,
      saturation: 1,
      title: t('analyze.activity.cellTitle', { dow: dowLabel, hour: cell?.hour ?? 0, keystrokes: 0 }),
    }
  }
  if (metric === 'wpm') {
    const opacity = peak === 0 ? 0 : Math.max(0.08, cell.wpm / peak)
    return {
      opacity,
      saturation: cell.qualified ? 1 : 0.35,
      title: t('analyze.activity.cellTitleWpm', {
        dow: dowLabel,
        hour: cell.hour,
        wpm: formatWpm(cell.wpm),
        keystrokes: cell.keystrokes.toLocaleString(),
        activeDuration: formatActiveDuration(cell.activeMs),
      }),
    }
  }
  const opacity = peak === 0 ? 0 : Math.max(0.08, cell.keystrokes / peak)
  return {
    opacity,
    saturation: 1,
    title: t('analyze.activity.cellTitle', {
      dow: dowLabel,
      hour: cell.hour,
      keystrokes: cell.keystrokes.toLocaleString(),
    }),
  }
}

function formatCell(
  cell: ActivityCell,
  t: (key: string, opts?: Record<string, unknown>) => string,
  metric: ActivityMetric,
): string {
  const dow = t(`analyze.activity.dow.${cell.dow}`)
  const hour = formatHourLabel(cell.hour)
  if (metric === 'wpm') {
    return t('analyze.activity.cellWpmValue', { dow, hour, wpm: formatWpm(cell.wpm) })
  }
  return t('analyze.activity.cellKeystrokesValue', {
    dow,
    hour,
    keystrokes: cell.keystrokes.toLocaleString(),
  })
}

function toKeystrokesItems(
  summary: ActivityKeystrokesSummary,
  t: (key: string, opts?: Record<string, unknown>) => string,
): AnalyzeSummaryItem[] {
  const dowLabel = summary.mostFrequentDow === null
    ? '—'
    : t('analyze.activity.summaryDowValue', {
        dow: t(`analyze.activity.dow.${summary.mostFrequentDow.dow}`),
        keystrokes: summary.mostFrequentDow.keystrokes.toLocaleString(),
      })
  const hourLabel = summary.mostFrequentHour === null
    ? '—'
    : t('analyze.activity.summaryHourValue', {
        hour: summary.mostFrequentHour.hour.toString().padStart(2, '0'),
        keystrokes: summary.mostFrequentHour.keystrokes.toLocaleString(),
      })
  return [
    { labelKey: 'analyze.activity.keystrokes.summary.totalKeystrokes', value: summary.totalKeystrokes.toLocaleString() },
    { labelKey: 'analyze.activity.keystrokes.summary.activeDuration', value: formatActiveDuration(summary.activeMs) },
    { labelKey: 'analyze.activity.keystrokes.summary.mostFrequentDow', value: dowLabel },
    { labelKey: 'analyze.activity.keystrokes.summary.mostFrequentHour', value: hourLabel },
    { labelKey: 'analyze.activity.keystrokes.summary.peakCell', value: summary.peakCell === null ? '—' : formatCell(summary.peakCell, t, 'keystrokes') },
    { labelKey: 'analyze.activity.keystrokes.summary.activeCells', value: `${summary.activeCells} / ${ACTIVITY_CELL_COUNT}` },
  ]
}

function toWpmItems(
  summary: ActivityWpmSummary,
  t: (key: string, opts?: Record<string, unknown>) => string,
): AnalyzeSummaryItem[] {
  return [
    { labelKey: 'analyze.activity.wpm.summary.totalKeystrokes', value: summary.totalKeystrokes.toLocaleString() },
    { labelKey: 'analyze.activity.wpm.summary.activeDuration', value: formatActiveDuration(summary.activeMs) },
    { labelKey: 'analyze.activity.wpm.summary.overallWpm', value: formatWpm(summary.overallWpm) },
    { labelKey: 'analyze.activity.wpm.summary.peakCell', value: summary.peakCell === null ? '—' : formatCell(summary.peakCell, t, 'wpm') },
    { labelKey: 'analyze.activity.wpm.summary.lowestCell', value: summary.lowestCell === null ? '—' : formatCell(summary.lowestCell, t, 'wpm') },
    { labelKey: 'analyze.activity.wpm.summary.activeCells', value: `${summary.activeCells} / ${ACTIVITY_CELL_COUNT}` },
  ]
}
