// SPDX-License-Identifier: GPL-2.0-or-later
// Builds the unified stat-card list `KeystrokeTimelinePanel` shows — the
// same ten figures (WPM, KPM, Accuracy, KSPC, Time, Words, Overlap,
// Substitution, Omission, Insertion) in both the History timeline modal
// and the inline completion screen, so a run reads identically in either
// place. See .claude/plans/Plan-completion-timeline-view.md PR-A spec
// point 2.
//
// Fallback scope is deliberately narrow: only WPM, Accuracy, Time, and
// Overlap have a value when `result` is absent —
//  - WPM/Accuracy fall back to the run-wide pooled figures
//    `WordTimelineSummary` already computed pre-unification
//    (`avgPace`/`avgAccuracy`), the same fallback the modal's summary
//    cards used before this module existed.
//  - Time falls back to the resolved log's own `durationMs` — a raw log
//    fact, not a model derivation, but available unconditionally since
//    `KeystrokeTimelinePanel` always receives the log itself.
//  - Overlap has no `TypingTestResult` equivalent at all (that field was
//    never recorded on the result), so it is ALWAYS model-derived.
// KPM, KSPC, and the three error-class counts stay result-only:
// reconstructing them from the raw log would mean re-deriving scoring
// rules run-state.ts already owns (confirmed-char counting, romaji
// segment credit, KSPC's IME-uncomputable gate, WER/CER-style error
// classification, ...) — a second, possibly-diverging implementation of
// the same math that this module deliberately avoids. Without a result
// (or on a result predating error-class tracking, e.g. a romaji run)
// these read as `EMPTY_STAT_VALUE`, the same convention History already
// uses for a legacy/uncomputable row — unlike `MissedCharsList`/the
// former `ErrorClassLine` row below, these three are always-present
// cards (same as Overlap), never omitted as a block.
// The 7th card (Words/Lines) is the one exception to "result-only": when
// `log.lineBreaks` is present it derives straight from the LOG (see
// `wordsOrLinesCard`'s own doc comment), unconditionally — a line-based
// run's line count is knowable even without a `result` at all, unlike
// KPM/KSPC/error-class, which have no raw-log equivalent to fall back to.
// The 11th card (Avg Key Hold) is a THIRD fallback shape, distinct from
// both of the above: unlike KPM/KSPC/error-class (result-only, no model
// equivalent exists) it DOES have an always-available model equivalent
// (`summary.avgHoldMs`, pooled straight from the log already loaded here);
// unlike WPM/Accuracy (fall back only when `result` itself is entirely
// absent, since those fields are never optional on an existing result) its
// own result field (`holdSumMs`/`holdSamples`) can be legacy-absent even
// when `result` exists. So it falls back per-VALUE: prefer the result's
// own derived mean when present, else the model summary, regardless of
// whether `result` exists at all — see `avgHoldMsFor` below.

import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { WordTimelineSummary } from './word-timeline'
import type { AnalyzeSummaryItem } from '../components/analyze/analyze-summary-table'
import { formatDuration, formatPercentLabel, fmtMs } from '../components/analyze/analyze-format'
import { formatWpm } from '../components/analyze/analyze-wpm'
import { formatKspc } from '../../shared/kspc'
import { EMPTY_STAT_VALUE } from '../components/analyze/analyze-constants'
import { resultKpm, resultKspc, resultAvgHoldMs } from './result-builder'

/** The 7th card's caption + value — "Words" for a normal (Monkeytype-style)
 *  run, "Lines" for a line-based one (fileImport with real line structure,
 *  or a tatoeba Lines-pattern run — each tatoeba "word" unit IS one line).
 *  Reuses `editor.typingTest.lines`, the sidebar's own bare "Lines"
 *  caption — no new i18n key needed, it's already the same shape as
 *  `editor.typingTest.words` ("Words"), just for the other unit.
 *
 *  Two-tier signal, most-authoritative first:
 *   1. `log.lineBreaks !== undefined` — the line-based signal actually
 *      PERSISTED on this run's own log (see `RunKeystrokeLog.lineBreaks`'s
 *      own doc comment). When present, the line count comes directly from
 *      it (`lineBreaks.length + 1` — N breaks divide the run into N+1
 *      lines), regardless of `result`/mode: this is ground truth for
 *      exactly this run, the same way `deriveLineBreaksForLog` decided at
 *      save time.
 *   2. `result?.mode` — a coarser fallback for when the log itself carries
 *      no `lineBreaks` (e.g. a legacy log saved before that field
 *      existed). `'tatoeba'` can still be labeled Lines because that
 *      mode's own word-flow architecture always maps 1 unit to 1 line, so
 *      `result.wordCount` doubles as the line count without needing the
 *      log's own field. `'fileImport'` WITHOUT a persisted `lineBreaks`
 *      cannot: a fileImport text's own line layout (words per line) isn't
 *      fixed, so there is no way to recover line count from `wordCount`
 *      alone — this case deliberately falls through to the ordinary Words
 *      card, "line count unknowable" rather than guessing. Monkeytype
 *      modes (words/time/quote) and a missing `result` both fall through
 *      to Words too, unchanged from before this card existed. */
function wordsOrLinesCard(result: TypingTestResult | undefined, log: RunKeystrokeLog): AnalyzeSummaryItem {
  if (log.lineBreaks !== undefined) {
    return { labelKey: 'editor.typingTest.lines', value: log.lineBreaks.length + 1 }
  }
  if (result?.mode === 'tatoeba') {
    return { labelKey: 'editor.typingTest.lines', value: result.wordCount }
  }
  return { labelKey: 'editor.typingTest.words', value: result ? result.wordCount : EMPTY_STAT_VALUE }
}

/** `TypingTestResult`-preferred, `WordTimelineSummary`-fallback mean hold
 *  duration for the 11th card — see the module doc comment's paragraph on
 *  this card's distinct fallback shape. */
function avgHoldMsFor(result: TypingTestResult | undefined, summary: WordTimelineSummary): number | null {
  const fromResult = result ? resultAvgHoldMs(result) : null
  return fromResult ?? summary.avgHoldMs ?? null
}

/** Ordered stat cards for `AnalyzeStatGrid` — see the module doc comment
 *  for the fallback rule each card follows. `summary` is `null` only
 *  while the model hasn't resolved yet (never true once
 *  `KeystrokeTimelinePanel` actually renders this row; kept nullable so
 *  callers can gate the whole grid on it same as before). */
export function buildTimelineStatItems(
  result: TypingTestResult | undefined,
  summary: WordTimelineSummary | null,
  log: RunKeystrokeLog,
): AnalyzeSummaryItem[] {
  if (!summary) return []

  const kspc = result ? resultKspc(result) : null
  const durationSeconds = result ? result.durationSeconds : Math.round(log.durationMs / 1000)

  return [
    {
      // `result.wpm` is the run's own WPM (words/min over the whole run,
      // the same figure History's own row shows) — a genuinely different
      // metric from the model-derived `avgPace` (a char-weighted rate
      // over words' own true spans, excluding inter-word time; see
      // `WordTimelineSummary.avgPace`'s doc comment). Distinct label so
      // this card never claims to be "Word Pace" when it's actually
      // showing the run-wide figure.
      labelKey: result
        ? 'editor.typingTest.history.timeline.stats.runWpm'
        : 'editor.typingTest.history.timeline.stats.wordPace',
      value: result ? formatWpm(result.wpm) : (summary.avgPace !== undefined ? formatWpm(summary.avgPace) : EMPTY_STAT_VALUE),
    },
    {
      labelKey: 'editor.typingTest.kpm',
      value: result ? resultKpm(result) : EMPTY_STAT_VALUE,
    },
    {
      labelKey: 'editor.typingTest.history.timeline.stats.accuracy',
      value: result
        ? formatPercentLabel(result.accuracy / 100)
        : formatPercentLabel(summary.avgAccuracy !== undefined ? summary.avgAccuracy / 100 : undefined),
    },
    {
      labelKey: 'editor.typingTest.kspc',
      value: kspc !== null ? formatKspc(kspc) : EMPTY_STAT_VALUE,
    },
    {
      labelKey: 'editor.typingTest.time',
      value: formatDuration(durationSeconds),
    },
    wordsOrLinesCard(result, log),
    {
      labelKey: 'editor.typingTest.history.timeline.stats.overlap',
      value: formatPercentLabel(summary.avgOverlap),
    },
    // Reuses ErrorMixSection's own per-class caption keys (#332) rather
    // than the `results.errorSubstitutions` et al. keys — those are
    // "Substitution {{count}}"-style interpolated sentences meant for the
    // completion screen's inline mistake line, not a bare card caption.
    {
      labelKey: 'editor.typingTest.history.errorMixLabelSubstitution',
      value: result?.errorSubstitutions ?? EMPTY_STAT_VALUE,
    },
    {
      labelKey: 'editor.typingTest.history.errorMixLabelOmission',
      value: result?.errorOmissions ?? EMPTY_STAT_VALUE,
    },
    {
      labelKey: 'editor.typingTest.history.errorMixLabelInsertion',
      value: result?.errorInsertions ?? EMPTY_STAT_VALUE,
    },
    {
      labelKey: 'editor.typingTest.history.timeline.stats.avgHold',
      value: fmtMs(avgHoldMsFor(result, summary)),
      descriptionKey: 'editor.typingTest.history.timeline.stats.avgHoldTooltip',
    },
  ]
}
