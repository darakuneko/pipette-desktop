// SPDX-License-Identifier: GPL-2.0-or-later
// Pure helpers for clamping the Analyze range to a selected keymap
// snapshot's active window. The view holds `selectedSnapshotSavedAt`
// as the source of truth and these helpers turn that opaque marker
// into the inclusive-lower / exclusive-upper bounds the date inputs
// and the chart fetches need.
//
// Returning the same range reference on no-op clamps lets effects
// keyed on `range` skip work — that's why callers test by identity
// instead of comparing fields.

import type { TypingKeymapSnapshotSummary } from '../../../shared/types/typing-analytics'
import type { RangeMs } from './analyze-types'

/** The active window of a snapshot is `[savedAt, nextSavedAt ?? nowMs)`.
 * Returns `null` when the snapshot is not in `summaries` or when
 * `selectedSavedAt` is `null`. Callers treat `null` as "no clamp,
 * pass the range through" so snapshot-less keyboards keep their
 * free-form 7-day default. */
export function getSnapshotBoundaries(
  selectedSavedAt: number | null,
  summaries: readonly TypingKeymapSnapshotSummary[],
  nowMs: number,
): { lo: number; hi: number } | null {
  if (selectedSavedAt === null) return null
  if (summaries.length === 0) return null
  const sorted = [...summaries].sort((a, b) => a.savedAt - b.savedAt)
  const idx = sorted.findIndex((s) => s.savedAt === selectedSavedAt)
  if (idx < 0) return null
  return {
    lo: sorted[idx].savedAt,
    hi: sorted[idx + 1]?.savedAt ?? nowMs,
  }
}

/** Clamp `range` so both `fromMs` and `toMs` stay within `bounds`.
 * Returns the original reference when no clamping is needed so React
 * effects keyed on `range` don't re-fire on identity changes. When
 * `bounds` is `null` the range passes through unchanged. */
export function clampRangeToBoundaries(
  range: RangeMs,
  bounds: { lo: number; hi: number } | null,
): RangeMs {
  if (bounds === null) return range
  const fromMs = Math.min(Math.max(range.fromMs, bounds.lo), bounds.hi)
  const toMs = Math.min(Math.max(range.toMs, bounds.lo), bounds.hi)
  if (fromMs === range.fromMs && toMs === range.toMs) return range
  return { fromMs, toMs }
}
