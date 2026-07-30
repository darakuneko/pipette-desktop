// SPDX-License-Identifier: GPL-2.0-or-later
// Sanitization for a persisted TypingTestResult's optional fields —
// shared by useDevicePrefs.ts (the per-device History read path) and
// AnalyzePane.tsx (which fetches the same pipetteSettingsGet payload for
// TypingProfileCard's KSPC cell) so both funnel through the identical
// filter+sanitize pair instead of drifting into two definitions of
// "valid". Kept out of useDevicePrefs.ts on purpose: that module pulls
// in useAppConfig (and, transitively, i18n's self-initializing module),
// which a plain data consumer like AnalyzePane shouldn't have to drag in
// just to sanitize a fetched array.

import type { TypingTestResult } from '../../shared/types/pipette-settings'

/** A non-negative integer — the base shape shared by every raw
 *  KSPC/memory counter field (`totalKeystrokes`/`confirmedChars`/
 *  `kspcKeystrokes`), used by both `sanitizeKspcFields` below and
 *  useDevicePrefs.ts's `validateTypingTestMemory` group check, so the
 *  two don't drift into subtly different phrasings of the same guard.
 *  Every one of these fields is a keystroke/char tally — always a whole
 *  number in practice — so `Number.isInteger` rejects a fractional value
 *  (corrupted data, or a hand-edited file) instead of accepting it as a
 *  plausible count. `kspcChars` needs the stricter `> 0` (division-by-zero
 *  guard) on top of this. */
export function isNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

export function isValidTypingTestResult(item: unknown): item is TypingTestResult {
  if (typeof item !== 'object' || item === null) return false
  const r = item as Record<string, unknown>
  return typeof r.date === 'string' && typeof r.wpm === 'number' && typeof r.accuracy === 'number'
}

/** Validates a result's optional `mistakes` field: a plain object mapping
 *  every key to a finite number. Returns `undefined` for anything else
 *  (absent, wrong shape, non-numeric/non-finite values) so a malformed
 *  field degrades to "not set" rather than rejecting the whole result —
 *  same treatment as the other optional fields on `TypingTestResult`. */
function sanitizeMistakes(raw: unknown): Record<string, number> | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) return undefined
  const mistakes: Record<string, number> = {}
  for (const [key, value] of entries) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    mistakes[key] = value
  }
  return mistakes
}

/** Validates a result's optional `kspcKeystrokes`/`kspcChars` pair:
 *  both-or-neither, each a non-negative integer, `kspcChars` > 0
 *  (matches `computeKspc`'s own zero-division guard). Returns `{}` for
 *  anything else (only one present, wrong type, fractional/negative) so
 *  a malformed pair degrades to "not set" — same treatment as `mistakes`
 *  above — rather than displaying a bogus ratio. */
function sanitizeKspcFields(result: TypingTestResult): { kspcKeystrokes?: number; kspcChars?: number } {
  const { kspcKeystrokes, kspcChars } = result
  if (kspcKeystrokes === undefined && kspcChars === undefined) return {}
  if (isNonNegInt(kspcKeystrokes) && isNonNegInt(kspcChars) && kspcChars > 0) {
    return { kspcKeystrokes, kspcChars }
  }
  return {}
}

/** Replaces a malformed `mistakes` / `kspcKeystrokes`+`kspcChars` field
 *  with `undefined` (rather than discarding the rest of an already-
 *  `isValidTypingTestResult`-checked result). Applied after that filter
 *  so a persisted result with a corrupted field still survives (minus
 *  that one field) instead of vanishing from History entirely. */
export function sanitizeTypingTestResult(result: TypingTestResult): TypingTestResult {
  const { kspcKeystrokes, kspcChars } = sanitizeKspcFields(result)
  return {
    ...result,
    mistakes: sanitizeMistakes(result.mistakes),
    kspcKeystrokes,
    kspcChars,
  }
}
