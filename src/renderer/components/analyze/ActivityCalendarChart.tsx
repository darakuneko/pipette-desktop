// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Activity > Calendar — GitHub-style heatmap over a sliding
// window of N calendar months ending at `endMonthIso` (3 / 6 / 12).
//
// Display-only: cells surface a hover tooltip but no click affordance;
// the surrounding Range size + ‹/› cursor drive range selection.
//
// Three value metrics share one render path:
//   - `keystrokes` / `wpm`: read from the daily summary fetch (always
//     issued so swapping between the two metrics is free).
//   - `sessions`: read from `typingAnalyticsListSessions[Local|ForHash]`,
//     fetched only when the user picks the metric so the year-span IPC
//     does not run for users who never look at sessions. Cell value is
//     "sessions started on this date" — the DB returns sessions whose
//     `start_ms` falls in the range, not the intersection set.
//
// Layout: dynamic week count (≤ 54) anchored at the range's first day,
// Sun-rows on top. Columns are `minmax(0, 1fr)` so cells fill the
// container width; row height is fixed at `CELL_HEIGHT_PX` so the
// 7-row grid stays a stable height regardless of weekCount (partial-
// year ranges with few columns would otherwise grow tall under
// `aspect-square`). Cells are rectangular when weekCount ≠ 24. The
// month-label strip rides the same column tracks so labels stay
// pinned to their week regardless of width.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isHashScope, isOwnScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type { TypingSessionRow } from '../../../shared/types/typing-analytics'
import { Tooltip as UITooltip, type TooltipAlign, type TooltipSide } from '../ui/Tooltip'
import {
  buildCalendarGrid,
  CALENDAR_DOW_COUNT,
  type CalendarCell,
} from './analyze-activity-calendar'
import { formatActiveDuration, formatSharePercent } from './analyze-format'
import { formatWpm } from './analyze-wpm'
import { MONTH_RE, parseLocalDate, toLocalDate, toLocalMonth } from './analyze-streak-goal'
import { useDailySummary } from './use-daily-summary'
import { AnalyzeStatGrid } from './stat-card'
import { FILTER_BUTTON } from './analyze-filter-styles'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import type {
  ActivityCalendarFilters,
  ActivityMetric,
} from '../../../shared/types/analyze-filters'
import type { DeviceScope } from './analyze-types'

const CELL_GAP_PX = 3
const ROW_HEADER_WIDTH_PX = 32

/** Fixed cell height. Sized to roughly match the grid view's cell height
 * in a typical desktop viewport so the two charts feel proportional.
 * Decoupling height from width lets columns flex (`1fr`) and fill the
 * container without partial-year ranges blowing up vertically. */
const CELL_HEIGHT_PX = 80

interface Props {
  uid: string
  deviceScope: DeviceScope
  /** App filter — see WpmChart.Props.appScopes. */
  appScopes: string[]
  /** Outer Activity metric — drives both the cell value and (when
   * `'sessions'`) the dedicated sessions IPC fetch. */
  metric: ActivityMetric
  /** Calendar normalization + visible-window cursor (`monthsToShow` +
   * `endMonthIso`). */
  calendarFilter: Required<ActivityCalendarFilters>
  /** Wall clock in ms used to clamp the visible end to "no future" (the
   * current month stops at today). Snapshot at mount in the parent so
   * the chart re-renders match the rest of the Analyze pane. */
  nowMs: number
  /** Shift the visible-window cursor (`endMonthIso`) by `deltaMonths`.
   * The chart hosts the prev/next buttons inline so the filter row
   * stays compact; the parent owns the actual state update. */
  onShiftEndMonth: (deltaMonths: number) => void
}

export function ActivityCalendarChart({
  uid,
  deviceScope,
  appScopes,
  metric,
  calendarFilter,
  nowMs,
  onShiftEndMonth,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const scopeKey = scopeToSelectValue(deviceScope)
  const { normalization, monthsToShow, endMonthIso } = calendarFilter

  // One source of truth for the calendar window. Both the daily-derived
  // grid and the sessions IPC consume the same `{from,to}` pair so the
  // grid's leftmost day and the IPC's lower bound can't disagree on
  // start-of-day alignment.
  const dateRange = useMemo(
    () => resolveWindow({ monthsToShow, endMonthIso, nowMs }),
    [monthsToShow, endMonthIso, nowMs],
  )

  const { daily, loading: dailyLoading } = useDailySummary(uid, deviceScope, appScopes)
  const [sessions, setSessions] = useState<TypingSessionRow[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)

  useEffect(() => {
    if (metric !== 'sessions') {
      setSessions([])
      setSessionsLoading(false)
      return
    }
    let cancelled = false
    setSessionsLoading(true)
    const { fromMs, toMs } = dateRange
    const sessionsPromise = isHashScope(deviceScope)
      ? window.vialAPI.typingAnalyticsListSessionsForHash(uid, deviceScope.machineHash, fromMs, toMs)
      : isOwnScope(deviceScope)
        ? window.vialAPI.typingAnalyticsListSessionsLocal(uid, fromMs, toMs)
        : window.vialAPI.typingAnalyticsListSessions(uid, fromMs, toMs)
    void sessionsPromise
      .then((rows) => { if (!cancelled) setSessions(rows) })
      .catch(() => { if (!cancelled) setSessions([]) })
      .finally(() => { if (!cancelled) setSessionsLoading(false) })
    return () => { cancelled = true }
  }, [uid, scopeKey, metric, dateRange])

  const grid = useMemo(
    () => buildCalendarGrid({
      daily,
      sessions,
      dateFromIso: dateRange.dateFromIso,
      dateToIso: dateRange.dateToIso,
      valueMetric: metric,
      normalization,
    }),
    [daily, sessions, dateRange.dateFromIso, dateRange.dateToIso, metric, normalization],
  )

  const summaryItems = useMemo<AnalyzeSummaryItem[] | null>(
    () => buildSummary(grid.summary, t),
    [grid, t],
  )

  // Sessions loading only counts when the user is on that metric — the
  // early-return effect above keeps `sessionsLoading` flipped off for
  // keystrokes/wpm, but folding the gate into the boolean here makes
  // the intent obvious to a future reader.
  const loading = dailyLoading || (metric === 'sessions' && sessionsLoading)

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-activity-calendar-loading">
        {t('common.loading')}
      </div>
    )
  }

  // Columns flex (`1fr`) so the chart fills the container width;
  // row height is fixed at `CELL_HEIGHT_PX` so partial-year ranges
  // don't grow tall. Cells become rectangular when weekCount ≠ 24
  // — accepted trade-off vs. a forced square aspect ratio. The
  // month-label strip rides the same column tracks so labels stay
  // pinned to their week regardless of container size.
  const gridTemplateColumns = `${ROW_HEADER_WIDTH_PX}px repeat(${grid.weekCount}, minmax(0, 1fr))`

  // `daily` returns the full per-uid history, so we can clamp prev/next
  // to the data-bearing window with a single linear scan each (lexical
  // = chronological for `YYYY-MM-DD`). Lower bound = `dateFromIso`,
  // upper bound = `dateToIso` (inclusive); the cursor stops at the
  // months containing the earliest / latest entry. Next also caps at
  // the current month so the user can't surface future days even when
  // future data accidentally landed in the store.
  const prevDisabled = !daily.some((d) => d.date < dateRange.dateFromIso)
  const nextDisabled =
    endMonthIso >= toLocalMonth(nowMs) ||
    !daily.some((d) => d.date > dateRange.dateToIso)

  return (
    <div className="flex w-full flex-col gap-3" data-testid="analyze-activity-calendar">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={FILTER_BUTTON}
          disabled={prevDisabled}
          onClick={() => onShiftEndMonth(-1)}
          aria-label={t('analyze.filters.calendarRangePrev')}
          data-testid="analyze-activity-calendar-prev"
        >
          ‹
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div
          className="grid h-4 text-[10px] leading-none text-content-muted"
          style={{ gridTemplateColumns, columnGap: CELL_GAP_PX }}
          aria-hidden="true"
        >
          {grid.monthLabels.map((m, i) => {
            // Year prefix only on the first label and at year boundaries
            // so a window like "2025-11 → 2026-04" reads as
            // `11月 12月 2026-1月 2月 3月 4月` — the prefix marks the
            // transition without crowding the others.
            const prev = grid.monthLabels[i - 1]
            const showYear = !prev || prev.year !== m.year
            const monthShort = t(`analyze.activity.calendar.monthShort.${m.month}`)
            const label = showYear
              ? t('analyze.activity.calendar.monthShortYear', { year: m.year, monthShort })
              : monthShort
            // +1 for 1-indexed CSS Grid lines, +1 for the rowheader column.
            return (
              <span
                key={`m-${m.year}-${m.month}`}
                style={{ gridColumn: m.weekIndex + 2 }}
              >
                {label}
              </span>
            )
          })}
        </div>
        <div
          className="grid"
          style={{
            gridTemplateColumns,
            gridAutoRows: `${CELL_HEIGHT_PX}px`,
            columnGap: CELL_GAP_PX,
            rowGap: CELL_GAP_PX,
          }}
          role="grid"
          aria-label={t('analyze.activity.calendar.gridLabel')}
        >
          {Array.from({ length: CALENDAR_DOW_COUNT }, (_, dow) => (
            <div key={`row-${dow}`} className="contents" role="row">
              <div
                role="rowheader"
                className="pr-1 text-right text-[10px] leading-none text-content-muted"
                style={{ alignSelf: 'center' }}
              >
                {t(`analyze.activity.dow.${dow}`)}
              </div>
              {grid.weeks.map((week, weekIndex) => (
                <CalendarCellView
                  key={`c-${weekIndex}-${dow}`}
                  cell={week[dow]}
                  metric={metric}
                  t={t}
                  // Pin the tooltip to the cell's near edge so it stays
                  // inside the grid: leftmost column → tooltip extends
                  // right, rightmost → extends left, middle → centered.
                  // Top row flips below so the tooltip doesn't clip
                  // above the month-label strip.
                  align={weekIndex === 0 ? 'start' : weekIndex === grid.weekCount - 1 ? 'end' : 'center'}
                  side={dow === 0 ? 'bottom' : 'top'}
                />
              ))}
            </div>
          ))}
        </div>
        </div>
        <button
          type="button"
          className={FILTER_BUTTON}
          disabled={nextDisabled}
          onClick={() => onShiftEndMonth(1)}
          aria-label={t('analyze.filters.calendarRangeNext')}
          data-testid="analyze-activity-calendar-next"
        >
          ›
        </button>
      </div>
      <div className="flex items-center gap-2 pt-1 text-[11px] text-content-muted">
        <span>{t('analyze.activity.legendLow')}</span>
        <div
          className="h-2 flex-1 rounded-sm"
          style={{ background: 'linear-gradient(to right, var(--color-surface-dim), var(--color-accent))' }}
        />
        <span>
          {metric === 'wpm'
            ? t('analyze.activity.legendHighWpm', { wpm: formatWpm(grid.summary.peakValue) })
            : t('analyze.activity.legendHigh', { count: Math.round(grid.summary.peakValue).toLocaleString() })}
        </span>
      </div>
      {summaryItems !== null && (
        <AnalyzeStatGrid
          items={summaryItems}
          ariaLabelKey="analyze.activity.calendar.summary.label"
          testId="analyze-activity-calendar-summary"
        />
      )}
    </div>
  )
}

interface CellProps {
  cell: CalendarCell | null
  metric: ActivityMetric
  t: ReturnType<typeof useTranslation>['t']
  align: TooltipAlign
  side: TooltipSide
}

const HEATMAP_MIN_OPACITY = 0.08

function CalendarCellView({
  cell,
  metric,
  t,
  align,
  side,
}: CellProps): JSX.Element {
  if (cell === null) {
    return <div role="gridcell" />
  }
  const opacity = !cell.qualified ? 0 : Math.max(HEATMAP_MIN_OPACITY, cell.intensity)
  const tooltip = formatCellTooltip(cell, metric, t)
  return (
    <UITooltip
      content={tooltip}
      side={side}
      align={align}
      describedByOn="wrapper"
      wrapperClassName="h-full w-full"
      wrapperProps={{ role: 'gridcell', 'aria-label': tooltip }}
    >
      <div
        className="h-full w-full rounded-[2px]"
        style={{
          backgroundColor: !cell.qualified ? 'var(--color-surface-dim)' : 'var(--color-accent)',
          opacity: !cell.qualified ? undefined : opacity,
        }}
        aria-hidden="true"
        data-testid={`analyze-activity-calendar-cell-${cell.date}`}
      />
    </UITooltip>
  )
}

function formatCellTooltip(
  cell: CalendarCell,
  metric: ActivityMetric,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  // Match the Period filter's `yyyy/MM/dd` formatting so cell tooltip
  // and range pickers share visual conventions. Cell `date` is already
  // a local-calendar `YYYY-MM-DD`, so a slash swap is enough.
  const date = cell.date.replace(/-/g, '/')
  if (!cell.qualified) {
    return t('analyze.activity.calendar.cellTooltipEmpty', { date })
  }
  if (metric === 'wpm') {
    return t('analyze.activity.calendar.cellTooltipWpm', {
      date,
      wpm: formatWpm(cell.value),
      activeDuration: formatActiveDuration(cell.activeMs),
    })
  }
  if (metric === 'sessions') {
    return t('analyze.activity.calendar.cellTooltipSessions', {
      date,
      count: cell.value.toLocaleString(),
    })
  }
  return t('analyze.activity.calendar.cellTooltipKeystrokes', {
    date,
    keystrokes: cell.value.toLocaleString(),
    activeDuration: formatActiveDuration(cell.activeMs),
  })
}

function buildSummary(
  summary: ReturnType<typeof buildCalendarGrid>['summary'],
  t: ReturnType<typeof useTranslation>['t'],
): AnalyzeSummaryItem[] | null {
  if (summary.totalDays === 0) return null
  const activeShare = summary.totalDays === 0
    ? 0
    : summary.activeDays / summary.totalDays
  // Match the Period filter's `yyyy/MM/dd` formatting so peak day and
  // range pickers share visual conventions. The summary's date strings
  // are already local-calendar `YYYY-MM-DD`, so a slash swap is enough.
  const peakLabel = summary.peakDate ? summary.peakDate.replace(/-/g, '/') : '—'
  const peakValue = summary.valueMetric === 'wpm'
    ? formatWpm(summary.peakValue)
    : summary.peakValue.toLocaleString()
  const totalLabel = summary.valueMetric === 'wpm'
    ? formatWpm(summary.activeDays === 0 ? 0 : summary.totalValue / summary.activeDays)
    : summary.totalValue.toLocaleString()
  const avgLabel = summary.valueMetric === 'wpm'
    ? formatWpm(summary.avgPerActiveDay)
    : Math.round(summary.avgPerActiveDay).toLocaleString()
  return [
    {
      labelKey: summary.valueMetric === 'wpm'
        ? 'analyze.activity.calendar.summary.avgWpm'
        : 'analyze.activity.calendar.summary.total',
      value: totalLabel,
    },
    {
      labelKey: 'analyze.activity.calendar.summary.activeDays',
      value: t('analyze.activity.calendar.summary.activeDaysValue', {
        active: summary.activeDays,
        total: summary.totalDays,
        share: formatSharePercent(activeShare),
      }),
    },
    { labelKey: 'analyze.activity.calendar.summary.peak', value: `${peakLabel} (${peakValue})` },
    { labelKey: 'analyze.activity.calendar.summary.avg', value: avgLabel },
  ]
}

interface ResolvedWindow {
  /** Inclusive lower bound (YYYY-MM-DD, local). */
  dateFromIso: string
  /** Inclusive upper bound (YYYY-MM-DD, local). */
  dateToIso: string
  /** Inclusive lower bound in ms, aligned to local-day 00:00. The
   * sessions IPC consumes this. Aligning to start-of-day keeps the
   * IPC's `start_ms` window from clipping the rolling-365 first day. */
  fromMs: number
  /** Exclusive upper bound in ms, aligned to start-of-next-local-day.
   * Sessions started up to (but not including) this instant are
   * included — matches the SQL `start_ms < toMs` convention. */
  toMs: number
}

function resolveWindow({
  monthsToShow,
  endMonthIso,
  nowMs,
}: {
  monthsToShow: number
  endMonthIso: string
  nowMs: number
}): ResolvedWindow {
  // Parse `YYYY-MM` → year/month (1-indexed). Falls back to "current
  // local month" if the persisted string is malformed (validator should
  // catch this, but the chart should not crash on bad data).
  const m = MONTH_RE.exec(endMonthIso)
  const now = new Date(nowMs)
  const endYear = m ? Number.parseInt(m[1], 10) : now.getFullYear()
  const endMonth = m ? Number.parseInt(m[2], 10) : now.getMonth() + 1
  // Calendar window is `[start of (endMonth - monthsToShow + 1), end of
  // endMonth]`. The IPC still queries up to start-of-next-month to cover
  // late-month sessions; the visible grid caps at "today" so the current
  // month doesn't surface future days.
  const startDate = new Date(endYear, endMonth - 1 - (monthsToShow - 1), 1)
  const startOfNextMonth = new Date(endYear, endMonth, 1)
  const lastDayOfEndMonth = new Date(endYear, endMonth, 0)
  const todayIso = toLocalDate(nowMs)
  const startOfTodayMs = parseLocalDate(todayIso)?.getTime() ?? nowMs
  const visibleEndMs = Math.min(lastDayOfEndMonth.getTime(), startOfTodayMs)
  return {
    dateFromIso: toLocalDate(startDate.getTime()),
    dateToIso: toLocalDate(visibleEndMs >= startDate.getTime() ? visibleEndMs : startDate.getTime()),
    fromMs: startDate.getTime(),
    toMs: startOfNextMonth.getTime(),
  }
}
