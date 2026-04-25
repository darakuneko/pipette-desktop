// SPDX-License-Identifier: GPL-2.0-or-later
// Date-time From / To pair with snapshot-aware clamping. The Analyze
// page renders this twice — once for the primary range and once for
// the compare-range — so the clamp invariant lives here in one place
// instead of drifting across two near-identical input pairs.

import { useTranslation } from 'react-i18next'
import type { RangeMs } from './analyze-types'
import { FILTER_LABEL, FILTER_SELECT } from './analyze-filter-styles'

/** `YYYY-MM-DDTHH:mm` serialisation (local timezone) that HTML's
 * `<input type="datetime-local">` expects. Module-private — only the
 * input bindings here use this exact shape. */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear().toString().padStart(4, '0')
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const h = d.getHours().toString().padStart(2, '0')
  const mi = d.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${day}T${h}:${mi}`
}

function fromLocalInputValue(value: string): number | null {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

interface Props {
  range: RangeMs
  /** Active snapshot window. `null` lets the inputs span freely from
   * `0` to `nowMs` — that's the path snapshot-less keyboards take. */
  snapshotBoundaries: { lo: number; hi: number } | null
  nowMs: number
  onChange: (next: RangeMs) => void
  fromLabelKey: string
  toLabelKey: string
  /** Suffixes `-from` / `-to` to produce per-input data-testid values
   * so the e2e suite can distinguish primary vs compare rows. */
  testIdPrefix: string
}

export function RangeFromToInputs({
  range,
  snapshotBoundaries,
  nowMs,
  onChange,
  fromLabelKey,
  toLabelKey,
  testIdPrefix,
}: Props) {
  const { t } = useTranslation()
  const minIso = snapshotBoundaries ? toLocalInputValue(snapshotBoundaries.lo) : undefined
  const fromMaxMs = Math.min(range.toMs, snapshotBoundaries?.hi ?? nowMs)
  const toMaxMs = snapshotBoundaries?.hi ?? nowMs
  return (
    <>
      <label className={FILTER_LABEL}>
        <span>{t(fromLabelKey)}</span>
        <input
          type="datetime-local"
          className={FILTER_SELECT}
          value={toLocalInputValue(range.fromMs)}
          min={minIso}
          max={toLocalInputValue(fromMaxMs)}
          onChange={(e) => {
            const ms = fromLocalInputValue(e.target.value)
            if (ms === null) return
            const lo = snapshotBoundaries?.lo ?? Number.NEGATIVE_INFINITY
            const fromMs = Math.min(Math.max(ms, lo), range.toMs)
            onChange({ fromMs, toMs: range.toMs })
          }}
          data-testid={`${testIdPrefix}-from`}
        />
      </label>
      <label className={FILTER_LABEL}>
        <span>{t(toLabelKey)}</span>
        <input
          type="datetime-local"
          className={FILTER_SELECT}
          value={toLocalInputValue(range.toMs)}
          min={minIso}
          max={toLocalInputValue(toMaxMs)}
          onChange={(e) => {
            const ms = fromLocalInputValue(e.target.value)
            if (ms === null) return
            const hi = snapshotBoundaries?.hi ?? nowMs
            const toMs = Math.min(Math.max(ms, range.fromMs), hi)
            onChange({ fromMs: range.fromMs, toMs })
          }}
          data-testid={`${testIdPrefix}-to`}
        />
      </label>
    </>
  )
}
