// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics shared types — see .claude/plans/typing-analytics.md.

export const DEFAULT_TYPING_SYNC_SPAN_DAYS = 7
export const ALLOWED_TYPING_SYNC_SPAN_DAYS = [1, 7, 30, 90] as const
export type TypingSyncSpanDays = typeof ALLOWED_TYPING_SYNC_SPAN_DAYS[number]

/** Normalized analytics event produced by the renderer and forwarded to main. */
export type TypingAnalyticsEvent =
  | { kind: 'char'; key: string; ts: number }
  | { kind: 'matrix'; row: number; col: number; layer: number; keycode: number; ts: number }
