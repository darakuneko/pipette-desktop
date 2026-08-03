// SPDX-License-Identifier: GPL-2.0-or-later
// Model-selection hook for `WordTimelineView` — picks per-word vs.
// per-line rendering based on `RunKeystrokeLog.lineBreaks` FIELD
// PRESENCE (see that field's own doc comment in typing-run-log.ts: `[]`
// means "one line", still line-mode; absent means a legacy log, always
// word-mode). Extracted out of the view component itself to keep
// WordTimelineView.tsx under its file-splitting cap (see
// .claude/rules/file-splitting.md) — this hook owns every `useMemo` that
// derives from `log`, the view owns only rendering + zoom/hover DOM
// wiring.

import { useMemo } from 'react'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import { buildWordTimeline, buildWordTimelineSummary, type WordTimelineModel, type WordTimelineSummary } from './word-timeline'
import { buildLineTimeline, type LineTimelineModel } from './line-timeline'

export type TimelineDisplayMode = 'line' | 'word'

export interface TimelineModelResult {
  displayMode: TimelineDisplayMode | null
  wordModel: WordTimelineModel | null
  lineModel: LineTimelineModel | null
  /** Whole-run pooled averages (Word Pace / Accuracy / Overlap) for the
   *  modal's summary cards — always derived from the WORD-level model
   *  regardless of `displayMode`: these are run-wide totals, not a
   *  function of how the rows below happen to be grouped, so switching
   *  to line-mode rendering must never change what the summary cards
   *  report. */
  summary: WordTimelineSummary | null
  /** The active row model's own shared axis width — line-mode's rows use
   *  `lineModel.maxDisplayMs`, word-mode's use `wordModel.maxDisplayMs`
   *  (the two are NOT interchangeable: a line's axis spans multiple
   *  words on a 250ms blank threshold, a word's spans one on a 1000ms
   *  threshold — see each builder's own doc comment). */
  activeMaxDisplayMs: number
  activeCharCorrelationUnavailable: boolean
}

export function useTimelineModel(log: RunKeystrokeLog | null): TimelineModelResult {
  const displayMode: TimelineDisplayMode | null = log ? (log.lineBreaks !== undefined ? 'line' : 'word') : null

  // Always built (even in line-mode) — the summary cards below need it
  // regardless of which rows are on screen, and a run log is capped at
  // MAX_RUN_LOG_EVENTS keystrokes, so a second pass over it is cheap.
  const wordModel = useMemo<WordTimelineModel | null>(() => (log ? buildWordTimeline(log) : null), [log])
  const summary = useMemo(() => (wordModel ? buildWordTimelineSummary(wordModel) : null), [wordModel])

  const lineModel = useMemo<LineTimelineModel | null>(
    () => (log && log.lineBreaks !== undefined ? buildLineTimeline(log as RunKeystrokeLog & { lineBreaks: number[] }) : null),
    [log],
  )

  const activeMaxDisplayMs = displayMode === 'line' ? (lineModel?.maxDisplayMs ?? 0) : (wordModel?.maxDisplayMs ?? 0)
  const activeCharCorrelationUnavailable = displayMode === 'line'
    ? (lineModel?.charCorrelationUnavailable ?? false)
    : (wordModel?.charCorrelationUnavailable ?? false)

  return { displayMode, wordModel, lineModel, summary, activeMaxDisplayMs, activeCharCorrelationUnavailable }
}
