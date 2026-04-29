// SPDX-License-Identifier: GPL-2.0-or-later
// Date+time range picker built on react-day-picker (range mode).
// Replaces the native <input type="datetime-local"> pair with a single
// popover that shows the calendar plus HH:mm time inputs for from / to.
//
// State model:
//   - The committed range lives in the parent (`range` prop). Each
//     onChange emits the full clamped `RangeMs`.
//   - `pendingRange` is popover-local: it visualises the in-progress
//     DayPicker selection between the user's first and second click.
//     Once both endpoints are picked, the result is combined with the
//     current HH:mm strings, ms-clamped, and committed up via onChange,
//     after which `pendingRange` resets so a reopen reflects the
//     committed range.
//   - HH:mm strings are derived from `range` on every render — there's
//     no need to mirror them locally because committed ms is the
//     source of truth and time edits emit immediately.
//
// Half-open `[fromMs, toMs)` semantics are preserved verbatim from the
// previous datetime-local pair: this widget only chooses the (day,
// time) endpoints; the chart layer applies the half-open filter.

import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DayPicker, type DateRange, type Matcher } from 'react-day-picker'
import { endOfDay, format, startOfDay } from 'date-fns'
import { AnchoredPopover } from '../ui/AnchoredPopover'
import type { RangeMs } from './analyze-types'
import { FILTER_LABEL, FILTER_SELECT } from './analyze-filter-styles'

interface Props {
  range: RangeMs
  /** Active snapshot window. `null` lets the picker span freely from
   * `0` to `nowMs` — that's the path snapshot-less keyboards take. */
  snapshotBoundaries: { lo: number; hi: number } | null
  nowMs: number
  onChange: (next: RangeMs) => void
  labelKey: string
  /** Suffixes `-from` / `-to` to produce per-input data-testid values
   * so the e2e suite can distinguish the time inputs of each row. */
  testIdPrefix: string
}

const BUTTON_DATE_FMT = 'yyyy/MM/dd HH:mm'

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function formatHHmm(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function combineDayAndTime(day: Date, hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (m === null) return null
  const h = Number.parseInt(m[1], 10)
  const min = Number.parseInt(m[2], 10)
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  const out = new Date(day)
  out.setHours(h, min, 0, 0)
  return out.getTime()
}

function clampFrom(ms: number, range: RangeMs, lo: number | null): number {
  const lower = lo ?? Number.NEGATIVE_INFINITY
  return Math.min(Math.max(ms, lower), range.toMs)
}

function clampTo(ms: number, range: RangeMs, hi: number): number {
  return Math.min(Math.max(ms, range.fromMs), hi)
}

export function RangeDayPicker({
  range,
  snapshotBoundaries,
  nowMs,
  onChange,
  labelKey,
  testIdPrefix,
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pendingRange, setPendingRange] = useState<DateRange | undefined>(undefined)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Resetting `pendingRange` on close means a reopen always starts
  // from the committed range. AnchoredPopover handles outside click /
  // Escape and calls this when either fires.
  const handleClose = useCallback(() => {
    setOpen(false)
    setPendingRange(undefined)
  }, [])

  const fromTimeStr = formatHHmm(range.fromMs)
  const toTimeStr = formatHHmm(range.toMs)

  const committedRange: DateRange = useMemo(
    () => ({ from: new Date(range.fromMs), to: new Date(range.toMs) }),
    [range.fromMs, range.toMs],
  )
  const displayedRange = pendingRange ?? committedRange

  const buttonLabel = `${format(range.fromMs, BUTTON_DATE_FMT)} - ${format(range.toMs, BUTTON_DATE_FMT)}`

  // Disabled days: anything outside the snapshot window or future days
  // beyond `nowMs`. Boundary days remain selectable; ms-clamping in
  // `clampFrom` / `clampTo` then snaps a sub-day pick onto the lo/hi.
  const disabledDays = useMemo<Matcher[]>(() => {
    const out: Matcher[] = []
    if (snapshotBoundaries !== null) {
      out.push({ before: startOfDay(new Date(snapshotBoundaries.lo)) })
      out.push({ after: endOfDay(new Date(snapshotBoundaries.hi)) })
    } else {
      out.push({ after: endOfDay(new Date(nowMs)) })
    }
    return out
  }, [snapshotBoundaries, nowMs])

  const handleDayPickerSelect = (next: DateRange | undefined) => {
    setPendingRange(next)
    if (!next?.from || !next?.to) return
    const fromMs = combineDayAndTime(next.from, fromTimeStr)
    const toMs = combineDayAndTime(next.to, toTimeStr)
    if (fromMs === null || toMs === null) return
    const lo = snapshotBoundaries?.lo ?? null
    const hi = snapshotBoundaries?.hi ?? nowMs
    const clampedFrom = clampFrom(fromMs, { fromMs: range.fromMs, toMs: hi }, lo)
    const clampedTo = clampTo(toMs, { fromMs: clampedFrom, toMs: hi }, hi)
    onChange({ fromMs: clampedFrom, toMs: clampedTo })
    setPendingRange(undefined)
  }

  const handleFromTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const ms = combineDayAndTime(new Date(range.fromMs), e.target.value)
    if (ms === null) return
    const lo = snapshotBoundaries?.lo ?? null
    const fromMs = clampFrom(ms, range, lo)
    onChange({ fromMs, toMs: range.toMs })
  }

  const handleToTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const ms = combineDayAndTime(new Date(range.toMs), e.target.value)
    if (ms === null) return
    const hi = snapshotBoundaries?.hi ?? nowMs
    const toMs = clampTo(ms, range, hi)
    onChange({ fromMs: range.fromMs, toMs })
  }

  return (
    <label className={FILTER_LABEL}>
      <span>{t(labelKey)}</span>
      <button
        ref={triggerRef}
        type="button"
        className={`${FILTER_SELECT} flex items-center gap-1 text-left`}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testIdPrefix}
      >
        <span className="whitespace-nowrap">{buttonLabel}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onClose={handleClose}
        className="z-50 flex flex-col items-center rounded-md border border-edge bg-surface p-3 shadow-lg"
        role="dialog"
        data-testid={`${testIdPrefix}-popover`}
      >
        <DayPicker
          mode="range"
          selected={displayedRange}
          onSelect={handleDayPickerSelect}
          disabled={disabledDays}
          defaultMonth={new Date(range.fromMs)}
          navLayout="around"
          showOutsideDays
        />
        <div className="mt-2 flex items-center gap-2 border-t border-edge pt-2 text-[12px] text-content-secondary">
          <span className="whitespace-nowrap">{format(range.fromMs, 'yyyy/MM/dd')}</span>
          <input
            type="time"
            className={`${FILTER_SELECT} rdp-time-input`}
            value={fromTimeStr}
            onChange={handleFromTimeChange}
            onClick={(e) => {
              // Native time picker only opens off the indicator
              // by default; we hide that via CSS so the bare text
              // alone needs to call `showPicker()` to bring up
              // the dropdown. Wrapped in a typeof check for jsdom
              // / older Chromium that lacks the API.
              if (typeof e.currentTarget.showPicker === 'function') {
                e.currentTarget.showPicker()
              }
            }}
            data-testid={`${testIdPrefix}-from`}
          />
          <span aria-hidden="true">—</span>
          <span className="whitespace-nowrap">{format(range.toMs, 'yyyy/MM/dd')}</span>
          <input
            type="time"
            className={`${FILTER_SELECT} rdp-time-input`}
            value={toTimeStr}
            onChange={handleToTimeChange}
            onClick={(e) => {
              if (typeof e.currentTarget.showPicker === 'function') {
                e.currentTarget.showPicker()
              }
            }}
            data-testid={`${testIdPrefix}-to`}
          />
        </div>
      </AnchoredPopover>
    </label>
  )
}
