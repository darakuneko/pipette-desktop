// SPDX-License-Identifier: GPL-2.0-or-later
// KSPC (keystrokes per confirmed character) — pure math over the raw
// numerator/denominator pair carried on TypingTestResult
// (kspcKeystrokes/kspcChars) and accumulated on TypingTestState
// (totalKeystrokes/confirmedChars). Mode-blind: callers own how the two
// counts are actually accumulated per mode (run-state.ts,
// romaji-input.ts) or read back for display (result-builder.ts,
// TypingProfileCard.tsx, TypingTestHistory.tsx) — this module only
// divides the pair.

/** KSPC = total physical keystrokes ÷ confirmed character count. `null`
 * on zero/negative `chars` (nothing confirmed — avoids a division by
 * zero) or non-finite/negative inputs, so an invalid pair can never be
 * stored or displayed as a bogus ratio. */
export function computeKspc(keystrokes: number, chars: number): number | null {
  if (!Number.isFinite(keystrokes) || !Number.isFinite(chars)) return null
  if (keystrokes < 0 || chars <= 0) return null
  return keystrokes / chars
}

/** Formats a KSPC ratio to 2 decimal places — shared by the finish screen,
 * History CSV, and the Analyze Typing Profile card so the same value
 * always reads identically. */
export function formatKspc(value: number): string {
  return value.toFixed(2)
}
