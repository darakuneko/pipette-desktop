// SPDX-License-Identifier: GPL-2.0-or-later
// Per-run raw keystroke log for a Typing Test run — the timeline data a
// per-minute aggregate cannot reconstruct (order and inter-keystroke
// gaps are lost once folded into a minute bucket). See
// .claude/tasks/backlog/Task-tm-phase5-run-keystroke-log.md and
// .claude/plans/Plan-typing-metrics-chi2018.md Phase 5.
//
// PRIVACY (read before touching this file): this is the highest
// input-content-recovery-risk data in the app — higher than trigrams.
// It is captured ONLY for a Typing Test run (known, non-secret
// material, unlike ambient REC), only under the existing REC recording-
// consent gate, is never sent to Hub, and carries no absolute
// timestamps in the per-keystroke payload (see RunKeystroke). See
// run-log-recorder.ts (renderer) for the capture-side guarantees this
// file only describes the shape of.

/** One physical keystroke within a run, timed relative to the run's own
 *  start (never an absolute clock timestamp — see the module doc
 *  comment). Deliberate deviations from the task sketch, spelled out so
 *  a future reader doesn't "fix" them back:
 *  - `overlapped` is optional to preserve the same tri-state
 *    observability contract as the existing per-minute analytics
 *    (`overlap` on `TypingAnalyticsEventPayload`) — undefined means
 *    "unobservable" (e.g. following an observation hole), not "false".
 *    See matrix-press-duration.ts.
 *  - `releaseMs` is optional: a run can finish (or the recorder's
 *    buffer can be handed to `finish()`) while a key is still held —
 *    `resetMatrixPressTracking` discards a still-open press rather
 *    than fabricating a release for it, so the keystroke is kept with
 *    no release instead of being dropped.
 *  - `correct`/`expectedChar` are optional: a modifier-only press (no
 *    char produced) and any keystroke typed during IME composition
 *    have no char to correlate against (see
 *    `RunKeystrokeLog.charCorrelationUnavailable`).
 *  - There is no `reading` field — no data source in this codebase
 *    produces one for a run's keystrokes. */
export interface RunKeystroke {
  /** ms since the owning `RunKeystrokeLog.startedAt`. */
  pressMs: number
  /** ms since `RunKeystrokeLog.startedAt`, when observed — see the
   *  field doc above for why this can be absent. A release that
   *  physically arrives before its own press has registered (the press
   *  is still queued behind an unresolved tap-hold classification, while
   *  `matrix-release` bypasses that queue and ships immediately) is
   *  recovered via a small parking map in run-log-recorder.ts rather
   *  than being lost, so `releaseMs` being absent genuinely means the
   *  run ended mid-hold, not just an unlucky arrival order. */
  releaseMs?: number
  keycode: number
  row: number
  col: number
  /** The character this press was expected to confirm, when known. */
  expectedChar?: string
  /** Whether the press matched `expectedChar` (verbatim mode) or
   *  confirmed the current romaji segment (romaji mode). Absent when
   *  there is nothing to correlate against (modifier press, IME
   *  composition input). */
  correct?: boolean
  /** Whether the immediately preceding press was still physically held
   *  when this one landed — mirrors
   *  `TypingAnalyticsEventPayload['overlap']`'s tri-state semantics. */
  overlapped?: boolean
  /** The character this press actually produced, set ONLY when `correct
   *  === false` (never on a correct or unjudged keystroke) — see
   *  run-log-recorder.ts's `applyCharVerdict`. Sourced from the char
   *  analytics pipeline's real DOM 'char' event (the same `key` compared
   *  against `expectedChar` to decide `correct`), NEVER reverse-mapped
   *  from `keycode` — a keycode alone can't recover what character a
   *  layer/shift/dead-key combination actually produced. Optional:
   *  absent on every log saved before this field existed (legacy), and
   *  a consumer must treat that the same as "no per-key detail
   *  available" rather than "typed nothing wrong" — see
   *  `buildMissedDetails` (missed-details.ts). Never sent to Hub, same
   *  privacy class as the rest of this payload (see the module doc
   *  comment). */
  typedChar?: string
  /** The key this mistake aggregates under, set ONLY when `correct ===
   *  false` — matches the run's own `TypingTestState.mistakes` map key
   *  EXACTLY for the same input (verbatim mode: the expected char at
   *  this position, i.e. the same value as `expectedChar`; romaji mode:
   *  the canonical romaji spelling of the kana segment in progress at
   *  this exact keystroke — see `romaji-engine.ts`'s
   *  `currentSegmentCanonicalKey`/`canonicalRomaji`), computed AT INPUT
   *  TIME from live reducer state, not derived later by replaying this
   *  log (log replay was rejected as non-deterministic for romaji — a
   *  segment's eventual canonical spelling can depend on which of
   *  several live alternate spellings the user goes on to complete, so
   *  only the reducer's own in-the-moment state can name it reliably).
   *  Optional for the same legacy-log reason as `typedChar`; the two are
   *  always set or omitted together. */
  mistakeKey?: string
}

/** One finalized word's keystrokes, joined against its `WordResult`. */
export interface RunWord {
  index: number
  display: string
  typed: string
  correct: boolean
  /** True only for the trailing in-flight word a run ended on without
   *  submitting (e.g. a timed run expiring mid-word) — its keystrokes are
   *  real, but `typed`/`correct` describe an interrupted attempt rather
   *  than a judged submission. Absent (not `false`) for every ordinarily
   *  finalized word, mirroring this module's other optional-field
   *  convention. See run-log-recorder.ts's `finish()`. */
  partial?: boolean
  keystrokes: RunKeystroke[]
}

export interface RunKeystrokeLog {
  runId: string
  uid: string
  /** ISO 8601 — the run's absolute start time. This is the ONLY
   *  absolute timestamp anywhere in this payload; every `RunKeystroke`
   *  time is relative to it (see the module doc comment). Same
   *  exposure class as the already-synced `TypingTestResult.date` — not
   *  a new category of absolute-time exposure, just a finer-grained
   *  one attached to per-keystroke detail instead of a per-run summary. */
  startedAt: string
  durationMs: number
  mode: string
  language: string
  /** True once at least one keystroke in this run went through IME
   *  composition, making char-level correctness/expectedChar
   *  unavailable for (at least) that keystroke — mirrors
   *  `TypingTestState.kspcUncomputable`'s naming/spirit for this log. */
  charCorrelationUnavailable?: boolean
  /** True when romaji-keystroke judging was actually in effect for this
   *  run (mirrors `TypingTestResult.romajiInput` — see
   *  `isRomajiInputActive`). `RunKeystroke.expectedChar`/`correct` are
   *  romaji-space values (the typed kana segment's canonical spelling),
   *  while `RunWord.display`/`typed` stay in the word's own kana/text
   *  space — the two are not directly comparable char-by-char, so a
   *  consumer (see word-timeline.ts) must not run its verbatim
   *  char-count scoring (`computeWordCharCounts`) against them when this
   *  is true. Optional and backward-compatible: a log saved before this
   *  field existed has no way to know its own romaji state, so it is
   *  treated as non-romaji (`undefined` reads the same as `false`) —
   *  the pre-existing (and only slightly wrong, not nonsensical) verbatim
   *  scoring is preferred over guessing. */
  romajiInput?: boolean
  /** Sorted, unique, ascending line-end word indices (into `words`) — the
   *  reading window's logical line structure at the moment this run
   *  finished, so a saved run can later be re-rendered as per-line
   *  timeline rows instead of one flat per-word list. Every index is
   *  STRICTLY less than `words.length - 1` — a line break describes
   *  where a line ENDS before ANOTHER FOLLOWS, so the last word in
   *  `words` (which has nothing after it) can never be one; see
   *  `isValidLineBreaks` (typing-run-log-store.ts) for the enforced
   *  bound and `parseFileImportText`'s matching terminal-break removal
   *  (typing-test-text-store.ts). FIELD PRESENCE (not emptiness)
   *  selects rendering mode: `[]` legitimately means "the run was one
   *  line" (still line-mode — a single row), while the field being
   *  absent altogether means a log saved before this feature existed,
   *  which falls back to the original per-word rendering. Never sent to
   *  Hub — this field lives inside the same opaque log payload that
   *  already isn't (see the module doc comment). See
   *  TypingTestView.tsx's `LineSnapshot` (the live source for
   *  monkeytype modes) and `useTypingTestResultSave`'s
   *  `deriveLineBreaksForLog` (real `state.lineBreaks` for
   *  tatoeba/fileImport — chosen by `config.mode`, never by whether
   *  `state.lineBreaks` happens to be empty — the snapshot otherwise). */
  lineBreaks?: number[]
  words: RunWord[]
}

/** Index entry — deliberately `id` (not `runId`) to mirror every other
 *  index-based store's `EntryMeta` shape (`AnalyzeFilterSnapshotMeta`,
 *  `KeyLabelMeta`, ...) so this store's index can reuse the generic
 *  `mergeEntries`/`gcTombstones` helpers in `sync/merge.ts` unchanged —
 *  those key strictly on `.id`. `id` holds the same value as the
 *  matching `RunKeystrokeLog.runId`. */
export interface RunLogMeta {
  id: string
  /** ISO 8601, immutable for the entry's lifetime — the ranking key
   *  `applyRunLogRetention` retains-newest-N by, so every device converges
   *  on the same kept set after a merge (see `MAX_RUN_LOGS_PER_KEYBOARD`). */
  startedAt: string
  filename: string
  savedAt: string
  updatedAt?: string
  deletedAt?: string
}

export interface RunLogIndex {
  uid: string
  entries: RunLogMeta[]
}

/** Per-run keystroke event cap — a run producing more than this many
 *  keystrokes has its log refused at `finish()` rather than saved
 *  truncated (see run-log-recorder.ts: a silently-truncated log must
 *  never be saved). */
export const MAX_RUN_LOG_EVENTS = 10_000

/** Per-run serialized-payload byte cap, same refuse-rather-than-
 *  truncate policy as {@link MAX_RUN_LOG_EVENTS}. Checked again on the
 *  main-process side (defense in depth) before a save is accepted. */
export const MAX_RUN_LOG_BYTES = 1_000_000

/** Retention: newest N runs kept per keyboard (see `applyRunLogRetention`
 *  in sync/merge.ts). Ranked by immutable `startedAt` (runId as
 *  tiebreaker) so every device converges on the same 50 after a merge,
 *  rather than LWW resurrecting an evicted entry. */
export const MAX_RUN_LOGS_PER_KEYBOARD = 50
