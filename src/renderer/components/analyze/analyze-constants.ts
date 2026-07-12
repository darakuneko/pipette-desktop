// SPDX-License-Identifier: GPL-2.0-or-later
// Tiny shared constants for the Analyze surface. Pulled out so visual
// dashes don't drift between the Summary cards (TodaySummary,
// TypingProfile) — `'-'` (hyphen) and `'—'` (em-dash) look the same in
// source but render at different widths.

/** Glyph displayed in stat cards when a metric has no comparison data
 * available (sample too thin, IPC empty, or threshold not met). */
export const EMPTY_STAT_VALUE = '—'

/** Pull a high limit so the renderer can derive Top / Slow / Finger
 * sub-views from a single fetch instead of 3 round-trips (BigramsChart),
 * and so the Heatmap Speed mode's own bigram fetch (KeyHeatmapChart) can
 * share the same cap. Exported so tests can build a capped-length
 * fixture without duplicating the magic number. */
export const ALL_PAIRS_LIMIT = 5000
