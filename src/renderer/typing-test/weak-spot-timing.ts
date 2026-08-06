// SPDX-License-Identifier: GPL-2.0-or-later

/** Per-token keystroke-interval extraction from a saved run's raw
 *  keystroke log (`RunKeystrokeLog`), for Weak Spot Training's slowness/
 *  stall signals (see weak-spot-profile.ts's composite aggregation, which
 *  consumes this module's output). Pure, log-in/intervals-out — no IPC,
 *  no React, so the replay algorithm is unit-testable without mounting
 *  anything or mocking `window.vialAPI`.
 *
 *  TOKEN IDENTITY must land in the exact same key space `mistakes` already
 *  uses (see word-generator/weak-spot-weighting.ts's `tokensForWord`):
 *  direct/kana key by individual (kana-normalized) characters, romaji keys
 *  by canonical per-segment spelling (`canonicalRomajiSegments`). But
 *  `RunKeystroke.mistakeKey` is only ever persisted on an INCORRECT
 *  keystroke (see that field's own doc comment in typing-run-log.ts) — a
 *  correct keystroke's token identity is never stored directly. This
 *  module recovers it by re-tokenizing `RunWord.display` itself (the
 *  target text is always present, correct or not) with the SAME
 *  tokenizers `wordWeakSpotScore` uses, then walking the word's ordered
 *  keystrokes to consume the exact number of PHYSICAL keystrokes each
 *  token structurally requires (1 for direct/most kana, 1-2 for a
 *  dakuten/handakuten kana unit, `segment.length` for a romaji segment).
 *
 *  A word whose actual keystroke count doesn't match that structurally-
 *  expected count — a reject-and-retry (kana/romaji), a Backspace, or any
 *  other correction — is EXCLUDED IN FULL (see `isCleanWord`) rather than
 *  partially salvaged: this is the "ambiguous mistakeKey attribution"
 *  exclusion the plan calls for, applied conservatively at word
 *  granularity instead of trying to replay reject/backspace semantics
 *  from the log. This also means a word WITH a mistake never contributes
 *  timing data — expected and fine, since a mistyped token's weakness is
 *  already captured by the miss signal; the timing signals exist
 *  specifically to catch tokens that are slow despite being typed
 *  correctly, which the miss signal can't see at all. */

import type { RunKeystrokeLog, RunKeystroke, RunWord } from '../../shared/types/typing-run-log'
import { toHiragana } from './kana-script'
import { canonicalRomajiSegments } from './romaji-engine'
import { kanaUnitsForWord } from './kana-input'
import type { WeakSpotInputMethod } from './word-generator/weak-spot-weighting'

/** The longest gap between two keystrokes that still counts as a valid
 *  pre-token interval — mirrors the analytics n-gram pipeline's own
 *  `NGRAM_MAX_IKI_MS` (minute-buffer.ts, main process): a genuine pause
 *  (getting up, thinking about something else) is not "this token is
 *  slow," it's "the user stopped typing," so it must not pollute the
 *  per-token/scope statistics either. Kept as this module's own constant
 *  (not imported from the main-process file, which the renderer cannot
 *  reach) — same VALUE, same rationale, independent declaration. */
export const MAX_VALID_INTERVAL_MS = 5000

/** Floor below which an interval is treated as a measurement artifact
 *  (clock-resolution glitch, a queued/replayed event pair landing on the
 *  same tick) rather than a genuine reaction time — no human keystroke
 *  cadence is reliably sub-10ms, so a smaller gap is more likely noise
 *  than an authentically fast token. */
export const MIN_VALID_INTERVAL_MS = 10

function isValidInterval(intervalMs: number): boolean {
  return intervalMs >= MIN_VALID_INTERVAL_MS && intervalMs <= MAX_VALID_INTERVAL_MS
}

/** One token's tokenized identity plus how many PHYSICAL keystrokes it
 *  structurally requires — direct/kana single-stroke units need 1, a
 *  dakuten/handakuten kana unit needs 2, a romaji segment needs its own
 *  canonical spelling's character count. */
interface ExpectedToken {
  key: string
  strokeCount: number
}

function expectedTokensForWord(display: string, inputMethod: WeakSpotInputMethod): ExpectedToken[] {
  switch (inputMethod) {
    case 'direct':
      return [...display].map((ch) => ({ key: ch, strokeCount: 1 }))
    case 'kana':
      return kanaUnitsForWord(display).map((unit) => ({
        key: toHiragana(unit.char),
        strokeCount: unit.strokes ? unit.strokes.length : 1,
      }))
    case 'romaji':
      return canonicalRomajiSegments(display).map((segment) => ({ key: segment, strokeCount: segment.length }))
  }
}

/** True when every keystroke in `keystrokes` received a real correctness
 *  verdict — i.e. none of them is a Backspace (or other non-char event
 *  that reached the buffer): `applyCharVerdict` (run-log-recorder.ts)
 *  always sets `expectedChar` at push time but returns before ever
 *  setting `correct` for a Backspace specifically, so `expectedChar
 *  !== undefined && correct === undefined` on a persisted keystroke is
 *  exactly that signature. A keystroke with `expectedChar === undefined`
 *  (no char-context annotation reached it at all) is equally excluded —
 *  never a clean, attributable char attempt. */
function isCleanWord(word: RunWord, expected: readonly ExpectedToken[]): boolean {
  if (word.partial) return false
  const expectedKeystrokeCount = expected.reduce((sum, t) => sum + t.strokeCount, 0)
  if (word.keystrokes.length !== expectedKeystrokeCount) return false
  for (const k of word.keystrokes) {
    if (k.expectedChar === undefined) return false
    if (k.correct === undefined) return false
  }
  return true
}

/** Per-word interval extraction — appends `[token, intervalMs]` pairs
 *  into `sink` for every non-word-initial token whose PRECEDING interval
 *  is valid (see `isValidInterval`). Word-initial (the word's very first
 *  token) is always skipped: the gap before it spans the previous word's
 *  submit (a space/Enter) plus this word's own reading/planning time,
 *  not this token's own difficulty — see the module doc comment. This
 *  also transparently excludes the run's very first keystroke ever (the
 *  first word's first token is word-initial too, so it's never measured,
 *  with no separate "is this the run's first keystroke" check needed). */
function collectWordIntervals(word: RunWord, inputMethod: WeakSpotInputMethod, sink: Map<string, number[]>): void {
  const expected = expectedTokensForWord(word.display, inputMethod)
  if (expected.length === 0) return
  if (!isCleanWord(word, expected)) return

  const keystrokes: readonly RunKeystroke[] = word.keystrokes
  let strokeIndex = 0
  for (let tokenIndex = 0; tokenIndex < expected.length; tokenIndex++) {
    const { key, strokeCount } = expected[tokenIndex]
    const onsetIndex = strokeIndex
    strokeIndex += strokeCount
    if (tokenIndex === 0) continue // word-initial — never measured
    const onsetMs = keystrokes[onsetIndex].pressMs
    const prevMs = keystrokes[onsetIndex - 1].pressMs
    const interval = onsetMs - prevMs
    if (!isValidInterval(interval)) continue
    let arr = sink.get(key)
    if (!arr) {
      arr = []
      sink.set(key, arr)
    }
    arr.push(interval)
  }
}

/** Extracts every valid pre-token interval from one run's keystroke log,
 *  keyed by token (same key space as `TypingTestResult.mistakes` for the
 *  given `inputMethod` — see the module doc comment). Returns an empty
 *  map for a log with `charCorrelationUnavailable` set (mirrors
 *  `buildMissedDetails`'s own bailout — an IME-tainted run's keystroke-
 *  level correctness, and therefore its clean-word detection, can't be
 *  trusted at all). */
export function extractTokenIntervals(log: RunKeystrokeLog, inputMethod: WeakSpotInputMethod): Map<string, number[]> {
  const result = new Map<string, number[]>()
  if (log.charCorrelationUnavailable) return result
  for (const word of log.words) {
    collectWordIntervals(word, inputMethod, result)
  }
  return result
}

/** Merges N per-log token-interval maps (each `extractTokenIntervals`'s
 *  own return value) into one, concatenating the interval arrays for any
 *  token appearing in more than one log — mirrors
 *  `mergeMissedDetails`/`mergeMissedDetailInto`'s (use-mistake-ranking-
 *  details.ts) accumulate-across-runs shape for the analogous miss-count
 *  aggregation. */
export function mergeTokenIntervals(perLog: readonly Map<string, number[]>[]): Map<string, number[]> {
  const merged = new Map<string, number[]>()
  for (const log of perLog) {
    for (const [key, intervals] of log) {
      let arr = merged.get(key)
      if (!arr) {
        arr = []
        merged.set(key, arr)
      }
      arr.push(...intervals)
    }
  }
  return merged
}
