// SPDX-License-Identifier: GPL-2.0-or-later
// Keymap snapshot select — owns the option list but no longer the
// "which snapshot is current" decision. The parent passes
// `selectedSavedAt` so the select reflects the explicit picker state
// even when the user has narrowed the range inside the snapshot's
// active window. Free-form ranges that escape a snapshot can no
// longer happen because the parent clamps every edit through
// `clampRangeToSnapshot`, so the previous "— Custom range —" option
// is no longer reachable and was removed.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingKeymapSnapshotSummary } from '../../../shared/types/typing-analytics'
import { formatDateTime } from '../editors/store-modal-shared'
import { FILTER_LABEL, FILTER_SELECT } from './analyze-filter-styles'

interface Props {
  summaries: TypingKeymapSnapshotSummary[]
  /** Source of truth for which snapshot is currently selected.
   * `null` means the parent has not picked one yet (e.g. summaries are
   * still loading). The select falls back to the latest entry to keep
   * the displayed value in sync with the available options. */
  selectedSavedAt: number | null
  onSelectSnapshot: (savedAt: number) => void
}

export function KeymapSnapshotTimeline({ summaries, selectedSavedAt, onSelectSnapshot }: Props) {
  const { t } = useTranslation()

  const sorted = useMemo(
    () => [...summaries].sort((a, b) => a.savedAt - b.savedAt),
    [summaries],
  )
  // Options below "Current keymap" are the older snapshots newest-first.
  // Memoised so the double-copy (slice + reverse) doesn't rerun on
  // every snapshot-select rerender.
  const olderSnapshots = useMemo(() => sorted.slice(0, -1).reverse(), [sorted])

  if (sorted.length === 0) return null

  const latest = sorted[sorted.length - 1]

  // Fall back to the latest snapshot when the parent prop is stale —
  // the option set must always contain the rendered value otherwise
  // the browser silently picks the first one and the select diverges
  // from `selectedSavedAt` in the parent.
  const selectedValue =
    selectedSavedAt !== null && sorted.some((s) => s.savedAt === selectedSavedAt)
      ? String(selectedSavedAt)
      : String(latest.savedAt)

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const savedAt = Number.parseInt(e.target.value, 10)
    if (!Number.isFinite(savedAt)) return
    if (!sorted.some((s) => s.savedAt === savedAt)) return
    onSelectSnapshot(savedAt)
  }

  return (
    <label className={FILTER_LABEL} data-testid="analyze-snapshot-timeline">
      <span>{t('analyze.snapshotTimeline.title')}</span>
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
            {formatDateTime(s.savedAt)}
          </option>
        ))}
      </select>
    </label>
  )
}
