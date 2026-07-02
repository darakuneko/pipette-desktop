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

/** Resolve the option list + effective selected value: the newest
 * snapshot renders as "Current keymap", the rest newest-first below
 * it. A `selectedSavedAt` that doesn't match any known snapshot
 * (stale prop, list still loading) falls back to the newest — the
 * option set must always contain the rendered value or the browser
 * silently picks the first one and the select diverges from the
 * parent's state. */
function resolveSnapshotSelectOptions(
  summaries: readonly TypingKeymapSnapshotSummary[],
  selectedSavedAt: number | null,
): {
  latest: TypingKeymapSnapshotSummary | null
  older: TypingKeymapSnapshotSummary[]
  selectedValue: number | null
} {
  const sorted = [...summaries].sort((a, b) => a.savedAt - b.savedAt)
  if (sorted.length === 0) return { latest: null, older: [], selectedValue: null }
  const latest = sorted[sorted.length - 1]
  const older = sorted.slice(0, -1).reverse()
  const selectedValue =
    selectedSavedAt !== null && sorted.some((s) => s.savedAt === selectedSavedAt)
      ? selectedSavedAt
      : latest.savedAt
  return { latest, older, selectedValue }
}

interface Props {
  summaries: TypingKeymapSnapshotSummary[]
  /** Source of truth for which snapshot is currently selected.
   * `null` means the parent has not picked one yet (e.g. summaries are
   * still loading). The select falls back to the latest entry to keep
   * the displayed value in sync with the available options. */
  selectedSavedAt: number | null
  onSelectSnapshot: (savedAt: number) => void
  testId?: string
}

export function KeymapSnapshotTimeline({
  summaries,
  selectedSavedAt,
  onSelectSnapshot,
  testId = 'analyze-snapshot-timeline',
}: Props) {
  const { t } = useTranslation()

  const { latest, older, selectedValue } = useMemo(
    () => resolveSnapshotSelectOptions(summaries, selectedSavedAt),
    [summaries, selectedSavedAt],
  )

  if (latest === null) return null

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const savedAt = Number.parseInt(e.target.value, 10)
    if (!Number.isFinite(savedAt)) return
    onSelectSnapshot(savedAt)
  }

  return (
    <label className={FILTER_LABEL} data-testid={testId}>
      <span>{t('analyze.snapshotTimeline.title')}</span>
      <select
        className={FILTER_SELECT}
        value={String(selectedValue)}
        onChange={handleChange}
        data-testid={`${testId}-select`}
      >
        <option value={String(latest.savedAt)}>
          {t('analyze.snapshotTimeline.current')}
        </option>
        {older.map((s) => (
          <option key={s.savedAt} value={String(s.savedAt)}>
            {formatDateTime(s.savedAt)}
          </option>
        ))}
      </select>
    </label>
  )
}
