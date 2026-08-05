// SPDX-License-Identifier: GPL-2.0-or-later
// Single source of truth for the "qualifying hold duration" rule behind
// average-key-hold pooling — shared by two independent accumulation sites
// that must never drift apart: word-timeline.ts's `buildKeystrokeStream`
// (pools into `WordTimelineStats.holdSumMs`/`holdSamples`, itself pooled
// into `WordTimelineSummary.avgHoldMs`) and run-log-recorder.ts's
// `RunLogRecorder.currentRunHoldStats` (the still-live recorder buffer
// snapshot `useTypingTestResultSave` reads before `finish()` clears it).

/** The TRUE press-to-release span for one keystroke, when it qualifies as
 *  an average-key-hold sample: `releaseMs` must be observed AND the
 *  resulting span must be strictly positive — a release at or before its
 *  own press (same-instant, or negative — defensive only) never counts.
 *  Returns `undefined` when the keystroke doesn't qualify. */
export function qualifyingHoldMs(pressMs: number, releaseMs: number | undefined): number | undefined {
  if (releaseMs === undefined) return undefined
  const holdMs = releaseMs - pressMs
  return holdMs > 0 ? holdMs : undefined
}
