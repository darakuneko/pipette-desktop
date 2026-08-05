// SPDX-License-Identifier: GPL-2.0-or-later
// Pure log → display model for the per-word keystroke timeline. Every
// coordinate this module produces is in "display-ms" space: a single
// shared, zoom-independent horizontal axis that the view scales by a
// pixel-per-ms factor without ever recomputing bar positions (see
// WordTimelineView's zoom scheme). That split — a zoom-independent model
// here, a zoom-dependent viewport transform in the view — is what lets a
// slider drag be a pure CSS-width change with zero re-render of the rect
// tree.

import type { RunKeystroke, RunKeystrokeLog, RunWord } from '../../shared/types/typing-run-log'
import { computeWordCharCounts } from './run-state'
import { resolveCharFromKeycode } from './keycode-char-map'
import { qualifyingHoldMs } from './keystroke-hold'

/** A press with no observed release renders as a fixed-width sliver so it
 *  has SOMETHING to show — never treat this width as a real duration (see
 *  `KeystrokeSegment.openEnded`). Small enough to read as "still held /
 *  unknown", never mistakable for a real, timed keypress bar. */
export const MIN_BAR_MS = 30

/** Gap threshold (ms) above which an inter-keystroke gap is treated as a
 *  deliberate pause rather than ordinary typing rhythm — comfortably
 *  beyond any plausible inter-key interval a typist produces (even a slow
 *  deliberate keypress lands in the low hundreds of ms). Mirrors the
 *  reasoning behind `OBSERVATION_HOLE_MS`
 *  (`shared/typing-analytics-timing.ts`) — both draw a line beyond which
 *  a gap stops being ordinary signal and starts being a hole in normal
 *  behavior — but this constant answers a different question (human
 *  hesitation vs HID poll starvation), so it is deliberately a different,
 *  much larger value.
 *
 *  Named WORD-specific (not just `BLANK_THRESHOLD_MS`) now that
 *  `line-timeline.ts` exists alongside this module with its own, much
 *  smaller `LINE_BLANK_THRESHOLD_MS` (250ms, matching the timeline
 *  modal's line-view legend) — a per-word row and a per-line row draw the
 *  line between "ordinary rhythm" and "a pause worth marking" at
 *  deliberately different places, since a line's shared axis already
 *  spans several words' worth of ordinary inter-word rhythm that would
 *  read as noise at the word view's coarser 1000ms cut. */
export const WORD_BLANK_THRESHOLD_MS = 1000

/** Every inter-keystroke gap's axis contribution is capped at this many
 *  display-ms — legibility AND monotonicity, together:
 *  - Legibility: a multi-second pause must never dwarf every real
 *    keystroke bar in the row, so its axis contribution is capped to the
 *    same order of magnitude as a real keystroke bar — a pause marker
 *    reads as a marker, never as something that dominates the row.
 *  - Monotonicity: the cap applies to EVERY qualifying gap, not only
 *    ones at or above `BLANK_THRESHOLD_MS`. The previous scheme (a flat
 *    `BLANK_COMPRESS_MS` applied only once `BLANK_THRESHOLD_MS` was
 *    crossed, sub-threshold gaps passed through uncompressed) was
 *    non-monotonic: a 999ms gap rendered at its true 999ms, while a
 *    1000ms gap — one millisecond longer — jumped straight to a flat
 *    1500ms. Capping every gap at this same constant means a longer true
 *    gap can never produce a SMALLER axis contribution than a shorter
 *    one once both are past the cap; they simply saturate together.
 *  A blank/lead-in segment still carries its true duration
 *  (`trueDurationMs`) for the tooltip; only the AXIS contribution is
 *  capped. */
export const GAP_DISPLAY_CAP_MS = 250

export interface KeystrokeSegment {
  kind: 'keystroke'
  /** Display-ms position of this bar's left edge. */
  startMs: number
  /** Display-ms position of this bar's right edge. */
  endMs: number
  /** Run-relative TRUE ms of this keystroke's press (`RunKeystroke.pressMs`
   *  verbatim — never compressed or cursor-adjusted) — the tooltip's own
   *  offset line reads this, not `startMs`: `startMs` lives in
   *  display-ms space (compressed gaps, cursor drift fixes, ...), and this
   *  view's own axis note promises every DURATION shown is real; the
   *  offset line makes the same promise for POSITION. */
  trueStartMs: number
  /** Lane index (0-based) this bar was assigned within its word's row —
   *  see `assignLanes`. Unbounded: a word with an N-deep rollover reports
   *  N lanes rather than clamping, since revealing that depth is exactly
   *  what this view exists for. */
  lane: number
  correct?: boolean
  overlapped?: boolean
  /** True when `endMs` is a visual fallback (`MIN_BAR_MS` past the
   *  press), not an observed release — never treat this as evidence of
   *  the keystroke's real duration, or of whether it overlapped the next
   *  one. */
  openEnded?: boolean
  /** Resolved label for tooltip text — the expected char when known,
   *  otherwise whatever `resolveCharFromKeycode` can recover from the
   *  keycode alone (a bare modifier / layer key resolves to `''`). */
  label: string
}

export interface BlankSegment {
  kind: 'blank'
  /** Display-ms position of this bar's left edge — the previous
   *  keystroke's display end, or the word start for a lone leading gap. */
  startMs: number
  /** Display-ms position of this bar's right edge — always
   *  `startMs + min(trueDurationMs, GAP_DISPLAY_CAP_MS)` (only the AXIS
   *  contribution is capped; see `GAP_DISPLAY_CAP_MS`'s doc comment). */
  endMs: number
  /** The gap's real duration — always the true value, never compressed
   *  (only the axis contribution is capped; see `GAP_DISPLAY_CAP_MS`). */
  trueDurationMs: number
}

/** Hesitation between two words, rendered as a single marker at the
 *  start of this word's row rather than a mid-row blank — the gap
 *  belongs to neither word individually. */
export interface LeadInPauseSegment {
  kind: 'leadInPause'
  /** Always 0 — this marker sits at its word's row start. */
  startMs: number
  /** Always `GAP_DISPLAY_CAP_MS` — see `BlankSegment.endMs`. */
  endMs: number
  trueDurationMs: number
}

export type WordTimelineSegment = KeystrokeSegment | BlankSegment | LeadInPauseSegment

export interface WordTimelineStats {
  /** (correct chars / 5) over the word's own true span, in minutes — a
   *  per-word RATE, deliberately not called "WPM": it will not average
   *  back to the run's own WPM figure (per-word spans exclude inter-word
   *  time in a way the run-wide calculation doesn't). Undefined for a
   *  `partial` (unsubmitted) word or one with no measurable span. */
  wordPace?: number
  /** Same correct/(correct+incorrect) ratio the run summary's accuracy
   *  uses (`computeWordCharCounts`), scaled 0-100. Undefined for a
   *  `partial` word — nothing was actually judged for it. */
  accuracy?: number
  /** count(overlapped === true) / count(overlapped !== undefined) — a
   *  tri-state ratio: undefined means "nothing observable for this
   *  word", never "zero overlap". */
  overlapRate?: number
  /** Raw counts backing `overlapRate` (denominator/numerator) — undefined
   *  exactly when `overlapRate` is. Carried alongside the ratio so
   *  `buildWordTimelineSummary` can POOL overlap truth across words by
   *  event count (Σ overlapTrue / Σ overlapObserved) instead of averaging
   *  each word's own ratio, which would weight a word with 1 observed
   *  keystroke the same as one with 20. */
  overlapObserved?: number
  overlapTrue?: number
  /** Sum of `releaseMs - pressMs` over every keystroke in this word whose
   *  release was actually observed AND whose duration is positive — the
   *  raw pair (with `holdSamples`) backing `WordTimelineSummary.avgHoldMs`,
   *  pooled the same Σ/Σ way as `overlapObserved`/`overlapTrue` (a mean of
   *  each word's own average would weight a 1-keystroke word the same as
   *  a 20-keystroke one). Undefined — not zero — when the word has no
   *  qualifying sample, the same tri-state convention `overlapObserved`
   *  uses. Orthogonal to a word being `partial`/scored: a hold duration is
   *  measurable regardless of whether the word was ever judged. */
  holdSumMs?: number
  holdSamples?: number
  /** Raw char counts backing `accuracy` (post separator-credit
   *  adjustment — see the run-last-word rule in `buildStats`) — undefined
   *  exactly when `accuracy` is. Lets `buildWordTimelineSummary` pool
   *  char-weighted accuracy/pace across words instead of averaging each
   *  word's own ratio. */
  correctChars?: number
  incorrectChars?: number
  /** True elapsed ms from the word's first press to its last observed
   *  boundary (a release when known, else that keystroke's own press) —
   *  see `buildWord`'s `lastObservedTrueMs` for why this is the MAX
   *  observed boundary across every keystroke in the word, not just the
   *  last press-ordered one (a keystroke held well past a later one's
   *  release — e.g. Shift held through the whole word — must not make
   *  the word's own duration read shorter than reality). Never
   *  compressed. Do NOT sum this across words into a run total — words'
   *  true spans overlap the inter-word gaps in incompatible ways (see
   *  the module doc comment on `RunKeystrokeLog`). */
  durationMs: number
}

export interface WordTimelineWord {
  index: number
  display: string
  typed: string
  partial: boolean
  segments: WordTimelineSegment[]
  /** Lane count for this word's row — drives the row's SVG height
   *  (`laneCount * LANE_UNIT_PX` in word-timeline-row.tsx). */
  laneCount: number
  stats: WordTimelineStats
}

export interface WordTimelineSummary {
  /** Span-weighted pace across scored words with a measurable span: Σ
   *  correct chars / 5 over Σ true span (minutes) — NOT a mean of each
   *  word's own `wordPace`, which would weight a short word the same as
   *  a long one. Undefined when no word qualifies. */
  avgPace?: number
  /** Char-weighted accuracy across scored words: Σ correct / Σ (correct +
   *  incorrect) — NOT a mean of each word's own `accuracy` ratio, for the
   *  same reason as `avgPace`. Undefined when no word qualifies. */
  avgAccuracy?: number
  /** Keystroke-weighted overlap across ALL words (not just scored ones)
   *  with an observed overlap verdict — overlap is orthogonal to a word
   *  being `partial`: Σ overlapTrue / Σ overlapObserved, NOT a mean of
   *  each word's own `overlapRate` (see `buildWordTimelineSummary`'s own
   *  doc comment for the bug this pooling fixes). Undefined when no word
   *  has one. */
  avgOverlap?: number
  /** Keystroke-weighted average key-hold duration (ms) across ALL words
   *  (not just scored ones) with a qualifying sample — Σ holdSumMs / Σ
   *  holdSamples, same pooling shape and same "orthogonal to scoring" rule
   *  as `avgOverlap`. Undefined when no word has one (e.g. every keystroke
   *  in the run is still open-ended). */
  avgHoldMs?: number
}

export interface WordTimelineModel {
  words: WordTimelineWord[]
  /** Shared display-ms width every word's row uses for its `viewBox` —
   *  the run's longest word decides it, so every row sits on the same
   *  ms-per-pixel scale (see WordTimelineView's single shared canvas). */
  maxDisplayMs: number
  charCorrelationUnavailable: boolean
}

function effectiveEndTrue(k: RunKeystroke): number {
  return k.releaseMs ?? k.pressMs + MIN_BAR_MS
}

function resolveLabel(k: RunKeystroke): string {
  if (k.expectedChar) return k.expectedChar
  const resolved = resolveCharFromKeycode(k.keycode)
  if (!resolved) return ''
  return resolved.kind === 'char' ? resolved.char : resolved.action
}

/** Lane (row-within-row) assignment via classic interval partitioning.
 *  Segments arrive already in press order (the order they were built
 *  in); each is placed in the first lane whose current occupant's
 *  display end already falls at or before this bar's own display start,
 *  or a brand-new lane when none qualifies. Lane count is never clamped
 *  — see `KeystrokeSegment.lane`'s doc comment.
 *
 *  This is a LAYOUT concern only, deliberately not an overlap oracle: an
 *  `openEnded` sliver (unknown real duration, see `MIN_BAR_MS`) frees its
 *  lane at the sliver's own display end, same as any other bar. Reusing
 *  that lane for the next bar makes no claim about whether the two
 *  physically overlapped — overlap truth lives entirely in the
 *  `overlapped` field, set independently from the actual matrix
 *  press/release pair. An alternative — give every `openEnded` bar an
 *  effectively infinite occupancy so nothing can ever reuse its lane —
 *  was considered and rejected: one lost release event (not rare; see
 *  `RunKeystroke.releaseMs`'s own doc comment) would then permanently
 *  fork every later bar in the word into a brand-new lane instead of the
 *  handful this word actually needs, making the ONE unobserved release
 *  look like a structural property of the whole rest of the row. */
function assignLanes(segments: KeystrokeSegment[]): number {
  const laneEnds: number[] = []
  for (const seg of segments) {
    let lane = laneEnds.findIndex((end) => end <= seg.startMs)
    if (lane === -1) lane = laneEnds.length
    seg.lane = lane
    laneEnds[lane] = seg.endMs
  }
  return laneEnds.length
}

interface WordBuildResult {
  segments: WordTimelineSegment[]
  laneCount: number
  maxEndMs: number
  durationMs: number
  overlapRate?: number
  overlapObserved?: number
  overlapTrue?: number
  /** See `WordTimelineStats.holdSumMs`/`holdSamples`. */
  holdSumMs?: number
  holdSamples?: number
  /** True ms of this word's own last observed boundary — carried forward
   *  as the next word's lead-in comparison point. Undefined when the
   *  word had no keystrokes at all (an empty word never updates the
   *  carry-over; the next word compares against whichever earlier word
   *  last had one). The MAX observed boundary (release when known, else
   *  the press itself) across EVERY keystroke in the word, never just
   *  the last press-ordered one's own end: a keystroke can be released
   *  well after a later one already came and went (e.g. a Shift held
   *  through an entire word while Space, pressed and released mid-hold,
   *  sorts after it only by press order) — using only the last
   *  press-ordered keystroke's end would then read this word's true span
   *  as far shorter than it actually was, and hand the NEXT word a stale,
   *  too-early comparison point that manufactures a lead-in pause that
   *  never happened. */
  lastObservedTrueMs?: number
}

/** The TRUE (never display-compressed) instant a keystroke was last known
 *  to still be active — its release when observed, else its own press.
 *  Used for the word-level `durationMs`/`lastObservedTrueMs` MAX (see
 *  `WordBuildResult.lastObservedTrueMs`), never for axis placement. */
function trueObservedEnd(k: RunKeystroke): number {
  return k.releaseMs ?? k.pressMs
}

export interface KeystrokeStreamResult {
  keystrokeSegments: KeystrokeSegment[]
  blankSegments: BlankSegment[]
  /** See `assignLanes` — computed over `keystrokeSegments` alone. */
  laneCount: number
  maxEndMs: number
  /** MAX observed boundary across every keystroke in the stream — see
   *  `WordBuildResult.lastObservedTrueMs`'s doc comment for why this is a
   *  MAX, not just the last press-ordered keystroke's own end. Always
   *  defined: callers only ever invoke this with a non-empty
   *  `keystrokes` array. */
  lastObservedTrueMs: number
  overlapObserved?: number
  overlapTrue?: number
  /** See `WordTimelineStats.holdSumMs`/`holdSamples` — same Σ/Σ pooling,
   *  computed over this stream's own keystrokes. */
  holdSumMs?: number
  holdSamples?: number
}

/** Builds one continuous run of keystroke + blank segments over an
 *  already press-sorted, NON-EMPTY keystroke array, starting the display
 *  axis at `startCursor` (already past any leadInPause marker the caller
 *  chose to insert — see `buildWord`). This is the shared axis-building
 *  core behind both the per-word row (`buildWord`, one call per word,
 *  cursor reset to a fresh `startCursor` each time) and the per-line row
 *  (`line-timeline.ts`'s `buildLine`, ONE call over an entire line's
 *  keystrokes flattened across all its words) — the two differ only in
 *  which keystrokes they hand this function and which `blankThresholdMs`
 *  applies (`WORD_BLANK_THRESHOLD_MS` vs `LINE_BLANK_THRESHOLD_MS`).
 *  Cross-word / cross-line lead-in markers are each caller's own concern
 *  (via `startCursor`), never this function's. */
export function buildKeystrokeStream(
  keystrokes: RunKeystroke[],
  blankThresholdMs: number,
  startCursor: number,
): KeystrokeStreamResult {
  const keystrokeSegments: KeystrokeSegment[] = []
  const blankSegments: BlankSegment[] = []
  let displayCursor = startCursor
  let observedOverlapCount = 0
  let overlappedTrueCount = 0
  let holdSumMs = 0
  let holdSamples = 0

  keystrokes.forEach((k, i) => {
    if (i > 0) {
      const prev = keystrokes[i - 1]
      let gapDisplay: number
      if (prev.releaseMs !== undefined) {
        // A gap is only ever MEASURED from an observed release — see the
        // module doc comment on RunKeystroke.releaseMs. Every gap's axis
        // contribution is capped at GAP_DISPLAY_CAP_MS regardless of
        // whether it crosses `blankThresholdMs` (see that constant's own
        // doc comment for the monotonicity argument) — a negative gap
        // (real overlap) is always below the cap, so overlap depth still
        // stays exactly proportional in that case.
        const gapTrue = k.pressMs - prev.releaseMs
        gapDisplay = Math.min(gapTrue, GAP_DISPLAY_CAP_MS)
        if (gapTrue >= blankThresholdMs) {
          blankSegments.push({ kind: 'blank', startMs: displayCursor, endMs: displayCursor + gapDisplay, trueDurationMs: gapTrue })
        }
      } else {
        // The previous release was never observed, so there is no
        // boundary to measure a gap from — this pair is never eligible
        // for blank detection (never fabricate evidence for an
        // unobserved release). Fall back to the raw press-to-press
        // delta, minus the fixed sliver width (MIN_BAR_MS) the previous
        // bar's own display end already consumed — that sliver is a
        // visual fallback, not a real duration (see
        // `KeystrokeSegment.openEnded`), so without this correction the
        // display cursor drifts MIN_BAR_MS further ahead of true elapsed
        // time after every open-ended bar, compounding over the row.
        // Floored at 0 for a press landing inside (or before) that
        // sliver's own fabricated width.
        gapDisplay = Math.max(0, k.pressMs - prev.pressMs - MIN_BAR_MS)
      }
      displayCursor += gapDisplay
    }

    const startMs = displayCursor
    const holdMs = effectiveEndTrue(k) - k.pressMs
    const endMs = startMs + holdMs
    displayCursor = endMs

    if (k.overlapped !== undefined) {
      observedOverlapCount++
      if (k.overlapped) overlappedTrueCount++
    }

    // Hold duration is always the TRUE press-to-release span — never the
    // display-compressed `startMs`/`endMs` this loop also computes above
    // (those can shrink an `openEnded` bar to MIN_BAR_MS, which must never
    // be mistaken for a real duration — see KeystrokeSegment.openEnded).
    // Qualification rule lives in keystroke-hold.ts, shared with
    // run-log-recorder.ts's `currentRunHoldStats` so the two independent
    // accumulation sites can't drift apart.
    const trueHoldMs = qualifyingHoldMs(k.pressMs, k.releaseMs)
    if (trueHoldMs !== undefined) {
      holdSumMs += trueHoldMs
      holdSamples++
    }

    keystrokeSegments.push({
      kind: 'keystroke',
      startMs,
      endMs,
      trueStartMs: k.pressMs,
      lane: 0,
      correct: k.correct,
      overlapped: k.overlapped,
      openEnded: k.releaseMs === undefined ? true : undefined,
      label: resolveLabel(k),
    })
  })

  const laneCount = assignLanes(keystrokeSegments)
  const lastObservedTrueMs = Math.max(...keystrokes.map(trueObservedEnd))
  const maxEndMs = Math.max(...keystrokeSegments.map((s) => s.endMs))

  return {
    keystrokeSegments,
    blankSegments,
    laneCount,
    maxEndMs,
    lastObservedTrueMs,
    overlapObserved: observedOverlapCount > 0 ? observedOverlapCount : undefined,
    overlapTrue: observedOverlapCount > 0 ? overlappedTrueCount : undefined,
    holdSumMs: holdSamples > 0 ? holdSumMs : undefined,
    holdSamples: holdSamples > 0 ? holdSamples : undefined,
  }
}

function buildWord(word: RunWord, crossWordLastObservedMs: number | null): WordBuildResult {
  const keystrokes = [...word.keystrokes].sort((a, b) => a.pressMs - b.pressMs)

  if (keystrokes.length === 0) {
    return { segments: [], laneCount: 0, maxEndMs: 0, durationMs: 0 }
  }

  const segments: WordTimelineSegment[] = []
  let displayCursor = 0

  // Between-word hesitation: compare this word's first press against the
  // last OBSERVED instant anywhere in the run so far. A single marker at
  // the word's start, not folded into the first keystroke's own gap —
  // the pause belongs to the transition, not to either word.
  const first = keystrokes[0]
  if (crossWordLastObservedMs !== null) {
    const leadGap = first.pressMs - crossWordLastObservedMs
    if (leadGap >= WORD_BLANK_THRESHOLD_MS) {
      segments.push({ kind: 'leadInPause', startMs: 0, endMs: GAP_DISPLAY_CAP_MS, trueDurationMs: leadGap })
      displayCursor += GAP_DISPLAY_CAP_MS
    }
  }

  const stream = buildKeystrokeStream(keystrokes, WORD_BLANK_THRESHOLD_MS, displayCursor)
  // Blanks first (background layer), keystrokes last (foreground) — SVG
  // paints later elements on top, so a keystroke bar always renders over
  // any blank it happens to visually overlap.
  segments.push(...stream.blankSegments, ...stream.keystrokeSegments)

  const durationMs = stream.lastObservedTrueMs - first.pressMs

  return {
    segments,
    laneCount: stream.laneCount,
    maxEndMs: stream.maxEndMs,
    durationMs,
    overlapRate: stream.overlapObserved !== undefined ? stream.overlapTrue! / stream.overlapObserved : undefined,
    overlapObserved: stream.overlapObserved,
    overlapTrue: stream.overlapTrue,
    holdSumMs: stream.holdSumMs,
    holdSamples: stream.holdSamples,
    lastObservedTrueMs: stream.lastObservedTrueMs,
  }
}

interface BuildStatsExtras {
  overlapObserved?: number
  overlapTrue?: number
  /** See `WordTimelineStats.holdSumMs`/`holdSamples`. */
  holdSumMs?: number
  holdSamples?: number
  /** True for the log's own last `RunWord` entry — the ONLY word
   *  `computeWordCharCounts`'s +1 separator credit must be withheld from,
   *  mirroring `run-state.ts`'s own two submit paths exactly: every word
   *  but the run's last goes through `handleSpace`, which credits
   *  `confirmedChars` with the separator baked into
   *  `computeWordCharCounts`; the run's actual last word instead goes
   *  through `tryFinishLastWord`, which credits only the word's own char
   *  count — there is no trailing space to type after it. Irrelevant
   *  (never even read) for a `partial`/empty word: those are unscored
   *  regardless. */
  isRunLastWord: boolean
  /** `RunKeystrokeLog.romajiInput` — when true, `typed`/`display` live in
   *  different text spaces (romaji keystrokes vs. the kana `display`
   *  target), so `computeWordCharCounts`'s verbatim char-by-char compare
   *  is meaningless here: withhold accuracy/wordPace same as a `partial`
   *  word, while overlap/duration (which never touch `typed`/`display`)
   *  stay. */
  romajiInput: boolean
}

export interface ScoredCharCounts {
  correct: number
  incorrect: number
}

/** The scored (post separator-credit adjustment) char counts behind a
 *  word's `accuracy`/`wordPace` — factored out of `buildStats` so
 *  `line-timeline.ts` can pool the exact same per-word counts into a
 *  per-LINE accuracy figure instead of re-deriving the scoring rules.
 *  Returns undefined under the same "nothing to score" conditions
 *  `buildStats` itself withholds accuracy/wordPace for — see
 *  `BuildStatsExtras`'s field doc comments (partial word, no keystrokes,
 *  or a romaji-mode run). */
export function computeScoredWordCharCounts(word: RunWord, isRunLastWord: boolean, romajiInput: boolean): ScoredCharCounts | undefined {
  if (word.partial || word.keystrokes.length === 0 || romajiInput) return undefined
  const counts = computeWordCharCounts(word.display, word.typed)
  // Withhold the separator credit for the run's actual last word — see
  // `BuildStatsExtras.isRunLastWord`'s doc comment.
  const correct = isRunLastWord ? counts.correct - 1 : counts.correct
  return { correct, incorrect: counts.incorrect }
}

function buildStats(word: RunWord, durationMs: number, extras: BuildStatsExtras): WordTimelineStats {
  const { overlapObserved, overlapTrue, holdSumMs, holdSamples } = extras
  const overlapRate = overlapObserved !== undefined ? overlapTrue! / overlapObserved : undefined
  // A partial (unsubmitted, interrupted) word is never scored — see
  // RunWord.partial's doc comment. Its keystrokes/segments still render;
  // only wordPace/accuracy are withheld. Same treatment for a word with
  // no captured keystrokes at all: `display`/`typed` may still disagree
  // meaningfully, but with nothing to visualize or time there is nothing
  // to score either — undefined (unscoreable), not a misleading number.
  // A romaji-mode run withholds the same two fields for every word — see
  // `BuildStatsExtras.romajiInput`'s doc comment.
  const scored = computeScoredWordCharCounts(word, extras.isRunLastWord, extras.romajiInput)
  if (!scored) {
    return { durationMs, overlapRate, overlapObserved, overlapTrue, holdSumMs, holdSamples }
  }

  const { correct, incorrect } = scored
  const totalChars = correct + incorrect
  const accuracy = totalChars > 0 ? (correct / totalChars) * 100 : undefined
  const minutes = durationMs / 60_000
  const wordPace = minutes > 0 ? (correct / 5) / minutes : undefined

  return {
    wordPace,
    accuracy,
    overlapRate,
    overlapObserved,
    overlapTrue,
    holdSumMs,
    holdSamples,
    correctChars: totalChars > 0 ? correct : undefined,
    incorrectChars: totalChars > 0 ? incorrect : undefined,
    durationMs,
  }
}

/** Build the zoom-independent display model for a run's raw keystroke
 *  log. All coordinates are display-ms (see the module doc comment);
 *  the caller (WordTimelineView) only ever changes the pixel-per-ms
 *  scale, never recomputes a position from this function's output. */
export function buildWordTimeline(log: RunKeystrokeLog): WordTimelineModel {
  let crossWordLastObservedMs: number | null = null
  let maxDisplayMs = 0

  const words: WordTimelineWord[] = log.words.map((word, i) => {
    const built = buildWord(word, crossWordLastObservedMs)
    if (built.lastObservedTrueMs !== undefined) crossWordLastObservedMs = built.lastObservedTrueMs
    if (built.maxEndMs > maxDisplayMs) maxDisplayMs = built.maxEndMs

    return {
      index: word.index,
      display: word.display,
      typed: word.typed,
      partial: word.partial ?? false,
      segments: built.segments,
      laneCount: built.laneCount,
      stats: buildStats(word, built.durationMs, {
        overlapObserved: built.overlapObserved,
        overlapTrue: built.overlapTrue,
        holdSumMs: built.holdSumMs,
        holdSamples: built.holdSamples,
        isRunLastWord: i === log.words.length - 1,
        romajiInput: log.romajiInput === true,
      }),
    }
  })

  return {
    words,
    maxDisplayMs,
    charCorrelationUnavailable: log.charCorrelationUnavailable ?? false,
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

/** Whole-run averages for the modal's summary cards, used only as a
 *  fallback when no already-computed `TypingTestResult` is available for
 *  this run (see `WordTimelineView`'s `result` prop) — a real result's own
 *  figures are preferred since they're what the History row itself shows.
 *
 *  Every figure here is POOLED across the underlying events (chars /
 *  keystrokes / true ms), never a plain mean of each word's own ratio —
 *  a mean-of-ratios would weight a 1-keystroke word the same as a
 *  20-keystroke word, which previously let a single truly-overlapped
 *  keystroke in an otherwise-clean run report 100% overlap for the whole
 *  run instead of its true, much smaller share. */
export function buildWordTimelineSummary(model: WordTimelineModel): WordTimelineSummary {
  const scoredWords = model.words.filter((w) => w.stats.accuracy !== undefined && w.stats.correctChars !== undefined)

  const correctSum = sum(scoredWords.map((w) => w.stats.correctChars!))
  const incorrectSum = sum(scoredWords.map((w) => w.stats.incorrectChars!))
  const totalChars = correctSum + incorrectSum
  const avgAccuracy = totalChars > 0 ? (correctSum / totalChars) * 100 : undefined

  // Span-weighted, not a mean of per-word rates: Σ(correct chars / 5)
  // over Σ(true span in minutes) — a word with a longer true span
  // contributes proportionally more to the run-wide figure, the same
  // weighting `avgAccuracy` above uses by char count. Restricted to words
  // with a measurable span (`wordPace !== undefined`, i.e. durationMs >
  // 0) — a scored word with zero true span (e.g. a single open-ended
  // keystroke: accuracy defined, wordPace withheld) would otherwise add
  // its chars to the numerator while adding zero minutes to the
  // denominator, inflating the run-wide pace. `avgAccuracy` above keeps
  // pooling the full `scoredWords` set since it has no such denominator.
  const paceWords = scoredWords.filter((w) => w.stats.wordPace !== undefined)
  const paceCorrectSum = sum(paceWords.map((w) => w.stats.correctChars!))
  const spanMinutesSum = sum(paceWords.map((w) => w.stats.durationMs / 60_000))
  const avgPace = spanMinutesSum > 0 ? (paceCorrectSum / 5) / spanMinutesSum : undefined

  const overlapWords = model.words.filter((w) => w.stats.overlapObserved !== undefined)
  const overlapObservedSum = sum(overlapWords.map((w) => w.stats.overlapObserved!))
  const overlapTrueSum = sum(overlapWords.map((w) => w.stats.overlapTrue!))
  const avgOverlap = overlapObservedSum > 0 ? overlapTrueSum / overlapObservedSum : undefined

  const holdWords = model.words.filter((w) => w.stats.holdSamples !== undefined)
  const holdSumMsTotal = sum(holdWords.map((w) => w.stats.holdSumMs!))
  const holdSamplesTotal = sum(holdWords.map((w) => w.stats.holdSamples!))
  const avgHoldMs = holdSamplesTotal > 0 ? holdSumMsTotal / holdSamplesTotal : undefined

  return { avgPace, avgAccuracy, avgOverlap, avgHoldMs }
}
