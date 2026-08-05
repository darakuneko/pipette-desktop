// SPDX-License-Identifier: GPL-2.0-or-later

/** In-memory buffer + join logic for the per-run raw keystroke log (see
 *  `.claude/tasks/backlog/Task-tm-phase5-run-keystroke-log.md`). Owned by
 *  `useInputModes` (one instance per editor session) and fed from three
 *  seams already wired for the existing per-minute analytics pipeline:
 *
 *  - `noteRegistration` — called from `useTypingTest.processMatrixFrame`
 *    at matrix-press REGISTRATION time (before the press may sit in the
 *    tap-hold ordering queue for up to TAPPING_TERM). Snapshots the word
 *    this press should confirm, keyed by the exact (row, col, ts) triple
 *    the eventual 'matrix' analytics event will carry — so a press that
 *    resolves late still joins back to the word it was actually typed
 *    against, not whatever word is current by the time it resolves.
 *  - `noteCharContext` — called from `useTypingTest.processKeyEvent`
 *    immediately BEFORE this same key's own char analytics emit, which is
 *    itself the FIRST place this run's state gets touched for this key
 *    (unlike a matrix press, whose registration always runs before its
 *    own possibly-deferred emit but AFTER this handler already advanced
 *    state for the same physical press — see the CHAR CORRELATION note
 *    below). Stashes the pre-advance word/expectedChar in a single slot
 *    (`pendingCharAnnotation`) for `record`'s 'char' branch, called
 *    synchronously right after, to consume.
 *  - `record` — called from `useInputModes`'s `emitAnalyticsEvent` sink,
 *    the same place every per-minute analytics event ships from. Builds
 *    keystrokes from 'matrix'/'matrix-release' events and best-effort
 *    confirms them against 'char' events (see the char-correlation note
 *    below).
 *
 *  PRIVACY: `record` only ever touches the buffer while
 *  `context.typingTestLabel` is set (an editor Typing Test run, not
 *  ambient REC input) AND `context.consentAccepted` is true AND
 *  `context.windowFocused` is true AND the event's runId matches the
 *  buffer's own — see the module doc comment on
 *  `../../shared/types/typing-run-log.ts` for the full privacy
 *  rationale. The window-focus check is checked independently here (not
 *  only trusted from the caller) as defense in depth on top of
 *  useTypingTest's own primary gate (it never even calls
 *  `noteRegistration`/`noteCharContext` while unfocused): HID matrix
 *  polling keeps running regardless of window focus — that's deliberate
 *  for the per-minute analytics pipeline — so without this gate a
 *  keystroke typed into an entirely different, unfocused application on
 *  the same keyboard would otherwise be captured verbatim. A run's buffer
 *  is memory-only until `finish()`; nothing is written to disk while a
 *  run is in progress.
 *
 *  CHAR CORRELATION (best-effort, not exact): a 'char' DOM keydown event
 *  carries no row/col, so it can't be joined to its matrix keystroke by
 *  position — only by relative arrival order. The REAL, usual ordering
 *  is char-before-matrix: a DOM keydown fires synchronously, while the
 *  matching 'matrix' analytics event arrives via ~20ms HID polling (and
 *  can be deferred further still, up to TAPPING_TERM, for a masked
 *  tap-hold key awaiting its tap/hold classification) — so a char
 *  USUALLY arrives before its own matrix press, not after. Pairing is
 *  therefore symmetric: two small bounded FIFOs, not one.
 *   - `awaitingChar` — char-producing presses that registered before
 *     their own char event arrived (the less common ordering, e.g. a
 *     tap-hold key deferred past its own char).
 *   - `pendingChars` — char events that arrived before their own press
 *     had registered (the usual ordering). `recordMatrixPress` checks
 *     this queue first and applies the verdict immediately; only when
 *     empty does the press fall back to waiting in `awaitingChar`.
 *  Two mitigations keep both queues bounded rather than exhaustive:
 *   1. Only keystrokes classified as char-producing (`producesChar`,
 *      and never a masked key resolved as `hold`) ever touch either
 *      queue — a bare modifier or a hold action would otherwise jam
 *      `awaitingChar` forever waiting for a 'char' event that will
 *      never come.
 *   2. Each queue is capped at a handful of pending entries (oldest
 *      evicted first), so one stretch of uncorrelatable input (e.g. IME
 *      composition — see `charCorrelationUnavailable`) can only desync a
 *      few keystrokes immediately following it before both queues
 *      self-heal, not the rest of the run.
 *  Backspace produces a 'char' event but confirms nothing — its
 *  keystroke is still consumed from whichever queue it lands in (so the
 *  alignment stays correct for what follows) without ever setting a
 *  correctness verdict; symmetric in both directions, see
 *  `recordChar`/`recordMatrixPress`.
 *
 *  ASYMMETRIC STALENESS (why `record` may let a 'char' payload mint/
 *  advance the buffer but never a 'matrix' one): a matrix analytics event
 *  can physically arrive up to TAPPING_TERM after the press that produced
 *  it (queued behind an unresolved tap-hold classification — see
 *  useTypingTest.ts's own comment on the ordering queue), so letting it
 *  advance the buffer here risked resurrecting an already-abandoned run
 *  with a stale, unrelated press. A 'char' DOM event has no such
 *  ordering queue — it is dispatched synchronously at keydown and reaches
 *  `record` immediately, so it can never be stale in that sense. Without
 *  this asymmetry a fresh run's very first keystroke was lost outright
 *  whenever its char arrived (the usual ordering) before ANY buffer
 *  existed: `record` refused to touch an absent buffer, `noteRegistration`
 *  (matrix-only) hadn't run yet either, so the char had nowhere to go —
 *  the following press then had to wait in `awaitingChar` for a char that
 *  would never come, permanently shifting every later confirmation by
 *  one. Only `noteRegistration` and a live 'char' payload may mint/
 *  advance the buffer now; `record`'s 'matrix'/'matrix-release' branches
 *  keep the original drop-on-absent/mismatch behavior. */

import type { TypingAnalyticsEventPayload } from '../../shared/types/typing-analytics'
import type { RunKeystroke, RunKeystrokeLog, RunWord } from '../../shared/types/typing-run-log'
import { MAX_RUN_LOG_BYTES, MAX_RUN_LOG_EVENTS } from '../../shared/types/typing-run-log'
import { producesChar } from './keycode-char-map'
import type { WordResult } from './run-state'
import { qualifyingHoldMs } from './keystroke-hold'

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
   *  convention as this module's other optional fields; an explicit `[]`
   *  is preserved as-is (see that field's own doc comment for why it
   *  must not collapse to omitted). */
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
interface BufferedKeystroke extends RunKeystroke {
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

interface RegistrationAnnotation {
  wordIndex: number
  expectedChar: string | undefined
  /** Candidate mistake-map key (see `RunKeystroke.mistakeKey`'s own doc
   *  comment), threaded alongside `expectedChar` from the same
   *  registration/char-context snapshot. Only ever SURVIVES onto the
   *  persisted keystroke when `applyCharVerdict` later finds `correct ===
   *  false` for it — kept here unconditionally (same as `expectedChar`)
   *  since the verdict isn't known yet at snapshot time. */
  mistakeKey: string | undefined
}

/** Bound on how many char-producing keystrokes may sit unconfirmed in
 *  EITHER direction at once — see the module doc comment's
 *  char-correlation note, mitigation 2. Shared by `awaitingChar` (presses
 *  awaiting their char) and `pendingChars` (chars awaiting their press). */
const MAX_PENDING_CHAR_CONFIRMATIONS = 3

/** Bound on how many `matrix-release` events may sit parked awaiting
 *  their own press to register — see `recordMatrixRelease`'s doc
 *  comment. Deliberately small: this only ever holds entries for a
 *  release that arrived before its own (still-queued, tap-hold-deferred)
 *  press, an already-rare ordering, doubly so to still be unresolved
 *  after a handful more keys. */
const MAX_PARKED_RELEASES = 4

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
}

interface RunLogBuffer {
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

function registrationKey(row: number, col: number, ts: number): string {
  return `${row},${col},${ts}`
}

function pressKey(row: number, col: number, keycode: number): string {
  return `${row},${col},${keycode}`
}

/** Rough per-keystroke byte estimate for the {@link MAX_RUN_LOG_BYTES}
 *  running total — doesn't need to be exact, only a cheap, monotonic
 *  proxy for the final serialized size. A flat constant (the fields
 *  other than `expectedChar`/`typedChar`/`mistakeKey` vary little in
 *  width) plus the fields whose length actually varies, rather than
 *  paying for a real `JSON.stringify` on every keystroke just to measure
 *  it. `typedChar`/`mistakeKey` are candidate values at push time (not
 *  yet cleared by `applyCharVerdict` for a correct keystroke — see that
 *  method's own doc comment), so this can transiently overcount before
 *  the verdict lands; harmless for a monotonic cap estimate. */
function approxByteSize(k: BufferedKeystroke): number {
  // `mistakeKeyCandidate` approximates BOTH `mistakeKey` and `typedChar`'s
  // eventual contribution once `applyCharVerdict` promotes them —
  // `typedChar` is virtually always a single character, so folding its
  // width into this same term rather than tracking it separately stays a
  // safe overestimate, not an undercount.
  return 110 + (k.expectedChar?.length ?? 0) + (k.mistakeKeyCandidate?.length ?? 0)
}

export class RunLogRecorder {
  private buffer: RunLogBuffer | null = null
  /** Set by `discardRun()` (the pause path) to the paused run's own id —
   *  blocks `noteRegistration`/`noteCharContext`/`record` from
   *  re-buffering THAT SPECIFIC run again, even though it keeps the same
   *  runId across resume (see `discardRun`'s own doc comment). A plain
   *  `discard()` (consent revoked, keyboard switch, unmount) does not set
   *  this: those cases have no notion of "the same run continuing under a
   *  still-valid runId" the way pause/resume does. */
  private poisonedRunId: string | null = null
  /** Single-slot pre-advance annotation captured by `noteCharContext` for
   *  the NEXT 'char' payload `record` sees — see `noteCharContext`'s own
   *  doc comment for why one slot (not a queue) suffices. Cleared
   *  whenever the buffer is replaced by `noteRegistration` or discarded,
   *  so a leftover annotation from a superseded run can never leak onto
   *  an unrelated keystroke; NOT cleared by `record`'s own char-mint
   *  path (see its doc comment), since that path's very next statement
   *  is what consumes it for this same keystroke. */
  private pendingCharAnnotation: RegistrationAnnotation | null = null

  private newBuffer(runId: string): RunLogBuffer {
    return {
      runId,
      registrations: new Map(),
      openPresses: new Map(),
      parkedReleases: [],
      awaitingChar: [],
      pendingChars: [],
      keystrokes: [],
      eventCount: 0,
      byteEstimate: 0,
      exceeded: false,
    }
  }

  /** Snapshot a matrix press's word attribution at REGISTRATION time
   *  (see the module doc comment). `context` mirrors {@link
   *  RunLogRecordContext}'s own gate — checked here too (not only
   *  trusted from the caller, i.e. `useInputModes`'s wrapper) so this
   *  privacy-critical module can never buffer anything on its own,
   *  regardless of call-site discipline. `getExpectedChar` is a thunk
   *  rather than an already-computed value so a caller gated off (no
   *  label, no consent, or a stale `runId`) never pays for deriving
   *  it — the gate below runs BEFORE the thunk is ever invoked.
   *
   *  Unconditionally switches to a fresh buffer when `context.runId`
   *  differs from whatever is currently buffered — this is what actually
   *  advances the recorder to a new run (restart / setConfig /
   *  setLanguage). Safe to do unconditionally here specifically because
   *  a matrix press is registered synchronously at press time, never
   *  delayed — unlike `record`'s 'matrix'/'matrix-release' branches,
   *  which can see a masked key's event land up to TAPPING_TERM after the
   *  press that produced it and must not let a stale one un-discard an
   *  abandoned run this way (see the module doc comment's ASYMMETRIC
   *  STALENESS note; a 'char' payload is the one other exception). */
  noteRegistration(
    context: RunLogRecordContext, row: number, col: number, ts: number, wordIndex: number,
    getExpectedChar: () => string | undefined,
    getMistakeKey?: () => string | undefined,
  ): void {
    if (!context.typingTestLabel) return
    if (!context.consentAccepted) return
    if (!context.windowFocused) return
    if (!context.runId) return
    if (context.runId === this.poisonedRunId) return
    const runId = context.runId
    if (!this.buffer || this.buffer.runId !== runId) {
      this.buffer = this.newBuffer(runId)
      // A leftover annotation from whatever run was buffered before this
      // must never leak onto an unrelated keystroke in the new one — see
      // this field's own doc comment.
      this.pendingCharAnnotation = null
    }
    this.buffer.registrations.set(
      registrationKey(row, col, ts),
      { wordIndex, expectedChar: getExpectedChar(), mistakeKey: getMistakeKey?.() },
    )
  }

  /** Snapshot a char-producing keystroke's word attribution immediately
   *  BEFORE this same key's own run-state update (see
   *  `useTypingTest.processKeyEvent`'s call site) — the DOM 'char' event
   *  is synchronous and never deferred (see the module doc comment's
   *  ASYMMETRIC STALENESS note), so unlike `noteRegistration` (which runs
   *  at HID-poll time, always AFTER this handler already advanced state
   *  for the same physical press) this is the FIRST place this run's
   *  state is read for this key at all — the resulting annotation is
   *  therefore the more accurate of the two when both exist for the same
   *  keystroke. `context` mirrors {@link RunLogRecordContext}'s own gate,
   *  checked here too for the same reason as `noteRegistration`.
   *
   *  Stores the result in {@link pendingCharAnnotation} for `record`'s
   *  'char' branch — called synchronously right after, in the same call
   *  stack (see `processKeyEvent`) — to consume; nothing else can run in
   *  between to observe or clobber it. Never mints/advances the buffer
   *  itself (that happens in `record`, see its own doc comment) — this
   *  method only ever writes the slot. */
  noteCharContext(
    context: RunLogRecordContext, wordIndex: number, expectedChar: string | undefined,
    mistakeKey?: string | undefined,
  ): void {
    if (!context.typingTestLabel) return
    if (!context.consentAccepted) return
    if (!context.windowFocused) return
    if (!context.runId) return
    if (context.runId === this.poisonedRunId) return
    this.pendingCharAnnotation = { wordIndex, expectedChar, mistakeKey }
  }

  /** Record one analytics event already destined for the per-minute
   *  pipeline — this module's own gate (see {@link RunLogRecordContext})
   *  decides independently whether it also belongs in a run log. */
  record(context: RunLogRecordContext, payload: TypingAnalyticsEventPayload): void {
    if (!context.typingTestLabel) return
    if (!context.consentAccepted) return
    if (!context.windowFocused) return
    if (!context.runId) return
    if (context.runId === this.poisonedRunId) return
    if (!this.buffer || this.buffer.runId !== context.runId) {
      // A 'char' payload may mint/advance the buffer here — see the
      // module doc comment's ASYMMETRIC STALENESS note for why this is
      // safe for 'char' specifically (never stale, unlike 'matrix'/
      // 'matrix-release', which keep the original drop-on-absent/
      // mismatch behavior below): only `noteRegistration` or a live
      // 'char' payload may advance the buffer to a new run.
      if (payload.kind !== 'char') return
      this.buffer = this.newBuffer(context.runId)
    }
    const buf = this.buffer
    if (buf.exceeded) return
    switch (payload.kind) {
      case 'matrix':
        this.recordMatrixPress(buf, payload)
        break
      case 'matrix-release':
        this.recordMatrixRelease(buf, payload)
        break
      case 'char':
        this.recordChar(buf, payload)
        break
    }
  }

  private pushKeystroke(buf: RunLogBuffer, keystroke: BufferedKeystroke): void {
    buf.eventCount++
    buf.byteEstimate += approxByteSize(keystroke)
    if (buf.eventCount > MAX_RUN_LOG_EVENTS || buf.byteEstimate > MAX_RUN_LOG_BYTES) {
      buf.exceeded = true
      return
    }
    buf.keystrokes.push(keystroke)
  }

  private recordMatrixPress(buf: RunLogBuffer, payload: Extract<TypingAnalyticsEventPayload, { kind: 'matrix' }>): void {
    const key = registrationKey(payload.row, payload.col, payload.ts)
    const reg = buf.registrations.get(key)
    buf.registrations.delete(key)
    // No annotation captured for this press (e.g. it registered before
    // gating turned on) — nothing to attribute it to, so drop it rather
    // than guess a word index.
    if (!reg) return

    const keystroke: BufferedKeystroke = {
      pressMs: payload.ts,
      keycode: payload.keycode,
      row: payload.row,
      col: payload.col,
      wordIndex: reg.wordIndex,
      expectedChar: reg.expectedChar,
      mistakeKeyCandidate: reg.mistakeKey,
      overlapped: payload.overlap,
    }
    this.pushKeystroke(buf, keystroke)
    if (buf.exceeded) return

    // A release for THIS key may have already arrived and parked (see
    // `recordMatrixRelease`) — 'matrix-release' bypasses the tap-hold
    // ordering queue and ships immediately, while this 'matrix' press
    // event can be the one still deferred. Claim the OLDEST parked
    // release for this exact key (FIFO — see `parkedReleases`'s own doc
    // comment for why a same-key re-press must not steal a different
    // press's parked duration) and resolve immediately instead of
    // waiting in `openPresses` for a release that already happened.
    const pk = pressKey(payload.row, payload.col, payload.keycode)
    const parkedIndex = buf.parkedReleases.findIndex(
      (p) => p.row === payload.row && p.col === payload.col && p.keycode === payload.keycode,
    )
    if (parkedIndex !== -1) {
      const [parked] = buf.parkedReleases.splice(parkedIndex, 1)
      keystroke.releaseMs = keystroke.pressMs + parked.durationMs
    } else {
      buf.openPresses.set(pk, keystroke)
    }

    // A masked key resolved as `hold` never commits a character (it's a
    // layer switch), so it must never enter char confirmation at all —
    // see the module doc comment's char-correlation note, mitigation 1.
    const mayProduceChar = payload.action !== 'hold' && producesChar(payload.keycode)
    if (mayProduceChar) {
      // Check `pendingChars` FIRST — the real, usual ordering (see the
      // module doc comment) is char-before-matrix, so the char this
      // press should confirm has very likely already arrived and is
      // waiting here, not the other way around.
      const pendingChar = buf.pendingChars.shift()
      if (pendingChar) {
        // Override the registration-time snapshot with the char's own
        // pre-advance annotation, when one was captured for it (see
        // `noteCharContext`) — it reflects this press's word more
        // accurately than the registration snapshot does (registration
        // runs AFTER this same press's char handler already advanced
        // state for it). `wordIndex: null` means no annotation was ever
        // captured (a caller that emits 'char' without `noteCharContext`
        // first) — keep the registration snapshot already on `keystroke`
        // rather than overriding with nothing, the same behavior this
        // module had before `noteCharContext` existed.
        if (pendingChar.wordIndex !== null) {
          keystroke.wordIndex = pendingChar.wordIndex
          keystroke.expectedChar = pendingChar.expectedChar
          keystroke.mistakeKeyCandidate = pendingChar.mistakeKey
        }
        this.applyCharVerdict(keystroke, pendingChar.key)
      } else {
        buf.awaitingChar.push(keystroke)
        // The single push above can grow the queue past the cap by at
        // most one, so a single shift (not a loop) suffices to restore it.
        if (buf.awaitingChar.length > MAX_PENDING_CHAR_CONFIRMATIONS) buf.awaitingChar.shift()
      }
    }
  }

  /** `recordMatrixRelease` bypasses the tap-hold ordering queue (see
   *  useTypingTest.ts's own comment on why release events ship straight
   *  through `emit`), while the matching 'matrix' PRESS event for a
   *  masked key can still be sitting in that queue awaiting its tap/hold
   *  classification — so a release can physically arrive here before
   *  `recordMatrixPress` has ever run for its own press. Parking it
   *  (rather than dropping it, which is what happened before this fix)
   *  lets `recordMatrixPress` claim it once the press finally registers,
   *  instead of the keystroke permanently reading as "still open" (no
   *  `releaseMs`) despite having actually been released. */
  private recordMatrixRelease(buf: RunLogBuffer, payload: Extract<TypingAnalyticsEventPayload, { kind: 'matrix-release' }>): void {
    const key = pressKey(payload.row, payload.col, payload.keycode)
    const press = buf.openPresses.get(key)
    if (press) {
      buf.openPresses.delete(key)
      press.releaseMs = press.pressMs + payload.durationMs
      return
    }
    buf.parkedReleases.push({ row: payload.row, col: payload.col, keycode: payload.keycode, durationMs: payload.durationMs })
    if (buf.parkedReleases.length > MAX_PARKED_RELEASES) buf.parkedReleases.shift()
  }

  /** Shared correctness-verdict logic between the two pairing directions
   *  (a char confirming an already-registered press in `recordChar`, or a
   *  press claiming an already-arrived char in `recordMatrixPress`) — see
   *  the module doc comment's char-correlation note. Backspace produces a
   *  'char' event (see the DOM gate in useTypingTest.processKeyEvent) but
   *  confirms nothing, in either direction — the keystroke it lands on is
   *  still consumed (to keep the surrounding queue aligned) just without
   *  a misleading correctness verdict. */
  /** Also decides whether `typedChar`/`mistakeKey` land on this keystroke
   *  at all — both start UNSET (see `mistakeKeyCandidate`'s own doc
   *  comment: the candidate lives in a separate field until promoted
   *  here), and are only ever written when the verdict actually lands on
   *  `correct === false` (see `RunKeystroke.typedChar`/`mistakeKey`'s own
   *  doc comments: set ONLY on an incorrect keystroke, never on a
   *  correct OR unjudged one — a keystroke this method is never called
   *  for at all, e.g. a bare modifier press, therefore correctly never
   *  gets either field either). */
  private applyCharVerdict(keystroke: BufferedKeystroke, key: string): void {
    if (key === 'Backspace') return
    if (keystroke.expectedChar !== undefined) {
      // expectedChar (deriveExpectedChar / romajiNextExpectedChar) is
      // always the canonical, unstyled character — romaji's own
      // remainingGuide()/nextGuideChar() are never case-styled
      // (applyRomajiCaseStyle only transforms the display-only guide
      // built in useTypingTest's romajiGuide memo, not the matcher
      // itself). `key` is the raw DOM key as physically typed, so a case
      // difference from Shift can make a physically-correct press
      // compare false here — a known, accepted limitation, not fixed by
      // this comparison.
      keystroke.correct = key === keystroke.expectedChar
    }
    if (keystroke.correct === false) {
      // `key` here is the actual DOM char produced by this press — the
      // same value just compared against expectedChar above, never a
      // keycode reverse-mapping (see `typedChar`'s own doc comment).
      keystroke.typedChar = key
      keystroke.mistakeKey = keystroke.mistakeKeyCandidate
    }
  }

  private recordChar(buf: RunLogBuffer, payload: Extract<TypingAnalyticsEventPayload, { kind: 'char' }>): void {
    // Consume the pre-advance annotation `noteCharContext` stashed for
    // THIS exact char, called synchronously right before this same
    // `record` call (see its own doc comment) — null when no such call
    // preceded this one.
    const annotation = this.pendingCharAnnotation
    this.pendingCharAnnotation = null

    const keystroke = buf.awaitingChar.shift()
    if (!keystroke) {
      // No press waiting to confirm — this is the REAL, usual ordering
      // (see the module doc comment): the char arrived first. Queue it
      // for the matching press to claim once IT registers, rather than
      // dropping it (which is what caused the permanent off-by-one this
      // queue exists to fix — pairing this char to whatever unrelated
      // press happens to come next).
      buf.pendingChars.push({
        key: payload.key, wordIndex: annotation?.wordIndex ?? null,
        expectedChar: annotation?.expectedChar, mistakeKey: annotation?.mistakeKey,
      })
      if (buf.pendingChars.length > MAX_PENDING_CHAR_CONFIRMATIONS) buf.pendingChars.shift()
      return
    }
    // Override the registration-time snapshot with the pre-advance
    // annotation, when one was captured — see `noteCharContext`'s doc
    // comment for why it is the more accurate of the two.
    if (annotation) {
      keystroke.wordIndex = annotation.wordIndex
      keystroke.expectedChar = annotation.expectedChar
      keystroke.mistakeKeyCandidate = annotation.mistakeKey
    }
    this.applyCharVerdict(keystroke, payload.key)
  }

  /** Discard the current run's buffer without saving anything. Call on
   *  consent revocation mid-run, unmount, or a keyboard switch/disconnect
   *  — cases where either recording is stopping for good or the
   *  identity of "what's being typed" is changing, so there's no
   *  expectation that more keystrokes for the SAME runId should still be
   *  recordable afterward. For the pause case specifically, see
   *  `discardRun()` instead. */
  discard(): void {
    this.buffer = null
    this.pendingCharAnnotation = null
  }

  /** Discard `runId`'s buffer AND block it from ever being re-buffered —
   *  unlike `discard()`, this survives across further `noteRegistration`/
   *  `noteCharContext`/`record` calls carrying the SAME runId, because
   *  that's exactly what a pause/resume does (the run keeps its id across
   *  the pause). Call on pause: resuming rebases
   *  `TypingTestState.startTime` to `Date.now() - elapsedMs`, so this
   *  run's raw timeline is already broken by the pause gap even once
   *  typing resumes — the summary result still saves normally, just not
   *  this run's raw log, for either its pre- or post-pause portion. A
   *  later, genuinely NEW runId (restart) is unaffected — it will never
   *  equal the poisoned id, so recording resumes normally for it without
   *  any further action here. */
  discardRun(runId: string): void {
    this.buffer = null
    this.poisonedRunId = runId
    this.pendingCharAnnotation = null
  }

  /** Converts one word's buffered keystrokes to the persisted,
   *  run-relative shape, dropping the buffer-only `wordIndex` field. A
   *  keystroke whose absolute `pressMs` precedes `startedAtMs` is
   *  DROPPED rather than clamped to 0 — belt-and-braces alongside the
   *  pause-time discard() this module's callers now do (see `finish()`'s
   *  own doc comment): clamping would misrepresent a keystroke as having
   *  happened at the exact instant the run started, silently corrupting
   *  the timeline instead of just omitting the one data point that can't
   *  be placed on it. `releaseMs` still gets a defensive `Math.max(0,
   *  ...)` even though it's normally >= the (now-guaranteed-non-negative)
   *  `pressMs` by construction. */
  private convertKeystrokes(keystrokes: readonly BufferedKeystroke[], startedAtMs: number): RunKeystroke[] {
    return keystrokes
      .filter((k) => k.pressMs - startedAtMs >= 0)
      .map((k) => ({
        pressMs: k.pressMs - startedAtMs,
        releaseMs: k.releaseMs !== undefined ? Math.max(0, k.releaseMs - startedAtMs) : undefined,
        keycode: k.keycode,
        row: k.row,
        col: k.col,
        expectedChar: k.expectedChar,
        correct: k.correct,
        overlapped: k.overlapped,
        typedChar: k.typedChar,
        mistakeKey: k.mistakeKey,
      }))
  }

  /** Read-only snapshot of `runId`'s currently-buffered average-key-hold
   *  raw pair — sums `releaseMs - pressMs` (still in absolute-epoch `Date.now()`
   *  form at this point; the difference is unaffected by the eventual
   *  run-relative conversion `finish()` performs) over every buffered
   *  keystroke with an observed, positive-duration release. Unlike
   *  `finish()`, does NOT clear the buffer: `useTypingTestResultSave`
   *  calls this BEFORE `finish()` because `buildTypingTestResult` (which
   *  needs this pair) runs first, and the run log is only finalized
   *  afterward — see that hook's own ordering note. Returns a zeroed pair
   *  (never null) for an unknown/mismatched runId — the natural "nothing
   *  was recorded" case (no buffer yet, consent off, view-only, or a
   *  fresh run already replaced the buffer), the same both-or-neither-
   *  friendly shape `buildTypingTestResult` already expects (zero
   *  `holdSamples` drops the pair, see its own doc comment).
   *
   *  Two rules mirror `finish()`/`convertKeystrokes` exactly, so this
   *  snapshot never disagrees with the log `finish()` goes on to save
   *  (the History value and the timeline it links to must agree):
   *   - `startedAtMs` (the same value the caller is about to pass as
   *     `RunLogFinishMeta.startedAtMs`) drops any keystroke pressed
   *     before the run's own start (e.g. a key held during armed-
   *     waiting) — same `pressMs - startedAtMs >= 0` bound
   *     `convertKeystrokes` applies.
   *   - A buffer already past {@link MAX_RUN_LOG_EVENTS}/{@link
   *     MAX_RUN_LOG_BYTES} (`exceeded`) returns a zeroed pair rather
   *     than partial pre-cap data — `finish()` refuses to save a
   *     silently-truncated log outright (see its own doc comment); a
   *     hold mean derived from that same truncated prefix must be
   *     refused the same way, not leak into the persisted result. */
  currentRunHoldStats(runId: string, startedAtMs: number): { holdSumMs: number; holdSamples: number } {
    if (!this.buffer || this.buffer.runId !== runId) return { holdSumMs: 0, holdSamples: 0 }
    if (this.buffer.exceeded) return { holdSumMs: 0, holdSamples: 0 }
    let holdSumMs = 0
    let holdSamples = 0
    for (const k of this.buffer.keystrokes) {
      if (k.pressMs - startedAtMs < 0) continue
      const holdMs = qualifyingHoldMs(k.pressMs, k.releaseMs)
      if (holdMs !== undefined) {
        holdSumMs += holdMs
        holdSamples++
      }
    }
    return { holdSumMs, holdSamples }
  }

  /** Finalize the current run's buffer into a saveable log, joining each
   *  buffered word's keystrokes against `wordResults` (display/typed/
   *  correct) and converting every timestamp to run-relative ms. Returns
   *  null (clearing the buffer either way) when there is nothing at all
   *  to save (no submitted words AND no in-flight word — see
   *  `meta.inFlightWord`), `meta.runId` doesn't match the buffer's own
   *  runId (a stale buffer left over from an abandoned run, never
   *  advanced past by `noteRegistration`/a 'char' payload before this
   *  call — see `RunLogFinishMeta.runId`'s own doc comment), or a cap was
   *  exceeded during recording — a silently-truncated log is never
   *  saved. */
  finish(wordResults: readonly WordResult[], meta: RunLogFinishMeta): RunKeystrokeLog | null {
    const buf = this.buffer
    this.buffer = null
    if (!buf) return null
    if (buf.runId !== meta.runId) return null
    if (buf.exceeded) return null
    if (wordResults.length === 0 && !meta.inFlightWord) return null

    // Group the flat, arrival-ordered buffer back into per-word lists
    // once here (rather than keeping a live per-word map throughout the
    // run) — see `BufferedKeystroke.wordIndex`'s own doc comment for why
    // attribution is a field write during recording, not a list move.
    // Grouping preserves each word's own arrival order since `keystrokes`
    // itself is append-only in registration/arrival order.
    const byWord = new Map<number, BufferedKeystroke[]>()
    for (const k of buf.keystrokes) {
      const list = byWord.get(k.wordIndex)
      if (list) list.push(k)
      else byWord.set(k.wordIndex, [k])
    }

    const words: RunWord[] = wordResults.map((wr, index) => ({
      index,
      display: wr.word,
      typed: wr.typed,
      correct: wr.correct,
      keystrokes: this.convertKeystrokes(byWord.get(index) ?? [], meta.startedAtMs),
    }))

    // The word the run ended on without submitting (e.g. a timed run
    // expiring mid-word) — its keystrokes were buffered under this same
    // index (see `noteRegistration`/`noteCharContext`) but would
    // otherwise never be attached to any RunWord, since `wordResults`
    // only ever contains SUBMITTED words. See `RunWord.partial`.
    if (meta.inFlightWord) {
      words.push({
        index: wordResults.length,
        display: meta.inFlightWord.display,
        typed: meta.inFlightWord.typed,
        correct: false,
        partial: true,
        keystrokes: this.convertKeystrokes(byWord.get(wordResults.length) ?? [], meta.startedAtMs),
      })
    }

    return {
      runId: buf.runId,
      uid: meta.uid,
      startedAt: new Date(meta.startedAtMs).toISOString(),
      durationMs: meta.durationMs,
      mode: meta.mode,
      language: meta.language,
      charCorrelationUnavailable: meta.charCorrelationUnavailable || undefined,
      romajiInput: meta.romajiInput || undefined,
      lineBreaks: meta.lineBreaks,
      words,
    }
  }
}
