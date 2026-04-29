// SPDX-License-Identifier: GPL-2.0-or-later
// Tiny shared constants for the Analyze surface. Pulled out so visual
// dashes don't drift between the Summary cards (TodaySummary,
// TypingProfile) — `'-'` (hyphen) and `'—'` (em-dash) look the same in
// source but render at different widths.

/** Glyph displayed in stat cards when a metric has no comparison data
 * available (sample too thin, IPC empty, or threshold not met). */
export const EMPTY_STAT_VALUE = '—'
