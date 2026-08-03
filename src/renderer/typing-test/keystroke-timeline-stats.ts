// SPDX-License-Identifier: GPL-2.0-or-later
// Builds the unified stat-card list `KeystrokeTimelinePanel` shows — the
// same seven figures (WPM, KPM, Accuracy, KSPC, Time, Words, Overlap) in
// both the History timeline modal and (a later PR) the inline completion
// screen, so a run reads identically in either place. See
// .claude/plans/Plan-completion-timeline-view.md PR-A spec point 2.
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
// KPM, KSPC, and Words stay result-only: reconstructing them from the raw
// log would mean re-deriving scoring rules run-state.ts already owns
// (confirmed-char counting, romaji segment credit, KSPC's
// IME-uncomputable gate, ...) — a second, possibly-diverging
// implementation of the same math that this module deliberately avoids.
// Without a result these three read as `EMPTY_STAT_VALUE`, the same
// convention History already uses for a legacy/uncomputable row.

import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { WordTimelineSummary } from './word-timeline'
import type { AnalyzeSummaryItem } from '../components/analyze/analyze-summary-table'
import { formatDuration, formatPercentLabel } from '../components/analyze/analyze-format'
import { formatWpm } from '../components/analyze/analyze-wpm'
import { formatKspc } from '../../shared/kspc'
import { EMPTY_STAT_VALUE } from '../components/analyze/analyze-constants'
import { resultKpm, resultKspc } from './result-builder'

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
    {
      labelKey: 'editor.typingTest.words',
      value: result ? result.wordCount : EMPTY_STAT_VALUE,
    },
    {
      labelKey: 'editor.typingTest.history.timeline.stats.overlap',
      value: formatPercentLabel(summary.avgOverlap),
    },
  ]
}
