// SPDX-License-Identifier: GPL-2.0-or-later
// Per-mistake-key detail derived from a run's own raw keystroke log — what
// characters were actually typed for a Missed chip, and (verbatim mode
// only) how many times the user moved on to the next word without ever
// correcting a wrong character. Built from data recorded AT INPUT TIME
// (`RunKeystroke.typedChar`/`mistakeKey`, threaded by run-log-recorder.ts —
// see that field's own doc comment), never by replaying the saved log
// afterward: a romaji mistake key can depend on which of several live
// alternate spellings the user goes on to complete, which only the live
// reducer state at the moment of the keystroke can name reliably — a
// codex-reviewed design decision, not an oversight. See
// mistake-summary.tsx's `MissedCharsList`, the sole consumer.

import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'

export interface MissedCharDetail {
  /** Actual characters typed for incorrect keystrokes tallied under this
   *  mistake key, keyed by the typed character, counting occurrences —
   *  e.g. `{ m: 2, b: 1 }` for "typed m twice and b once instead of the
   *  expected char". Empty when no incorrect keystroke carried
   *  `typedChar` for this key (a legacy log predating that field, or a
   *  stretch this run's char correlation otherwise missed). */
  typedCounts: Record<string, number>
  /** Verbatim mode only (always 0 for a romaji run — see the module doc
   *  comment on `buildMissedDetails`'s own romaji branch): how many times
   *  this key's expected character was still wrong in the word's FINAL
   *  submitted state — the user moved on to the next word without ever
   *  correcting it, as opposed to a mistake that was later fixed via
   *  Backspace before submitting. */
  movedOnCount: number
}

function getOrCreate(details: Map<string, MissedCharDetail>, key: string): MissedCharDetail {
  let entry = details.get(key)
  if (!entry) {
    entry = { typedCounts: {}, movedOnCount: 0 }
    details.set(key, entry)
  }
  return entry
}

/** Per-mistake-key detail for every key this run's own `mistakes` map
 *  could plausibly contain — a chip with no entry in the returned map
 *  simply has nothing more to say than the count already on it (legacy
 *  log, or this specific key's keystrokes never got typedChar/mistakeKey
 *  attribution); `MissedCharsList` renders that chip exactly as it does
 *  today, without a tooltip. Returns an empty map outright (bail out, no
 *  per-key attempt at all) when `log.charCorrelationUnavailable` — the
 *  same condition that makes this run's keystroke-level correctness
 *  unreliable in general (see that field's own doc comment).
 *
 *  Two independent signals feed each entry:
 *   - `typedCounts`: every incorrect keystroke (`correct === false`)
 *     carrying both `typedChar` and `mistakeKey` groups its `typedChar`
 *     under `mistakeKey` — this is the ONLY source for this figure, so a
 *     keystroke missing either field (legacy log) contributes nothing.
 *     Includes keystrokes from an interrupted (`partial: true`) word too
 *     — a real recorded keystroke regardless of whether its word was
 *     ever submitted.
 *   - `movedOnCount` (verbatim mode only — `log.romajiInput !== true`):
 *     derived purely from `RunWord.display`/`typed`'s final positional
 *     diff on every SUBMITTED (non-`partial`) word, independent of
 *     per-keystroke typedChar/mistakeKey data — the same predicate
 *     run-state.ts's `applyWordMistakes` uses to decide whether a
 *     position counts as a mistake at all. Romaji mode is structurally
 *     always 0: the matcher blocks a segment from advancing until it
 *     resolves correctly (see romaji-input.ts's `handleRomajiChar`), so
 *     there is no notion of "moved on with an uncorrected kana" the way
 *     a verbatim position can be submitted wrong. */
export function buildMissedDetails(log: RunKeystrokeLog): Map<string, MissedCharDetail> {
  const details = new Map<string, MissedCharDetail>()
  if (log.charCorrelationUnavailable) return details

  for (const word of log.words) {
    for (const k of word.keystrokes) {
      if (k.correct !== false) continue
      if (k.mistakeKey === undefined || k.typedChar === undefined) continue
      const entry = getOrCreate(details, k.mistakeKey)
      entry.typedCounts[k.typedChar] = (entry.typedCounts[k.typedChar] ?? 0) + 1
    }
  }

  if (log.romajiInput !== true) {
    for (const word of log.words) {
      if (word.partial) continue
      const { display, typed } = word
      for (let i = 0; i < display.length; i++) {
        if (typed[i] === display[i]) continue
        getOrCreate(details, display[i]).movedOnCount++
      }
    }
  }

  return details
}
