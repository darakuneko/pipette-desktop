// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Activity — three metrics that share the Activity tab:
//
//  - `keystrokes` / `wpm`: 24 × 7 grid keyed by local (dow, hour).
//    Both derive from the minute-stats fetch; only the cell color and
//    summary row change between the two.
//
//  - `sessions`: session-length histogram sourced from
//    `typing_sessions`. A completely different data source and render
//    shape from the grid, kept in the same tab because it still
//    answers the "when / how much did I type?" question the Activity
//    tab exists to answer.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type {
  TypingMinuteStatsRow,
  TypingSessionRow,
} from '../../../shared/types/typing-analytics'
import {
  ACTIVITY_CELL_COUNT,
  ACTIVITY_HOUR_COUNT,
  buildActivityGrid,
  type ActivityCell,
} from './analyze-activity'
import { formatActiveDuration, formatSharePercent } from './analyze-format'
import { ANALYZE_TOOLTIP_DEFAULTS, boldValue } from './analyze-tooltip'
import {
  toKeystrokesItems,
  toSessionsItems,
  toWpmItems,
} from './analyze-activity-format'
import { buildSessionHistogram } from './analyze-sessions'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { AnalyzeStatGrid } from './stat-card'
import { Tooltip as UITooltip } from '../ui/Tooltip'
import { formatWpm } from './analyze-wpm'
import { isHashScope, isOwnScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type { ActivityCalendarFilters } from '../../../shared/types/analyze-filters'
import type { ActivityMetric, ActivityView, DeviceScope, RangeMs } from './analyze-types'
import { ActivityCalendarChart } from './ActivityCalendarChart'

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
  /** App filter — see WpmChart.Props.appScopes. */
  appScopes: string[]
  metric: ActivityMetric
  /** Chart geometry — `grid` keeps the existing 24×7 grid / sessions
   * histogram, `calendar` swaps to the year heatmap. */
  view: ActivityView
  /** Minimum `activeMs` per cell to count toward WPM peak / lowest
   * selection. Shared with the WPM tab's Min-sample filter. Has no
   * effect in `keystrokes` or `sessions` modes. */
  minActiveMs: number
  /** Persisted calendar subview state. Only consumed when
   * `view === 'calendar'`; the grid view ignores it. Required shape
   * (every field set) so the chart can read defaults the hook has
   * already applied. */
  calendarFilter: Required<ActivityCalendarFilters>
  /** Wall-clock used to clamp the year display to "no future"
   * (current year stops at today). Snapshot at parent mount so the
   * calendar render is stable while the page is open. */
  nowMs: number
  /** Calendar visible-window cursor shift. Calendar view only — the
   * grid/sessions branches never call it. The chart hosts the prev/next
   * buttons inside its own surface so the filter row stays compact. */
  onShiftCalendarMonth: (deltaMonths: number) => void
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DOWS = [0, 1, 2, 3, 4, 5, 6] as const

export function ActivityChart(props: Props) {
  if (props.view === 'calendar') {
    return (
      <ActivityCalendarChart
        uid={props.uid}
        deviceScope={props.deviceScope}
        appScopes={props.appScopes}
        metric={props.metric}
        calendarFilter={props.calendarFilter}
        nowMs={props.nowMs}
        onShiftEndMonth={props.onShiftCalendarMonth}
      />
    )
  }
  if (props.metric === 'sessions') {
    return (
      <SessionDistributionChart
        uid={props.uid}
        range={props.range}
        deviceScope={props.deviceScope}
      />
    )
  }
  return <ActivityGridChart {...props} />
}

function ActivityGridChart({ uid, range, deviceScope, appScopes, metric, minActiveMs }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TypingMinuteStatsRow[]>([])
  const [loading, setLoading] = useState(true)
  const scopeKey = scopeToSelectValue(deviceScope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const data = isHashScope(deviceScope)
          ? await window.vialAPI.typingAnalyticsListMinuteStatsForHash(uid, deviceScope.machineHash, range.fromMs, range.toMs, appScopes)
          : isOwnScope(deviceScope)
            ? await window.vialAPI.typingAnalyticsListMinuteStatsLocal(uid, range.fromMs, range.toMs, appScopes)
            : await window.vialAPI.typingAnalyticsListMinuteStats(uid, range.fromMs, range.toMs, appScopes)
        if (!cancelled) setRows(data)
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, scopeKey, range, appScopes])

  const grid = useMemo(
    () => buildActivityGrid({ rows, range, minActiveMs }),
    [rows, range, minActiveMs],
  )

  const totalKeystrokes = grid.keystrokesSummary.totalKeystrokes
  const summaryItems = useMemo<AnalyzeSummaryItem[] | null>(() => {
    if (grid.cells.length === 0) return null
    return metric === 'wpm'
      ? toWpmItems(grid.wpmSummary, t)
      : toKeystrokesItems(grid.keystrokesSummary, t)
  }, [grid, metric, t])

  const peak = metric === 'wpm' ? grid.maxWpm : grid.maxKeystrokes

  // Precomputed before the early returns below so Rules of Hooks stay satisfied.
  const cellsAppearance = useMemo(
    () => grid.cells.map((cell) => cellAppearance(cell, metric, peak, t, totalKeystrokes)),
    [grid, metric, peak, t, totalKeystrokes],
  )

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
              const index = d * ACTIVITY_HOUR_COUNT + h
              const cell = grid.cells[index]
              const { opacity, saturation, title } = cellsAppearance[index]
              return (
                <UITooltip
                  key={`c-${d}-${h}`}
                  content={title}
                  disabled={!title}
                  describedByOn="wrapper"
                  side={d === DOWS[0] ? 'bottom' : 'top'}
                  align={h === 0 ? 'start' : h === ACTIVITY_HOUR_COUNT - 1 ? 'end' : 'center'}
                  wrapperClassName="aspect-square"
                  wrapperProps={{
                    role: 'cell',
                    'aria-label': title,
                  }}
                >
                  <div
                    className="h-full w-full rounded-sm"
                    style={{
                      backgroundColor: peak === 0 || cell === undefined || cell.keystrokes === 0
                        ? 'var(--color-surface-dim)'
                        : 'var(--color-accent)',
                      opacity,
                      filter: saturation < 1 ? `saturate(${saturation})` : undefined,
                    }}
                    aria-hidden="true"
                  />
                </UITooltip>
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1 text-[11px] text-content-muted">
        <span>{t('analyze.activity.legendLow')}</span>
        <div
          className="h-2 flex-1 rounded-sm"
          style={{ background: 'linear-gradient(to right, var(--color-surface-dim), var(--color-accent))' }}
        />
        <span>
          {metric === 'wpm'
            ? t('analyze.activity.legendHighWpm', { wpm: formatWpm(peak) })
            : t('analyze.activity.legendHigh', { count: peak.toLocaleString() })}
        </span>
      </div>
      {summaryItems !== null && (
        <AnalyzeStatGrid
          items={summaryItems}
          ariaLabelKey={metric === 'wpm' ? 'analyze.activity.wpm.summary.label' : 'analyze.activity.keystrokes.summary.label'}
          testId="analyze-activity-summary"
        />
      )}
    </div>
  )
}

interface SessionChartProps {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
}

function SessionDistributionChart({ uid, range, deviceScope }: SessionChartProps) {
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<TypingSessionRow[]>([])
  const [loading, setLoading] = useState(true)
  const scopeKey = scopeToSelectValue(deviceScope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const data = isHashScope(deviceScope)
          ? await window.vialAPI.typingAnalyticsListSessionsForHash(uid, deviceScope.machineHash, range.fromMs, range.toMs)
          : isOwnScope(deviceScope)
            ? await window.vialAPI.typingAnalyticsListSessionsLocal(uid, range.fromMs, range.toMs)
            : await window.vialAPI.typingAnalyticsListSessions(uid, range.fromMs, range.toMs)
        if (!cancelled) setSessions(data)
      } catch {
        if (!cancelled) setSessions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, scopeKey, range])

  const histogram = useMemo(() => buildSessionHistogram(sessions), [sessions])
  const chartData = useMemo(
    () => histogram.bins.map((b) => ({
      id: b.id,
      label: t(`analyze.activity.sessions.bin.${b.id}`),
      count: b.count,
      share: b.share,
    })),
    [histogram, t],
  )
  const summaryItems = useMemo<AnalyzeSummaryItem[] | null>(
    () => histogram.summary.sessionCount === 0 ? null : toSessionsItems(histogram.summary),
    [histogram],
  )

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-activity-loading">
        {t('common.loading')}
      </div>
    )
  }

  if (histogram.summary.sessionCount === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-activity-empty">
        {t('analyze.noData')}
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col gap-2" data-testid="analyze-activity-sessions">
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
              stroke="var(--color-edge)"
              interval={0}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
              stroke="var(--color-edge)"
              allowDecimals={false}
            />
            <Tooltip
              {...ANALYZE_TOOLTIP_DEFAULTS}
              formatter={(_, __, entry) => {
                const c = Number(entry?.payload?.count ?? 0)
                const s = Number(entry?.payload?.share ?? 0)
                return [
                  boldValue(t('analyze.activity.sessions.tooltipValue', {
                    count: c.toLocaleString(),
                    share: formatSharePercent(s),
                  })),
                  t('analyze.activity.sessions.tooltipLabel'),
                ]
              }}
            />
            <Bar dataKey="count" fill="var(--color-accent)" isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {summaryItems !== null && (
        <AnalyzeStatGrid
          items={summaryItems}
          ariaLabelKey="analyze.activity.sessions.summary.label"
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
  totalKeystrokes: number,
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
    title: t('analyze.activity.cellTitleWithShare', {
      dow: dowLabel,
      hour: cell.hour,
      keystrokes: cell.keystrokes.toLocaleString(),
      share: formatSharePercent(totalKeystrokes > 0 ? cell.keystrokes / totalKeystrokes : 0),
    }),
  }
}
