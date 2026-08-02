// SPDX-License-Identifier: GPL-2.0-or-later

/** Public option/return shapes for useTypingTest. Split out from the host
 *  hook so its sub-hooks (matrix/metrics) and the facade itself can share
 *  them without importing the host module. Re-exported verbatim from
 *  useTypingTest.ts so no consumer import needs to change. */

import type { TypingTestConfig, RomajiGuide } from './types'
import type { TypingTestState } from './run-state'
import type { TypingTestMemory } from '../../shared/types/pipette-settings'
import type { TypingAnalyticsEventPayload } from '../../shared/types/typing-analytics'

export interface UseTypingTestOptions<TPreparedEvent = unknown> {
  /** Authorizes and tags a keystroke at the moment it is detected — before
   * it may sit in the ordering queue for up to TAPPING_TERM waiting on a
   * masked key ahead of it to resolve. `kind` distinguishes a matrix press
   * from a typed char so the caller can apply kind-specific bookkeeping
   * (e.g. the tray keystroke counter). Returns an opaque value that
   * useTypingTest never inspects — it only carries it alongside the queued
   * item to {@link onEmitAnalyticsEvent} — or null/undefined to drop the
   * press: it is then never queued or emitted, so a later state change
   * cannot retroactively authorize it. Called once per accepted keystroke,
   * never re-invoked for the same press. `windowFocused` is this hook's own
   * live focus state at the moment of the call (always true for 'char' —
   * processKeyEvent already refuses to run at all while unfocused) — the
   * caller carries it into its own opaque `TPreparedEvent` so a
   * consumer gated on focus (see run-log-recorder.ts's PRIVACY note) can
   * apply the press-time value rather than whatever focus is by the time
   * the event actually ships. */
  onPrepareAnalyticsEvent?: (kind: 'matrix' | 'char', windowFocused: boolean) => TPreparedEvent | null | undefined
  /** Ships an event that {@link onPrepareAnalyticsEvent} already authorized
   * and tagged for this exact press. Called either immediately (empty
   * queue) or once the item reaches the front of the ordering queue —
   * must not re-read whatever live state produced `prepared`, since that
   * state may have changed while the item was queued. */
  onEmitAnalyticsEvent?: (prepared: TPreparedEvent, event: TypingAnalyticsEventPayload) => void
  /** Notifies the run-keystroke-log recorder (owned by the caller, e.g.
   * useInputModes) of a matrix press at REGISTRATION time, so a later
   * (possibly TAPPING_TERM-delayed) analytics event can still be joined
   * back to the word it was actually typed against. See
   * run-log-recorder.ts's `noteRegistration`. `getExpectedChar` is a
   * thunk (not an already-computed value) so its — possibly expensive,
   * for romaji — derivation is free whenever the recorder is gated off;
   * the recorder invokes it only once it has confirmed recording is
   * actually active. Only ever called while `windowFocused` (this
   * hook's own live focus state) is true — see the call site in
   * `processMatrixFrame` — so `windowFocused` is always `true` here too;
   * threaded through anyway so the recorder's own gate (defense in
   * depth, see run-log-recorder.ts's PRIVACY note) doesn't have to
   * assume the caller's discipline. */
  onNoteKeystrokeRegistration?: (
    runId: string, row: number, col: number, ts: number, wordIndex: number,
    getExpectedChar: () => string | undefined, windowFocused: boolean,
  ) => void
  /** Notifies the run-keystroke-log recorder of a char-producing
   * keystroke's word attribution, snapshotted immediately BEFORE this
   * same key's own run-state update — unlike a matrix press (registered
   * at HID-poll time, always AFTER its own handler already advanced
   * state for the same physical press), a DOM char event's own emit
   * below IS that state's first touch for this key, so this call must
   * run first, not merely before the emit. See run-log-recorder.ts's
   * `noteCharContext`. `getExpectedChar` is a thunk for the same reason
   * as `onNoteKeystrokeRegistration`'s. Only ever called while
   * `windowFocused` is true, same as `onNoteKeystrokeRegistration`. */
  onNoteCharContext?: (
    runId: string, wordIndex: number, getExpectedChar: () => string | undefined, windowFocused: boolean,
  ) => void
  /** TAPPING_TERM (ms) used to classify masked-key presses as tap vs
   * hold against a deadline fixed at press time (pressTs + this value,
   * captured then — not re-read at release/deadline, so a setting change
   * mid-press doesn't retroactively reclassify it). Defaults to QMK's
   * 200 ms; the KeymapEditor passes the live value pulled from the
   * keyboard's QMK settings when available. */
  tappingTermMs?: number
}

export interface UseTypingTestReturn {
  state: TypingTestState
  wpm: number
  kpm: number
  accuracy: number
  /** Keystrokes per confirmed character (see `computeKspc` and
   *  `TypingTestState.confirmedChars`), live-updated the same way as
   *  wpm/kpm/accuracy. `null` while nothing is confirmed yet, or once an
   *  IME composition made the run's `totalKeystrokes` untrustworthy
   *  (`state.kspcUncomputable`). */
  kspc: number | null
  /** Current word's romaji progress (romajiInput mode only); null otherwise
   *  or once all words are done. */
  romajiGuide: RomajiGuide | null
  elapsedSeconds: number
  remainingSeconds: number | null
  config: TypingTestConfig
  language: string
  isLanguageLoading: boolean
  baseLayer: number
  effectiveLayer: number
  windowFocused: boolean
  processMatrixFrame: (pressed: ReadonlySet<string>, keymap: Map<string, number>) => void
  /** Returns a promise that resolves once every drained item's emit has
   * settled — see {@link MatrixAnalyticsQueue.drainAll}. A caller that
   * finalizes a session (record-off, test-finish) before requesting a
   * flush must await it; a caller that just wants edge-tracking reset
   * (e.g. a keymap change) can ignore the return value. */
  resetMatrixPressTracking: () => Promise<void>
  processKeyEvent: (key: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean) => void
  processCompositionStart: () => void
  processCompositionUpdate: (data: string) => void
  processCompositionEnd: (data: string) => void
  restart: () => void
  restartWithCountdown: () => void
  setConfig: (config: TypingTestConfig) => void
  setLanguage: (language: string) => Promise<string>
  setBaseLayer: (layer: number) => void
  setWindowFocused: (focused: boolean) => void
  captureMemory: () => TypingTestMemory | null
  pause: () => void
  restoreState: (memory: TypingTestMemory, resume: boolean) => Promise<boolean>
}
