// SPDX-License-Identifier: GPL-2.0-or-later
// Types, small helpers, and buffer caps backing run-log-recorder.ts's
// in-memory run-log buffer. "The module doc comment" in the doc comments
// below means run-log-recorder.ts's own doc comment, which carries the
// actual PRIVACY / CHAR CORRELATION / ASYMMETRIC STALENESS notes these
// types point back to.

import type { RunKeystroke } from '../../shared/types/typing-run-log'

/** Context carried into every `record` call — mirrors the gate/tag
 *  decision `useInputModes.emitAnalyticsEvent` already makes for the
 *  per-minute pipeline (see `PreparedAnalyticsContext`), but re-checked
 *  independently here rather than trusted from the caller: this is the
 *  privacy-critical gate for the highest-recovery-risk data in the app. */
export interface RunLogRecordContext {
  /** The editor Typing Test's material label, or null for ordinary
   *  Typing View REC input. Recording requires this to be non-null —
   *  the mandatory invariant this whole module exists to enforce. */
  typingTestLabel: string | null
  runId: string | null
  /** `AppConfig.typingRecordingConsentAccepted` — stricter than the
   *  per-minute analytics gate, which records test runs without REC
   *  consent (see the task spec's explicit mandate). */
  consentAccepted: boolean
  /** Whether the app window was focused at the moment this keystroke was
   *  captured (press time for `noteRegistration`/`noteCharContext`,
   *  snapshotted at the same press time for `record` — see
   *  `PreparedAnalyticsContext` in useInputModes.ts). Defense in depth on
   *  top of useTypingTest's own primary gate — see the module doc
   *  comment's PRIVACY paragraph for why HID matrix polling continuing
   *  while unfocused makes this mandatory, not optional. */
  windowFocused: boolean
  /** Whether kana direct-input mode (kana-input.ts) is active for the
   *  current run — read only by `recordMatrixPress`'s `producesChar`
   *  check. Optional/defaults to false so every existing call site
   *  (romaji/verbatim runs, and every pre-existing test) is unaffected;
   *  only the kana-aware caller in use-typing-analytics-sink.ts sets it.
   *  See `producesChar`'s own doc comment in keycode-char-map.ts for why
   *  a JIS-position keycode (KC_RO, KC_JYEN, ...) needs this to be
   *  recognized as char-producing ONLY while kana mode is actually the
   *  one typing through it — outside kana mode those same keycodes
   *  correctly stay non-char-producing for verbatim/romaji runs. */
  kanaInput?: boolean
}

/** Caller-supplied envelope fields `finish()` can't derive from the
 *  buffered keystrokes alone. */
export interface RunLogFinishMeta {
  uid: string
  /** The finishing run's own id (`TypingTestState.runId`) — `finish()`
   *  refuses (returns null) when this doesn't match the buffer's own
   *  runId, so a buffer left over from an earlier, already-abandoned run
   *  (e.g. one that never got a chance to advance via `noteRegistration`
   *  before this call) can never be saved joined to the wrong run's
   *  words. */
  runId: string
  /** Epoch ms the run actually started at — every buffered keystroke's
   *  absolute `Date.now()` timestamp is converted relative to this at
   *  finish time (never persisted as an absolute time itself). */
  startedAtMs: number
  durationMs: number
  mode: string
  language: string
  /** Forwarded verbatim from `TypingTestState.kspcUncomputable` — the
   *  same IME-composition condition that makes KSPC uncomputable also
   *  makes per-keystroke char correlation unreliable for this run (see
   *  the module doc comment's char-correlation note). */
  charCorrelationUnavailable: boolean
  /** Whether romaji-keystroke judging was actually in effect for this run
   *  (the same `isRomajiInputActive` determination the result-builder
   *  path already computes for `TypingTestResult.romajiInput` — see
   *  `useInputModes.ts`'s call site, which reuses that same result rather
   *  than deriving it twice). Forwarded verbatim to
   *  `RunKeystrokeLog.romajiInput` — see that field's own doc comment. */
  romajiInput: boolean
  /** The word the run ended on without submitting (e.g. a timed run
   *  expiring mid-word), if any — `display` is the target word text,
   *  `typed` whatever input was accumulated for it. Omitted when the run
   *  ended cleanly on a word boundary (every words/quote-mode finish) or
   *  with nothing at all typed into the current word. `finish()` appends
   *  this as a trailing `partial: true` RunWord instead of silently
   *  dropping its keystrokes. */
  inFlightWord?: { display: string; typed: string }
  /** Forwarded verbatim to `RunKeystrokeLog.lineBreaks` — `finish()` does
   *  no derivation or clamping of its own; the caller (see
   *  `useTypingTestResultSave`'s `deriveLineBreaksForLog`) has already
   *  chosen the source by `config.mode` (never by `state.lineBreaks`
   *  emptiness — an empty REAL source is a legitimate single-line `[]`,
   *  not "no line structure") and clamped every index to be STRICTLY
   *  less than the last persisted word's own index (`persistedWordCount
   *  - 1`), since a line break can never legitimately land on the run's
   *  own final word. Omitted (not `undefined`-then-dropped — it's
   *  already optional) for a run with no known line structure, same
   *  convention as `RunLogFinishMeta`'s other optional fields; an
   *  explicit `[]` is preserved as-is (see that field's own doc comment
   *  for why it must not collapse to omitted). */
  lineBreaks?: number[]
}

/** Buffered keystroke, kept in absolute-ms form (`Date.now()` values)
 *  until `finish()` converts every run to run-relative ms — see
 *  `RunKeystroke` in `typing-run-log.ts` for why the persisted shape
 *  must never carry an absolute timestamp. Adds `wordIndex`, which is
 *  NOT part of the persisted shape (`RunWord.keystrokes` already groups
 *  implicitly by word) — carrying it on the keystroke itself instead of
 *  bucketing by word up front lets a char event's later, more accurate
 *  attribution (see `noteCharContext`) correct it with a single field
 *  write rather than moving the object between per-word lists. `finish()`
 *  groups the flat buffer back into each `RunWord` by this field, then
 *  strips it before persisting. */
export interface BufferedKeystroke extends RunKeystroke {
  wordIndex: number
  /** Candidate mistake-map key from registration/char-context — NOT part
   *  of the persisted `RunKeystroke` shape (unlike `mistakeKey` itself,
   *  which this field feeds). `applyCharVerdict` promotes this into the
   *  real `mistakeKey` field ONLY when the verdict lands on `correct ===
   *  false`; kept as a separate field (rather than writing straight onto
   *  `mistakeKey` and clearing it back out on every other outcome) so a
   *  keystroke that never reaches a verdict at all (e.g. a bare
   *  modifier, never char-producing, so `applyCharVerdict` is never even
   *  called for it) can never leak a stale `mistakeKey` onto the
   *  persisted shape — see `RunKeystroke.mistakeKey`'s own doc comment
   *  ("set ONLY on incorrect keystrokes"). */
  mistakeKeyCandidate?: string
}

export interface RegistrationAnnotation {
  wordIndex: number
  expectedChar: string | undefined
  /** Candidate mistake-map key (see `RunKeystroke.mistakeKey`'s own doc
   *  comment), threaded alongside `expectedChar` from the same
   *  registration/char-context snapshot. Only ever SURVIVES onto the
   *  persisted keystroke when `applyCharVerdict` later finds `correct ===
   *  false` for it — kept here unconditionally (same as `expectedChar`)
   *  since the verdict isn't known yet at snapshot time. */
  mistakeKey: string | undefined
  /** Authoritative correctness verdict for kana-mode runs, snapshotted at
   *  the same char-context moment as `expectedChar`/`mistakeKey` — see
   *  `kanaStrokeCorrect`'s own doc comment (kana-input.ts) for why kana
   *  mode can't rely on `applyCharVerdict`'s default `key === expectedChar`
   *  comparison. Undefined for every non-kana annotation (romaji/verbatim
   *  runs, and every registration-only annotation — only `noteCharContext`
   *  ever sets this), in which case `applyCharVerdict` falls through to
   *  its default comparison exactly as before this field existed. */
  correctOverride: boolean | undefined
}

/** Bound on how many char-producing keystrokes may sit unconfirmed in
 *  EITHER direction at once — see the module doc comment's
 *  char-correlation note, mitigation 2. Shared by `awaitingChar` (presses
 *  awaiting their char) and `pendingChars` (chars awaiting their press). */
export const MAX_PENDING_CHAR_CONFIRMATIONS = 3

/** Bound on how many `matrix-release` events may sit parked awaiting
 *  their own press to register — see `recordMatrixRelease`'s doc
 *  comment. Deliberately small: this only ever holds entries for a
 *  release that arrived before its own (still-queued, tap-hold-deferred)
 *  press, an already-rare ordering, doubly so to still be unresolved
 *  after a handful more keys. */
export const MAX_PARKED_RELEASES = 4

/** A `matrix-release` that arrived before its own press had registered —
 *  see `recordMatrixRelease`. Keyed the same way as `openPresses`
 *  (row/col/keycode, not a timestamp) since that's all a release event
 *  itself carries to identify which physical key it belongs to. */
interface ParkedRelease {
  row: number
  col: number
  keycode: number
  durationMs: number
}

/** A 'char' event that arrived before its own press had registered — see
 *  the module doc comment's char-correlation note. `wordIndex`/
 *  `expectedChar` come from `noteCharContext`'s pre-advance annotation
 *  when one was captured for this exact char (the normal case for a
 *  properly-wired caller); `wordIndex: null` means no annotation was
 *  available, so `recordMatrixPress` falls back to the eventually-
 *  registering press's OWN registration-time snapshot instead of
 *  overriding it — the same behavior this module had before
 *  `noteCharContext` existed. */
interface PendingChar {
  key: string
  wordIndex: number | null
  expectedChar: string | undefined
  /** Mirrors `RegistrationAnnotation.mistakeKey` — see that field's own
   *  doc comment. `wordIndex: null` (no annotation captured) implies this
   *  is `undefined` too, same as `expectedChar`. */
  mistakeKey: string | undefined
  /** Mirrors `RegistrationAnnotation.correctOverride` — see that field's
   *  own doc comment. */
  correctOverride: boolean | undefined
}

export interface RunLogBuffer {
  runId: string
  registrations: Map<string, RegistrationAnnotation>
  openPresses: Map<string, BufferedKeystroke>
  /** FIFO, oldest first — see `MAX_PARKED_RELEASES`. A plain array
   *  (not keyed by row/col/keycode) so a same-key re-press's own release
   *  is matched in arrival order rather than risking a later parked
   *  release for the SAME key overwriting an earlier still-unclaimed one
   *  in a keyed map. */
  parkedReleases: ParkedRelease[]
  awaitingChar: BufferedKeystroke[]
  /** FIFO, oldest first — see the module doc comment's char-correlation
   *  note. */
  pendingChars: PendingChar[]
  /** Every buffered keystroke this run, in registration/arrival order,
   *  each carrying its own current word attribution — see
   *  `BufferedKeystroke.wordIndex`. `finish()` groups this back into
   *  each `RunWord` by that field. */
  keystrokes: BufferedKeystroke[]
  eventCount: number
  byteEstimate: number
  /** Set once a cap is crossed. `finish()` refuses (returns null) rather
   *  than save a silently-truncated log — checked once here instead of
   *  re-deriving it from `eventCount`/`byteEstimate` at finish time. */
  exceeded: boolean
}

export function registrationKey(row: number, col: number, ts: number): string {
  return `${row},${col},${ts}`
}

export function pressKey(row: number, col: number, keycode: number): string {
  return `${row},${col},${keycode}`
}

/** Rough per-keystroke byte estimate for the running total against
 *  `MAX_RUN_LOG_BYTES` (defined in `src/shared/types/typing-run-log.ts`)
 *  — doesn't need to be exact, only a cheap, monotonic proxy for the
 *  final serialized size. A flat constant (the fields
 *  other than `expectedChar`/`typedChar`/`mistakeKey` vary little in
 *  width) plus the fields whose length actually varies, rather than
 *  paying for a real `JSON.stringify` on every keystroke just to measure
 *  it. `typedChar`/`mistakeKey` are candidate values at push time (not
 *  yet cleared by `applyCharVerdict` for a correct keystroke — see that
 *  method's own doc comment), so this can transiently overcount before
 *  the verdict lands; harmless for a monotonic cap estimate. */
export function approxByteSize(k: BufferedKeystroke): number {
  // `mistakeKeyCandidate` approximates BOTH `mistakeKey` and `typedChar`'s
  // eventual contribution once `applyCharVerdict` promotes them —
  // `typedChar` is virtually always a single character, so folding its
  // width into this same term rather than tracking it separately stays a
  // safe overestimate, not an undercount.
  return 110 + (k.expectedChar?.length ?? 0) + (k.mistakeKeyCandidate?.length ?? 0)
}
