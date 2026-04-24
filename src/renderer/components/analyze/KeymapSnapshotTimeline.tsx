// SPDX-License-Identifier: GPL-2.0-or-later
// Keymap snapshot select — lets the user jump the Analyze primary
// range to a specific snapshot's active period. "Current keymap" is
// the latest snapshot (from its `savedAt` to now); older options
// cover `[savedAt, nextSavedAt)`. When the current range lies off
// any snapshot boundary, a disabled "— Custom range —" option is
// shown so the select faithfully reflects the active window.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingKeymapSnapshotSummary } from '../../../shared/types/typing-analytics'
import type { RangeMs } from './analyze-types'
import { FILTER_LABEL, FILTER_SELECT } from './analyze-filter-styles'

const CUSTOM_VALUE = 'custom'

interface Props {
  summaries: TypingKeymapSnapshotSummary[]
  range: RangeMs
  nowMs: number
  onRangeChange: (next: RangeMs) => void
}

function formatLocalDateTime(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear().toString().padStart(4, '0')
  const mo = (d.getMonth() + 1).toString().padStart(2, '0')
  const da = d.getDate().toString().padStart(2, '0')
  const h = d.getHours().toString().padStart(2, '0')
  const mi = d.getMinutes().toString().padStart(2, '0')
  return `${y}-${mo}-${da} ${h}:${mi}`
}

export function KeymapSnapshotTimeline({ summaries, range, nowMs, onRangeChange }: Props) {
  const { t } = useTranslation()

  const sorted = useMemo(
    () => [...summaries].sort((a, b) => a.savedAt - b.savedAt),
    [summaries],
  )
  // Options below "Current keymap" are the older snapshots newest-first.
  // Memoised so the double-copy (slice + reverse) doesn't rerun on
  // every range-dependent re-render.
  const olderSnapshots = useMemo(() => sorted.slice(0, -1).reverse(), [sorted])

  if (sorted.length === 0) return null

  const latest = sorted[sorted.length - 1]

  // Resolve which option is "current" by exact range match. A
  // snapshot's active window is `[savedAt, nextSavedAt ?? nowMs)`;
  // anything outside collapses to `_custom` so From/To edits don't
  // silently pretend to match a snapshot.
  const selectedValue = ((): string => {
    for (let i = 0; i < sorted.length; i += 1) {
      const s = sorted[i]
      const next = sorted[i + 1]
      const expectedTo = next?.savedAt ?? nowMs
      if (range.fromMs === s.savedAt && range.toMs === expectedTo) return String(s.savedAt)
    }
    return CUSTOM_VALUE
  })()

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value
    if (value === CUSTOM_VALUE) return
    const savedAt = Number.parseInt(value, 10)
    if (!Number.isFinite(savedAt)) return
    const idx = sorted.findIndex((s) => s.savedAt === savedAt)
    if (idx < 0) return
    const s = sorted[idx]
    const next = sorted[idx + 1]
    onRangeChange({ fromMs: s.savedAt, toMs: next?.savedAt ?? nowMs })
  }

  return (
    <label className={FILTER_LABEL} data-testid="analyze-snapshot-timeline">
      {t('analyze.snapshotTimeline.title')}
      <select
        className={FILTER_SELECT}
        value={selectedValue}
        onChange={handleChange}
        data-testid="analyze-snapshot-timeline-select"
      >
        <option value={String(latest.savedAt)}>
          {t('analyze.snapshotTimeline.current')}
        </option>
        {olderSnapshots.map((s) => (
          <option key={s.savedAt} value={String(s.savedAt)}>
            {formatLocalDateTime(s.savedAt)}
          </option>
        ))}
        {selectedValue === CUSTOM_VALUE && (
          <option value={CUSTOM_VALUE} disabled>
            {t('analyze.snapshotTimeline.custom')}
          </option>
        )}
      </select>
    </label>
  )
}
