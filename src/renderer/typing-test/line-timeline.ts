// SPDX-License-Identifier: GPL-2.0-or-later
// Pure log → display model for the per-LINE keystroke timeline (see
// .claude/tasks/backlog/Task-line-timeline-pr2-line-view.md and
// .claude/plans/Plan-line-keystroke-timeline.md). Sibling of
// `word-timeline.ts`: a "line" groups one or more `RunWord`s onto ONE
// shared display-ms axis (built once via `buildKeystrokeStream`, never
// per-word — see that function's own doc comment), rather than resetting
// the display cursor at every word boundary the way the per-word view
// does. Selected by `WordTimelineView` whenever `RunKeystrokeLog.lineBreaks`
// is PRESENT (see that field's own doc comment on why presence, not
// emptiness, is the switch) — a legacy log with no `lineBreaks` never
// reaches this module.

import type { RunKeystrokeLog, RunWord } from '../../shared/types/typing-run-log'
import {
  buildKeystrokeStream,
  computeScoredWordCharCounts,
  GAP_DISPLAY_CAP_MS,
  type WordTimelineSegment,
  type KeystrokeSegment,
} from './word-timeline'

/** Blank-gap threshold for the LINE view, deliberately far below
 *  `WORD_BLANK_THRESHOLD_MS` (1000ms) — matches the timeline modal's
 *  line-view legend (">250ms"). A line's shared axis already spans
 *  several words' worth of ordinary inter-word rhythm; the word view's
 *  coarser 1000ms cut would hide exactly the kind of pause a line view
 *  exists to surface. Also doubles as the cross-line lead-in trigger
 *  (see `buildLine`) — one constant serving both roles mirrors
 *  `WORD_BLANK_THRESHOLD_MS`'s own dual role in `buildWord`. */
export const LINE_BLANK_THRESHOLD_MS = 250

/** One word's position on its line's shared display-ms axis — enough for
 *  the row (`LineTimelineRow.tsx`) to draw a subtle word-boundary
 *  separator and to reconstruct the line's own display/typed text by
 *  joining `display`/`typed` across `LineTimelineLine.words` in order. */
export interface LineWordBoundary {
  index: number
  display: string
  typed: string
  partial: boolean
  /** Display-ms offset where this word's own content starts on the
   *  line's shared axis — the position of its first keystroke segment,
   *  or (a word with no keystrokes of its own) wherever the axis stood
   *  right after the previous word — see `buildLine`. */
  startMs: number
}

export interface LineTimelineStats {
  /** Raw keystroke count / true active-duration minutes — a RATE
   *  distinct from `WordTimelineStats.wordPace` (which is correct-chars
   *  based): a line groups multiple words, so "words per minute" stops
   *  being a meaningful per-row figure the way it is for a single word;
   *  "keystrokes per minute" doesn't have that problem. Undefined when
   *  the line has no measurable span (no keystrokes, or zero duration). */
  kpm?: number
  /** Char-weighted accuracy pooled across the line's own scored words —
   *  Σ correct / Σ (correct + incorrect), the same pooling
   *  `buildWordTimelineSummary` uses for the whole run, just scoped to
   *  one line's words (see `computeScoredWordCharCounts`). Undefined
   *  when no word in the line is scoreable (every word partial, romaji,
   *  or keystroke-less). */
  accuracy?: number
  /** Keystroke-weighted overlap ratio over the line's own keystrokes —
   *  Σ overlapTrue / Σ overlapObserved. Undefined when nothing in the
   *  line has an observed overlap verdict. */
  overlapRate?: number
  /** True elapsed seconds from the line's first press to its last
   *  observed boundary (mirrors `WordTimelineStats.durationMs`, just in
   *  seconds and at line scope — see `AnalyzeStatGrid`'s duration card
   *  convention, `formatDuration`, which this is meant to feed). */
  durationSeconds: number
}

export interface LineTimelineLine {
  lineIndex: number
  words: LineWordBoundary[]
  segments: WordTimelineSegment[]
  /** Lane count for this line's row — drives the row's SVG height, same
   *  convention as `WordTimelineWord.laneCount`. */
  laneCount: number
  stats: LineTimelineStats
}

export interface LineTimelineModel {
  lines: LineTimelineLine[]
  /** Shared display-ms width every line's row uses for its `viewBox` —
   *  the run's longest LINE decides it (mirrors
   *  `WordTimelineModel.maxDisplayMs`, just at line granularity). */
  maxDisplayMs: number
  charCorrelationUnavailable: boolean
}

/** Splits a run's words into lines at each break — `lineBreaks[i]` is the
 *  index (into `words`) of that line's LAST word (see
 *  `RunKeystrokeLog.lineBreaks`'s own doc comment for the validated
 *  invariants this relies on: sorted, unique, strictly ascending, and
 *  never `words.length - 1`). An empty `lineBreaks` array produces a
 *  single line spanning every word — see that same doc comment on why
 *  presence, not emptiness, is what selects line-view rendering in the
 *  first place; this function only ever runs once that selection has
 *  already been made. */
export function groupWordsIntoLines(words: RunWord[], lineBreaks: number[]): RunWord[][] {
  const lines: RunWord[][] = []
  let start = 0
  for (const brk of lineBreaks) {
    lines.push(words.slice(start, brk + 1))
    start = brk + 1
  }
  lines.push(words.slice(start))
  return lines
}

interface LineBuildResult {
  words: LineWordBoundary[]
  segments: WordTimelineSegment[]
  laneCount: number
  maxEndMs: number
  stats: LineTimelineStats
  /** Carried forward as the NEXT line's own cross-line lead-in
   *  comparison point — undefined when this line had no keystrokes at
   *  all (mirrors `WordBuildResult.lastObservedTrueMs`: an empty line
   *  never updates the carry-over). */
  lastObservedTrueMs?: number
}

/** Builds one line's shared-axis model. `lineWords` is the contiguous
 *  slice of `RunWord`s this line owns (from `groupWordsIntoLines`);
 *  `startGlobalWordIdx` is that slice's own offset into the RUN's full
 *  word list — needed (alongside `totalWordsInRun`) to identify the
 *  run's actual last word for separator-credit purposes, since that rule
 *  is a RUN-wide fact, not a line-local one (see
 *  `computeScoredWordCharCounts`'s own doc comment: withheld only for
 *  the run's final word, never at every line's own last word). */
function buildLine(
  lineWords: RunWord[],
  crossLineLastObservedMs: number | null,
  startGlobalWordIdx: number,
  totalWordsInRun: number,
  romajiInput: boolean,
): LineBuildResult {
  // Flatten every word's keystrokes onto one line-wide list, tagging each
  // with which word (by position within THIS line) it came from, then
  // sort once by press order — mirrors `buildWord`'s own per-word sort,
  // just widened to span the whole line so gaps between words inside the
  // same line become ordinary (capped) blank segments on the shared axis
  // instead of a per-word cursor reset.
  const tagged: { keystroke: RunWord['keystrokes'][number]; wordLocalIdx: number }[] = []
  lineWords.forEach((w, li) => {
    for (const k of w.keystrokes) tagged.push({ keystroke: k, wordLocalIdx: li })
  })
  tagged.sort((a, b) => a.keystroke.pressMs - b.keystroke.pressMs)

  if (tagged.length === 0) {
    const words: LineWordBoundary[] = lineWords.map((w) => ({
      index: w.index,
      display: w.display,
      typed: w.typed,
      partial: w.partial ?? false,
      startMs: 0,
    }))
    return {
      words,
      segments: [],
      laneCount: 0,
      maxEndMs: 0,
      stats: { durationSeconds: 0 },
    }
  }

  const flatKeystrokes = tagged.map((t) => t.keystroke)
  const segments: WordTimelineSegment[] = []
  let displayCursor = 0

  // Line-crossing hesitation ONLY — a pause between two words INSIDE the
  // same line is never promoted to a leadInPause marker (that would
  // wrongly imply a line-boundary transition); it renders as an ordinary
  // blank segment on the shared axis via `buildKeystrokeStream` below.
  // See the task's binding scoring rule: "a pause crossing a line
  // boundary becomes a line-start lead-in marker ... never at every line
  // end" — the same logic applies symmetrically at the START of a line.
  const firstPressMs = flatKeystrokes[0].pressMs
  if (crossLineLastObservedMs !== null) {
    const leadGap = firstPressMs - crossLineLastObservedMs
    if (leadGap >= LINE_BLANK_THRESHOLD_MS) {
      segments.push({ kind: 'leadInPause', startMs: 0, endMs: GAP_DISPLAY_CAP_MS, trueDurationMs: leadGap })
      displayCursor += GAP_DISPLAY_CAP_MS
    }
  }

  const stream = buildKeystrokeStream(flatKeystrokes, LINE_BLANK_THRESHOLD_MS, displayCursor)
  // Blanks first (background), keystrokes last (foreground) — same
  // paint-order convention as `buildWord`.
  segments.push(...stream.blankSegments, ...stream.keystrokeSegments)

  // Word-boundary marker offsets: for each word (by its LOCAL position in
  // this line), the display-ms of its own first keystroke segment on the
  // shared axis — found via the FIRST occurrence of that word's local
  // index in the press-sorted `tagged` list, which is index-aligned 1:1
  // with `stream.keystrokeSegments` (see `buildKeystrokeStream`'s own
  // doc comment: it preserves input order). A word with no keystrokes of
  // its own never appears in `tagged`, so it falls back to `carryOffset`
  // — wherever the axis stood right after the previous word — rather
  // than fabricating a position (mirrors an empty word contributing zero
  // width in the per-word view).
  const wordFirstOffset = new Map<number, number>()
  const wordMaxEnd = new Map<number, number>()
  tagged.forEach((t, i) => {
    const seg = stream.keystrokeSegments[i]
    if (!wordFirstOffset.has(t.wordLocalIdx)) wordFirstOffset.set(t.wordLocalIdx, seg.startMs)
    wordMaxEnd.set(t.wordLocalIdx, Math.max(wordMaxEnd.get(t.wordLocalIdx) ?? -Infinity, seg.endMs))
  })

  let carryOffset = 0
  const words: LineWordBoundary[] = lineWords.map((w, li) => {
    const startMs = wordFirstOffset.get(li) ?? carryOffset
    carryOffset = wordMaxEnd.get(li) ?? carryOffset
    return { index: w.index, display: w.display, typed: w.typed, partial: w.partial ?? false, startMs }
  })

  // Per-line stats — pooled the same way `buildWordTimelineSummary`
  // pools the whole run's, just scoped to this line's own words/
  // keystrokes (see `LineTimelineStats`'s own field doc comments).
  const durationMs = stream.lastObservedTrueMs - firstPressMs
  const durationSeconds = durationMs / 1000
  const kpm = durationMs > 0 ? flatKeystrokes.length / (durationMs / 60_000) : undefined
  const overlapRate = stream.overlapObserved !== undefined ? stream.overlapTrue! / stream.overlapObserved : undefined

  let correctSum = 0
  let incorrectSum = 0
  let anyScored = false
  lineWords.forEach((w, li) => {
    const globalIdx = startGlobalWordIdx + li
    const scored = computeScoredWordCharCounts(w, globalIdx === totalWordsInRun - 1, romajiInput)
    if (!scored) return
    const totalChars = scored.correct + scored.incorrect
    if (totalChars <= 0) return
    anyScored = true
    correctSum += scored.correct
    incorrectSum += scored.incorrect
  })
  const accuracy = anyScored ? (correctSum / (correctSum + incorrectSum)) * 100 : undefined

  return {
    words,
    segments,
    laneCount: stream.laneCount,
    maxEndMs: stream.maxEndMs,
    stats: { kpm, accuracy, overlapRate, durationSeconds },
    lastObservedTrueMs: stream.lastObservedTrueMs,
  }
}

/** Build the zoom-independent per-LINE display model for a run's raw
 *  keystroke log — the line-view counterpart to `buildWordTimeline`.
 *  Callers must only invoke this once `log.lineBreaks` is known to be
 *  present (the type parameter enforces it) — see the module doc
 *  comment. */
export function buildLineTimeline(log: RunKeystrokeLog & { lineBreaks: number[] }): LineTimelineModel {
  const lineGroups = groupWordsIntoLines(log.words, log.lineBreaks)
  const romajiInput = log.romajiInput === true

  let crossLineLastObservedMs: number | null = null
  let maxDisplayMs = 0
  let globalWordIdx = 0

  const lines: LineTimelineLine[] = lineGroups.map((lineWords, lineIndex) => {
    const built = buildLine(lineWords, crossLineLastObservedMs, globalWordIdx, log.words.length, romajiInput)
    globalWordIdx += lineWords.length
    if (built.lastObservedTrueMs !== undefined) crossLineLastObservedMs = built.lastObservedTrueMs
    if (built.maxEndMs > maxDisplayMs) maxDisplayMs = built.maxEndMs

    return {
      lineIndex,
      words: built.words,
      segments: built.segments,
      laneCount: built.laneCount,
      stats: built.stats,
    }
  })

  return {
    lines,
    maxDisplayMs,
    charCorrelationUnavailable: log.charCorrelationUnavailable ?? false,
  }
}

// Re-exported for callers (`LineTimelineRow.tsx`) that need to
// distinguish a keystroke segment from a blank/leadIn one when rendering
// hover targets — mirrors `word-timeline-row.tsx`'s own use of this type
// from `word-timeline.ts`.
export type { KeystrokeSegment }
