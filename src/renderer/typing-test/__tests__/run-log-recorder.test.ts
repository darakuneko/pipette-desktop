// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { RunLogRecorder, type RunLogRecordContext, type RunLogFinishMeta } from '../run-log-recorder'
import type { TypingAnalyticsEventPayload } from '../../../shared/types/typing-analytics'
import { MAX_RUN_LOG_EVENTS } from '../../../shared/types/typing-run-log'
import type { WordResult } from '../run-state'
import { deserialize } from '../../../shared/keycodes/keycodes'

const KC_A = deserialize('KC_A')
const KC_B = deserialize('KC_B')
const KC_C = deserialize('KC_C')
const KC_LSFT = deserialize('KC_LSFT')

const DEFAULT_LABEL = 'words (english)'

/** Registers a press the same way the (gated) useInputModes wrapper
 *  does — `typingTestLabel`/`consentAccepted`/`windowFocused` default to
 *  "a real, gated test run" so most call sites below don't have to spell
 *  them out; tests of the gate itself override them explicitly. */
function register(
  recorder: RunLogRecorder, runId: string, row: number, col: number, ts: number, wordIndex: number,
  expectedChar: string | undefined,
  gate?: { typingTestLabel?: string | null; consentAccepted?: boolean; windowFocused?: boolean },
): void {
  recorder.noteRegistration(
    {
      typingTestLabel: gate?.typingTestLabel !== undefined ? gate.typingTestLabel : DEFAULT_LABEL,
      runId,
      consentAccepted: gate?.consentAccepted ?? true,
      windowFocused: gate?.windowFocused ?? true,
    },
    row, col, ts, wordIndex, () => expectedChar,
  )
}

/** Captures a char's pre-advance annotation the same way
 *  useTypingTest.processKeyEvent's real call site does, immediately
 *  before the matching `record(ctx(), charEvent(...))` call — see
 *  `noteCharContext`'s own doc comment. Same gate defaults as
 *  `register`. */
function noteChar(
  recorder: RunLogRecorder, runId: string, wordIndex: number, expectedChar: string | undefined,
  gate?: { typingTestLabel?: string | null; consentAccepted?: boolean; windowFocused?: boolean },
): void {
  recorder.noteCharContext(
    {
      typingTestLabel: gate?.typingTestLabel !== undefined ? gate.typingTestLabel : DEFAULT_LABEL,
      runId,
      consentAccepted: gate?.consentAccepted ?? true,
      windowFocused: gate?.windowFocused ?? true,
    },
    wordIndex, expectedChar,
  )
}

function ctx(overrides?: Partial<RunLogRecordContext>): RunLogRecordContext {
  return { typingTestLabel: DEFAULT_LABEL, runId: 'run-1', consentAccepted: true, windowFocused: true, ...overrides }
}

function matrixPress(overrides?: Partial<Extract<TypingAnalyticsEventPayload, { kind: 'matrix' }>>): Extract<TypingAnalyticsEventPayload, { kind: 'matrix' }> {
  return { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: KC_A, ts: 1000, ...overrides }
}

function matrixRelease(overrides?: Partial<Extract<TypingAnalyticsEventPayload, { kind: 'matrix-release' }>>): Extract<TypingAnalyticsEventPayload, { kind: 'matrix-release' }> {
  return { kind: 'matrix-release', row: 0, col: 0, layer: 0, keycode: KC_A, ts: 1050, durationMs: 50, ...overrides }
}

function charEvent(key: string, ts = 1010): Extract<TypingAnalyticsEventPayload, { kind: 'char' }> {
  return { kind: 'char', key, ts }
}

function finishMeta(overrides?: Partial<RunLogFinishMeta>): RunLogFinishMeta {
  return {
    uid: 'kb-1', runId: 'run-1', startedAtMs: 1000, durationMs: 5000, mode: 'words', language: 'english',
    charCorrelationUnavailable: false, ...overrides,
  }
}

function oneWordResult(typed = 'a', correct = true): WordResult[] {
  return [{ word: 'a', typed, correct }]
}

describe('RunLogRecorder', () => {
  describe('the mandatory privacy invariant', () => {
    it('never buffers or finishes anything for pure REC input (typingTestLabel null)', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a', { typingTestLabel: null })
      recorder.record(ctx({ typingTestLabel: null }), matrixPress())
      recorder.record(ctx({ typingTestLabel: null }), charEvent('a'))
      recorder.record(ctx({ typingTestLabel: null }), matrixRelease())

      expect(recorder.finish(oneWordResult(), finishMeta())).toBeNull()
    })

    it('records nothing without recording consent, even during a tagged test run', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a', { consentAccepted: false })
      recorder.record(ctx({ consentAccepted: false }), matrixPress())
      recorder.record(ctx({ consentAccepted: false }), charEvent('a'))

      expect(recorder.finish(oneWordResult(), finishMeta())).toBeNull()
    })

    it('records nothing while the window is unfocused, even during a tagged, consented test run', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a', { windowFocused: false })
      recorder.record(ctx({ windowFocused: false }), matrixPress())
      recorder.record(ctx({ windowFocused: false }), charEvent('a'))

      expect(recorder.finish(oneWordResult(), finishMeta())).toBeNull()
    })

    it('resumes buffering once the window regains focus, without the earlier unfocused press leaking in', () => {
      const recorder = new RunLogRecorder()
      // Unfocused: alt-tabbed away, still typing on the same keyboard —
      // must not be attributed to the run log at all.
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a', { windowFocused: false })
      recorder.record(ctx({ windowFocused: false }), matrixPress({ ts: 1000 }))

      // Refocused: this press must be recorded normally.
      register(recorder, 'run-1', 0, 1, 1010, 0, 'b', { windowFocused: true })
      recorder.record(ctx({ windowFocused: true }), matrixPress({ row: 0, col: 1, ts: 1010, keycode: KC_B }))

      const log = recorder.finish(
        [{ word: 'ab', typed: 'ab', correct: true }],
        finishMeta({ startedAtMs: 1000 }),
      )
      expect(log?.words[0].keystrokes).toHaveLength(1)
      expect(log?.words[0].keystrokes[0].col).toBe(1)
    })
  })

  describe('restart / stale runId handling', () => {
    it('discards the previous run and starts fresh when noteRegistration sees a new runId', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-A', 0, 0, 1000, 0, 'a')
      recorder.record(ctx({ runId: 'run-A' }), matrixPress({ ts: 1000 }))

      // Restart: a new run id begins.
      register(recorder, 'run-B', 0, 0, 2000, 0, 'x')
      recorder.record(ctx({ runId: 'run-B' }), matrixPress({ row: 0, col: 0, ts: 2000 }))

      const log = recorder.finish([{ word: 'x', typed: 'x', correct: true }], finishMeta({ runId: 'run-B', startedAtMs: 2000 }))
      expect(log?.runId).toBe('run-B')
      expect(log?.words[0].keystrokes).toHaveLength(1)
      expect(log?.words[0].keystrokes[0].expectedChar).toBe('x')
    })

    it('drops a stale queued press carrying the old runId after a restart instead of resurrecting it', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-A', 0, 0, 1000, 0, 'a')
      // The old run's masked press is still queued (not yet emitted).

      // Restart advances the buffer to run-B via noteRegistration (always
      // real-time, never delayed).
      register(recorder, 'run-B', 0, 1, 2000, 0, 'x')
      recorder.record(ctx({ runId: 'run-B' }), matrixPress({ row: 0, col: 1, ts: 2000 }))

      // The OLD run's press finally resolves and emits — must be dropped,
      // not resurrect run-A's buffer.
      recorder.record(ctx({ runId: 'run-A' }), matrixPress({ row: 0, col: 0, ts: 1000 }))

      const log = recorder.finish([{ word: 'x', typed: 'x', correct: true }], finishMeta({ runId: 'run-B', startedAtMs: 2000 }))
      expect(log?.runId).toBe('run-B')
      expect(log?.words[0].keystrokes).toHaveLength(1)
      expect(log?.words[0].keystrokes[0].col).toBe(1)
    })
  })

  describe('finish() runId check (P2)', () => {
    it('refuses to finish (and clears the buffer) when meta.runId does not match the buffered run', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-A', 0, 0, 1000, 0, 'a')
      recorder.record(ctx({ runId: 'run-A' }), matrixPress({ ts: 1000 }))

      // Caller (e.g. a stale effect closure) asks to finish under a
      // DIFFERENT run's id than what's actually buffered.
      expect(recorder.finish(oneWordResult(), finishMeta({ runId: 'run-B', startedAtMs: 1000 }))).toBeNull()
      // The buffer is cleared either way (matching every other refusal
      // path) — a second finish() call under the CORRECT runId must not
      // resurrect it.
      expect(recorder.finish(oneWordResult(), finishMeta({ runId: 'run-A', startedAtMs: 1000 }))).toBeNull()
    })
  })

  describe('word attribution survives a delayed emission', () => {
    it('keeps the word index registered at press time even if the word advances before the event emits', () => {
      const recorder = new RunLogRecorder()
      // Registered while word 0 was current...
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      // ...but the analytics event for it only reaches record() after the
      // queue has already drained later presses belonging to word 1 (a
      // masked key deferred up to TAPPING_TERM, for example).
      register(recorder, 'run-1', 0, 1, 1005, 1, 'b')
      recorder.record(ctx(), matrixPress({ row: 0, col: 1, ts: 1005, keycode: KC_B }))
      recorder.record(ctx(), matrixPress({ row: 0, col: 0, ts: 1000, keycode: KC_A }))

      const log = recorder.finish(
        [{ word: 'a', typed: 'a', correct: true }, { word: 'b', typed: 'b', correct: true }],
        finishMeta({ startedAtMs: 1000 }),
      )
      expect(log?.words[0].keystrokes).toHaveLength(1)
      expect(log?.words[0].keystrokes[0].row).toBe(0)
      expect(log?.words[0].keystrokes[0].col).toBe(0)
      expect(log?.words[1].keystrokes).toHaveLength(1)
    })
  })

  describe('finish() output shape', () => {
    it('converts every timestamp to run-relative ms', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1500, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1500 }))
      recorder.record(ctx(), matrixRelease({ ts: 1580, durationMs: 80 }))

      const log = recorder.finish(oneWordResult(), finishMeta({ startedAtMs: 1000, durationMs: 5000 }))
      const [k] = log!.words[0].keystrokes
      expect(k.pressMs).toBe(500)
      expect(k.releaseMs).toBe(580)
      // Never looks like an epoch ms value, and never exceeds durationMs.
      expect(k.pressMs).toBeLessThanOrEqual(log!.durationMs)
      expect(k.releaseMs!).toBeLessThanOrEqual(log!.durationMs)
    })

    it('keeps a mid-hold keystroke with pressMs but no releaseMs', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1000 }))
      // No matching matrix-release — the run finished mid-hold.

      const log = recorder.finish(oneWordResult(), finishMeta({ startedAtMs: 1000 }))
      const [k] = log!.words[0].keystrokes
      expect(k.pressMs).toBe(0)
      expect(k.releaseMs).toBeUndefined()
    })

    it('preserves the overlapped tri-state (true / false / undefined)', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1000, overlap: undefined }))

      register(recorder, 'run-1', 0, 1, 1010, 0, 'b')
      recorder.record(ctx(), matrixPress({ row: 0, col: 1, ts: 1010, keycode: KC_B, overlap: true }))

      const log = recorder.finish(
        [{ word: 'ab', typed: 'ab', correct: true }],
        finishMeta({ startedAtMs: 1000 }),
      )
      const [first, second] = log!.words[0].keystrokes
      expect(first.overlapped).toBeUndefined()
      expect(second.overlapped).toBe(true)
    })

    it('sets charCorrelationUnavailable when the caller flags an IME-composition run', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress())

      const log = recorder.finish(oneWordResult(), finishMeta({ charCorrelationUnavailable: true }))
      expect(log?.charCorrelationUnavailable).toBe(true)
    })

    it('omits charCorrelationUnavailable (rather than storing false) for an ordinary run', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress())

      const log = recorder.finish(oneWordResult(), finishMeta({ charCorrelationUnavailable: false }))
      expect(log?.charCorrelationUnavailable).toBeUndefined()
    })

    it('drops (rather than clamps to 0) a keystroke whose relative pressMs would be negative (P3 belt-and-braces)', () => {
      const recorder = new RunLogRecorder()
      // A keystroke buffered before meta.startedAtMs — the shape a
      // pause/resume startTime rebase would produce if the recorder's
      // buffer were ever resurrected across a pause (it no longer is,
      // see pauseTypingTest's discard() call, but this guard stays as
      // defense in depth).
      register(recorder, 'run-1', 0, 0, 900, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 900 }))
      register(recorder, 'run-1', 0, 1, 1100, 0, 'b')
      recorder.record(ctx(), matrixPress({ row: 0, col: 1, ts: 1100, keycode: KC_B }))

      const log = recorder.finish(
        [{ word: 'ab', typed: 'ab', correct: true }],
        finishMeta({ startedAtMs: 1000 }),
      )
      // Only the keystroke at or after startedAtMs survives.
      expect(log?.words[0].keystrokes).toHaveLength(1)
      expect(log?.words[0].keystrokes[0].col).toBe(1)
      expect(log?.words[0].keystrokes[0].pressMs).toBe(100)
    })
  })

  describe('char correlation (best-effort)', () => {
    it('confirms correct=true when the char event arrives BEFORE its own matrix press (the real, usual ordering)', () => {
      // DOM keydown fires synchronously; the matching 'matrix' analytics
      // event arrives via ~20ms HID polling — so a char USUALLY precedes
      // its own matrix press, not the other way around. This is the
      // primary case (see the module doc comment's char-correlation
      // note) — it used to be mishandled as a permanent off-by-one
      // (every char confirmed the NEXT press instead of its own).
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), charEvent('a', 995))
      recorder.record(ctx(), matrixPress({ ts: 1000 }))

      const log = recorder.finish(oneWordResult(), finishMeta())
      expect(log?.words[0].keystrokes[0].correct).toBe(true)
    })

    it('confirms correct=false when the char event (arriving first) does not match expectedChar', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), charEvent('z', 995))
      recorder.record(ctx(), matrixPress({ ts: 1000 }))

      const log = recorder.finish(oneWordResult(), finishMeta())
      expect(log?.words[0].keystrokes[0].correct).toBe(false)
    })

    it('keeps multi-keystroke verdicts aligned when every char arrives before its own matrix press', () => {
      // 3 correct chars typed in sequence, each arriving ahead of its own
      // press (the normal timing) — every keystroke must end up aligned
      // to its OWN char, not shifted by one.
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      register(recorder, 'run-1', 0, 1, 1010, 0, 'b')
      register(recorder, 'run-1', 0, 2, 1020, 0, 'c')

      recorder.record(ctx(), charEvent('a', 995))
      recorder.record(ctx(), matrixPress({ ts: 1000, keycode: KC_A }))
      recorder.record(ctx(), charEvent('b', 1005))
      recorder.record(ctx(), matrixPress({ row: 0, col: 1, ts: 1010, keycode: KC_B }))
      recorder.record(ctx(), charEvent('c', 1015))
      recorder.record(ctx(), matrixPress({ row: 0, col: 2, ts: 1020, keycode: KC_C }))

      const log = recorder.finish(
        [{ word: 'abc', typed: 'abc', correct: true }],
        finishMeta({ startedAtMs: 1000 }),
      )
      const keystrokes = log!.words[0].keystrokes
      expect(keystrokes).toHaveLength(3)
      expect(keystrokes.every((k) => k.correct === true)).toBe(true)
    })

    it('confirms correct=true when the char event arrives AFTER its own matrix press (secondary/legacy ordering, e.g. a tap-hold key deferred past its own char)', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1000 }))
      recorder.record(ctx(), charEvent('a'))

      const log = recorder.finish(oneWordResult(), finishMeta())
      expect(log?.words[0].keystrokes[0].correct).toBe(true)
    })

    it('never enqueues a bare modifier press for char confirmation, so it stays unconfirmed', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, undefined)
      recorder.record(ctx(), matrixPress({ ts: 1000, keycode: KC_LSFT }))
      // The following real letter's char event must confirm ITS OWN
      // keystroke, not the shift's.
      register(recorder, 'run-1', 0, 1, 1010, 0, 'a')
      recorder.record(ctx(), matrixPress({ row: 0, col: 1, ts: 1010, keycode: KC_A }))
      recorder.record(ctx(), charEvent('a'))

      const log = recorder.finish(oneWordResult(), finishMeta())
      const [shiftKeystroke, letterKeystroke] = log!.words[0].keystrokes
      expect(shiftKeystroke.correct).toBeUndefined()
      expect(letterKeystroke.correct).toBe(true)
    })

    it('never enqueues a masked key resolved as hold for char confirmation', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      // action: 'hold' — a layer switch, never commits a character.
      recorder.record(ctx(), matrixPress({ ts: 1000, action: 'hold' }))
      recorder.record(ctx(), charEvent('a'))

      const log = recorder.finish(oneWordResult(), finishMeta())
      // The stray char event found nothing queued (the hold was never
      // enqueued) and was simply dropped.
      expect(log?.words[0].keystrokes[0].correct).toBeUndefined()
    })

    it('pops Backspace off the queue without setting a misleading correctness verdict (matrix-then-char)', () => {
      const recorder = new RunLogRecorder()
      const KC_BSPC = deserialize('KC_BSPC')
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1000, keycode: KC_BSPC }))
      recorder.record(ctx(), charEvent('Backspace'))

      register(recorder, 'run-1', 0, 1, 1010, 0, 'a')
      recorder.record(ctx(), matrixPress({ row: 0, col: 1, ts: 1010, keycode: KC_A }))
      recorder.record(ctx(), charEvent('a'))

      const log = recorder.finish(oneWordResult(), finishMeta())
      const [backspaceKeystroke, letterKeystroke] = log!.words[0].keystrokes
      expect(backspaceKeystroke.correct).toBeUndefined()
      expect(letterKeystroke.correct).toBe(true)
    })

    it('pops Backspace off the queue without a verdict when its char arrives BEFORE its own matrix press too (symmetric)', () => {
      const recorder = new RunLogRecorder()
      const KC_BSPC = deserialize('KC_BSPC')
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), charEvent('Backspace', 995))
      recorder.record(ctx(), matrixPress({ ts: 1000, keycode: KC_BSPC }))

      register(recorder, 'run-1', 0, 1, 1010, 0, 'a')
      recorder.record(ctx(), charEvent('a', 1005))
      recorder.record(ctx(), matrixPress({ row: 0, col: 1, ts: 1010, keycode: KC_A }))

      const log = recorder.finish(oneWordResult(), finishMeta())
      const [backspaceKeystroke, letterKeystroke] = log!.words[0].keystrokes
      expect(backspaceKeystroke.correct).toBeUndefined()
      expect(letterKeystroke.correct).toBe(true)
    })
  })

  describe('char-first pre-advance annotation (noteCharContext)', () => {
    it('fresh run: 3 keystrokes arriving char-first (the real ordering) are all correct, none shifted', () => {
      const recorder = new RunLogRecorder()
      // For each key, the char's own record() call reaches the recorder
      // BEFORE that key's matrix press has even registered (noteRegistration
      // fires later — mirroring the real ~20ms HID poll delay behind a
      // synchronous DOM keydown) — the first key's char must mint the
      // buffer with no registration and no buffer at all yet to lean on.
      noteChar(recorder, 'run-1', 0, 'a')
      recorder.record(ctx(), charEvent('a', 995))
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1000, keycode: KC_A }))

      noteChar(recorder, 'run-1', 0, 'b')
      recorder.record(ctx(), charEvent('b', 1005))
      register(recorder, 'run-1', 0, 1, 1010, 0, 'b')
      recorder.record(ctx(), matrixPress({ row: 0, col: 1, ts: 1010, keycode: KC_B }))

      noteChar(recorder, 'run-1', 0, 'c')
      recorder.record(ctx(), charEvent('c', 1015))
      register(recorder, 'run-1', 0, 2, 1020, 0, 'c')
      recorder.record(ctx(), matrixPress({ row: 0, col: 2, ts: 1020, keycode: KC_C }))

      const log = recorder.finish(
        [{ word: 'abc', typed: 'abc', correct: true }],
        finishMeta({ startedAtMs: 1000 }),
      )
      const keystrokes = log!.words[0].keystrokes
      expect(keystrokes).toHaveLength(3)
      expect(keystrokes.every((k) => k.correct === true)).toBe(true)
      expect(keystrokes.map((k) => k.col)).toEqual([0, 1, 2])
    })

    it('the first char of a run arriving before ANY matrix event is not lost (buffer minted by the char)', () => {
      const recorder = new RunLogRecorder()
      // No noteRegistration precedes this char at all — a totally fresh
      // recorder, with no buffer, told about run-1 only by the char.
      noteChar(recorder, 'run-1', 0, 'a')
      recorder.record(ctx(), charEvent('a', 995))
      // The press only registers (and then reaches record()) afterward.
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1000 }))

      const log = recorder.finish(oneWordResult(), finishMeta())
      expect(log?.words[0].keystrokes).toHaveLength(1)
      expect(log?.words[0].keystrokes[0].correct).toBe(true)
    })

    it('restart: a new run\'s char-first keystroke advances the buffer; a subsequent stale MATRIX press for the old run is still dropped (asymmetry pinned)', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-A', 0, 0, 1000, 0, 'a')
      // run-A's masked press is still queued (not yet emitted) when the
      // restart below happens.

      // Restart: run-B's first char arrives before any matrix
      // registration for it at all — only a 'char' payload may advance
      // the buffer to a new run (see run-log-recorder.ts's ASYMMETRIC
      // STALENESS note); a 'matrix' payload still may not.
      noteChar(recorder, 'run-B', 0, 'x')
      recorder.record(ctx({ runId: 'run-B' }), charEvent('x', 1995))
      register(recorder, 'run-B', 0, 0, 2000, 0, 'x')
      recorder.record(ctx({ runId: 'run-B' }), matrixPress({ ts: 2000 }))

      // run-A's stale press finally resolves and emits — must be
      // dropped, not resurrect run-A's buffer.
      recorder.record(ctx({ runId: 'run-A' }), matrixPress({ ts: 1000 }))

      const log = recorder.finish([{ word: 'x', typed: 'x', correct: true }], finishMeta({ runId: 'run-B', startedAtMs: 2000 }))
      expect(log?.runId).toBe('run-B')
      expect(log?.words[0].keystrokes).toHaveLength(1)
      expect(log?.words[0].keystrokes[0].correct).toBe(true)
    })

    it('a separator typed char-first at a word boundary is attributed to the word it terminated, not the next one', () => {
      const recorder = new RunLogRecorder()
      const KC_SPC = deserialize('KC_SPC')
      // The space's own annotation is captured while word 0 ("ab") is
      // still current — BEFORE the space handler advances
      // currentWordIndex to 1 — exactly mirroring processKeyEvent's real
      // call order (noteCharContext runs before the reducer).
      noteChar(recorder, 'run-1', 0, undefined)
      recorder.record(ctx(), charEvent(' ', 995))
      // The matching matrix press only registers AFTER state has already
      // advanced to word 1 (the real ordering this fix addresses) — if
      // attribution came from this registration snapshot instead of the
      // annotation, the space would land on word 1 instead of word 0.
      register(recorder, 'run-1', 0, 0, 1000, 1, undefined)
      recorder.record(ctx(), matrixPress({ ts: 1000, keycode: KC_SPC }))

      const log = recorder.finish(
        [{ word: 'ab', typed: 'ab', correct: true }, { word: 'cd', typed: 'cd', correct: true }],
        finishMeta({ startedAtMs: 1000 }),
      )
      expect(log?.words[0].keystrokes).toHaveLength(1)
      expect(log?.words[1].keystrokes).toHaveLength(0)
    })

    it('keeps verdicts and word attribution aligned when both orderings interleave across several keys', () => {
      const recorder = new RunLogRecorder()
      // key 1: char-first (the real ordering)
      noteChar(recorder, 'run-1', 0, 'a')
      recorder.record(ctx(), charEvent('a', 995))
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1000, keycode: KC_A }))

      // key 2: matrix-first (the secondary ordering)
      register(recorder, 'run-1', 0, 1, 1010, 0, 'b')
      recorder.record(ctx(), matrixPress({ row: 0, col: 1, ts: 1010, keycode: KC_B }))
      noteChar(recorder, 'run-1', 0, 'b')
      recorder.record(ctx(), charEvent('b', 1015))

      // key 3: char-first again
      noteChar(recorder, 'run-1', 0, 'c')
      recorder.record(ctx(), charEvent('c', 1018))
      register(recorder, 'run-1', 0, 2, 1020, 0, 'c')
      recorder.record(ctx(), matrixPress({ row: 0, col: 2, ts: 1020, keycode: KC_C }))

      const log = recorder.finish(
        [{ word: 'abc', typed: 'abc', correct: true }],
        finishMeta({ startedAtMs: 1000 }),
      )
      const keystrokes = log!.words[0].keystrokes
      expect(keystrokes).toHaveLength(3)
      expect(keystrokes.every((k) => k.correct === true)).toBe(true)
      expect(keystrokes.map((k) => k.col)).toEqual([0, 1, 2])
    })

    it('a poisoned runId also blocks a char event from minting a buffer', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1000 }))
      recorder.discardRun('run-1')

      noteChar(recorder, 'run-1', 0, 'x')
      recorder.record(ctx({ runId: 'run-1' }), charEvent('x'))

      expect(recorder.finish(oneWordResult(), finishMeta())).toBeNull()
    })
  })

  describe('release parking (D2 — a release arriving before its own queued press)', () => {
    it('recovers a release that arrives before its own deferred press event', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      // 'matrix-release' bypasses the tap-hold ordering queue and ships
      // immediately, landing before this press's own deferred 'matrix'
      // event (e.g. a masked key awaiting tap/hold classification).
      recorder.record(ctx(), matrixRelease({ ts: 1050, durationMs: 50 }))
      recorder.record(ctx(), matrixPress({ ts: 1000 }))

      const log = recorder.finish(oneWordResult(), finishMeta({ startedAtMs: 1000 }))
      const [k] = log!.words[0].keystrokes
      expect(k.pressMs).toBe(0)
      expect(k.releaseMs).toBe(50)
    })

    it('does not mis-assign a same-key re-press\'s release to an earlier still-unclaimed press for that key', () => {
      const recorder = new RunLogRecorder()
      // Press A (masked, deferred) — its release ships immediately.
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixRelease({ ts: 1030, durationMs: 30 }))
      // Press B (same physical key, re-pressed) is ALSO deferred — its
      // own release ships before either press event ever emits.
      register(recorder, 'run-1', 0, 0, 1200, 0, 'a')
      recorder.record(ctx(), matrixRelease({ ts: 1230, durationMs: 30 }))
      // A's deferred press event finally emits — must claim ITS OWN
      // parked release (the OLDEST one for this key), not B's.
      recorder.record(ctx(), matrixPress({ ts: 1000 }))
      // B's deferred press event finally emits — must claim its own.
      recorder.record(ctx(), matrixPress({ ts: 1200 }))

      const log = recorder.finish(oneWordResult(), finishMeta({ startedAtMs: 1000 }))
      const [a, b] = log!.words[0].keystrokes
      expect(a.pressMs).toBe(0)
      expect(a.releaseMs).toBe(30)
      expect(b.pressMs).toBe(200)
      expect(b.releaseMs).toBe(230)
    })
  })

  describe('trailing in-flight word (P5)', () => {
    it('appends a partial:true RunWord carrying an interrupted word\'s keystrokes instead of dropping them', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'h')
      recorder.record(ctx(), matrixPress({ ts: 1000 }))

      // Time-bounded run expires with word 0 (index 0) still in flight —
      // no submitted words at all.
      const log = recorder.finish([], finishMeta({
        startedAtMs: 1000,
        inFlightWord: { display: 'hello', typed: 'h' },
      }))
      expect(log).not.toBeNull()
      expect(log!.words).toHaveLength(1)
      const [word] = log!.words
      expect(word.index).toBe(0)
      expect(word.partial).toBe(true)
      expect(word.display).toBe('hello')
      expect(word.typed).toBe('h')
      expect(word.correct).toBe(false)
      expect(word.keystrokes).toHaveLength(1)
    })

    it('appends the in-flight word AFTER already-submitted words, at the correct index', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1000 }))
      register(recorder, 'run-1', 0, 1, 1010, 1, 'w')
      recorder.record(ctx(), matrixPress({ row: 0, col: 1, ts: 1010, keycode: KC_B }))

      const log = recorder.finish(
        [{ word: 'a', typed: 'a', correct: true }],
        finishMeta({ startedAtMs: 1000, inFlightWord: { display: 'word', typed: 'w' } }),
      )
      expect(log!.words).toHaveLength(2)
      expect(log!.words[0].partial).toBeUndefined()
      expect(log!.words[1].index).toBe(1)
      expect(log!.words[1].partial).toBe(true)
      expect(log!.words[1].keystrokes).toHaveLength(1)
    })

    it('still refuses to save (returns null) when there are no submitted words AND no in-flight word', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress({ ts: 1000 }))

      expect(recorder.finish([], finishMeta({ startedAtMs: 1000 }))).toBeNull()
    })
  })

  describe('caps', () => {
    it('refuses to finish (returns null) once the keystroke cap is exceeded', () => {
      const recorder = new RunLogRecorder()
      for (let i = 0; i <= MAX_RUN_LOG_EVENTS; i++) {
        register(recorder, 'run-1', 0, 0, 1000 + i, 0, 'a')
        recorder.record(ctx(), matrixPress({ ts: 1000 + i }))
      }
      expect(recorder.finish(oneWordResult(), finishMeta())).toBeNull()
    })
  })

  describe('discard()', () => {
    it('clears the buffer (unmount / keyboard-switch cleanup)', () => {
      const recorder = new RunLogRecorder()
      register(recorder, 'run-1', 0, 0, 1000, 0, 'a')
      recorder.record(ctx(), matrixPress())
      recorder.discard()
      expect(recorder.finish(oneWordResult(), finishMeta())).toBeNull()
    })
  })
})
