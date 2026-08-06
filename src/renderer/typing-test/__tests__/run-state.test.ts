// SPDX-License-Identifier: GPL-2.0-or-later

// Plan-typing-mistake-analysis Phase 1: verbatim mode's per-position mistake
// attribution (Backspace tallies a wrong char immediately; word-submit
// tallies whatever is still wrong/missing at that point, skipping positions
// already tallied via Backspace).

import { describe, it, expect } from 'vitest'
import { handleBackspace, handleSpace, tryFinishLastWord, advanceAfterWord, type TypingTestState } from '../run-state'
import type { TypingTestConfig } from '../types'
import type { WeakSpotBiasProfile } from '../word-generator'

function makeState(overrides: Partial<TypingTestState> = {}): TypingTestState {
  return {
    status: 'running',
    runId: 'test-run',
    words: ['cat', 'dog'],
    currentWordIndex: 0,
    currentInput: '',
    compositionText: '',
    wordResults: [],
    startTime: Date.now(),
    endTime: null,
    correctChars: 0,
    incorrectChars: 0,
    totalKeystrokes: 0,
    confirmedChars: 0,
    kspcUncomputable: false,
    currentQuote: null,
    wpmHistory: [],
    lineBreaks: new Set(),
    lineIndents: [],
    romajiKeystrokes: '',
    kanaCharIndex: 0,
    kanaAwaitingMark: false,
    kanaSegmentErred: false,
    romajiCapable: false,
    mistakes: {},
    romajiSegmentErred: false,
    missedPositions: [],
    ...overrides,
  }
}

const config: TypingTestConfig = { mode: 'words', wordCount: 2, punctuation: false, numbers: false }

describe('handleBackspace — verbatim mistake tracking', () => {
  it('records 1 mistake for the target char when deleting a wrong character', () => {
    // word 'cat', typed 'cx' — 'x' is wrong at position 1 ('a').
    const state = makeState({ currentInput: 'cx' })
    const next = handleBackspace(state)
    expect(next.currentInput).toBe('c')
    expect(next.mistakes).toEqual({ a: 1 })
    expect(next.missedPositions).toEqual([1])
  })

  it('does not double-count when the same position is retyped wrong and deleted again', () => {
    let state = makeState({ currentInput: 'cx' })
    state = handleBackspace(state)
    expect(state.mistakes).toEqual({ a: 1 })
    state = { ...state, currentInput: state.currentInput + 'x' } // retype wrong again -> 'cx'
    state = handleBackspace(state)
    expect(state.mistakes).toEqual({ a: 1 })
    expect(state.missedPositions).toEqual([1])
  })

  it('records nothing when deleting a correct character', () => {
    const state = makeState({ currentInput: 'ca' })
    const next = handleBackspace(state)
    expect(next.mistakes).toEqual({})
    expect(next.missedPositions).toEqual([])
  })

  it('records nothing when deleting a character typed past the end of the word', () => {
    const state = makeState({ currentInput: 'catx' })
    const next = handleBackspace(state)
    expect(next.mistakes).toEqual({})
    expect(next.missedPositions).toEqual([])
  })

  it('is a no-op on empty input', () => {
    const state = makeState({ currentInput: '' })
    const next = handleBackspace(state)
    expect(next).toBe(state)
  })
})

describe('handleSpace — verbatim mistake tracking', () => {
  it('records 1 mistake for the target char when a wrong char is left in and submitted', () => {
    const state = makeState({ currentInput: 'cxt' })
    const next = handleSpace(state, config, 'english')
    expect(next.mistakes).toEqual({ a: 1 })
  })

  it('records nothing for correct typing', () => {
    const state = makeState({ currentInput: 'cat' })
    const next = handleSpace(state, config, 'english')
    expect(next.mistakes).toEqual({})
  })

  it('does not double-count a position already tallied via Backspace', () => {
    let state = makeState({ currentInput: 'cx' })
    state = handleBackspace(state) // tallies a:1, missedPositions [1]
    // Retype 'x' at the same position (still wrong) and finish the rest
    // correctly, then submit without deleting again.
    state = { ...state, currentInput: 'cxt' }
    const next = handleSpace(state, config, 'english')
    expect(next.mistakes).toEqual({ a: 1 })
  })

  it('records a mistake for every missing char when submitted short', () => {
    const state = makeState({ currentInput: 'c' })
    const next = handleSpace(state, config, 'english')
    // 'cat' vs 'c': positions 1 ('a') and 2 ('t') never typed at all.
    expect(next.mistakes).toEqual({ a: 1, t: 1 })
  })

  it('resets missedPositions for the next word', () => {
    let state = makeState({ currentInput: 'cx' })
    state = handleBackspace(state)
    const next = handleSpace(state, config, 'english')
    expect(next.missedPositions).toEqual([])
  })

  it('accumulates mistakes across multiple words without resetting the tally', () => {
    let state = makeState({ currentInput: 'cxt' })
    state = handleSpace(state, config, 'english') // 'cat' -> a:1
    state = { ...state, currentInput: 'dxg' }
    state = handleSpace(state, config, 'english') // 'dog' -> o:1
    expect(state.mistakes).toEqual({ a: 1, o: 1 })
  })
})

describe('tryFinishLastWord — verbatim mistake tracking', () => {
  it('carries through mistakes already recorded via Backspace without double-counting at finish', () => {
    let state = makeState({ words: ['cat'], currentWordIndex: 0, currentInput: 'cx' })
    state = handleBackspace(state) // a:1, missedPositions [1]
    state = { ...state, currentInput: 'ca' }
    // Not yet a full match ('ca' !== 'cat') — the word isn't finished yet.
    expect(tryFinishLastWord(state)).toBeNull()

    const full = tryFinishLastWord({ ...state, currentInput: 'cat' })
    expect(full).not.toBeNull()
    expect(full!.status).toBe('finished')
    expect(full!.mistakes).toEqual({ a: 1 })
    expect(full!.missedPositions).toEqual([])
  })
})

// KSPC's mode-agnostic denominator counter — verified directly against
// computeWordCharCounts's own credited-separator rule (handleSpace) and
// the no-separator last-word rule (tryFinishLastWord), independent of
// mistake tracking.
describe('confirmedChars', () => {
  it('handleSpace: advances by correct + incorrect (the credited separator included) for a correct submission', () => {
    // 'cat' typed 'cat': computeWordCharCounts -> correct 4 (1 separator + 3 match), incorrect 0.
    const state = makeState({ currentInput: 'cat' })
    const next = handleSpace(state, config, 'english')
    expect(next.confirmedChars).toBe(4)
  })

  it('handleSpace: advances by correct + incorrect for a wrong submission too (typo still confirmed)', () => {
    // 'cat' typed 'cxt': correct 3 (1 separator + 2 match), incorrect 1 -> sum 4.
    const state = makeState({ currentInput: 'cxt' })
    const next = handleSpace(state, config, 'english')
    expect(next.confirmedChars).toBe(4)
  })

  it('handleSpace: advances by correct + incorrect for a short submission (missing chars count as incorrect)', () => {
    // 'cat' typed 'c': len = max(1,3) = 3, correct 1(sep)+1('c' matches) = 2, incorrect 2 -> sum 4.
    const state = makeState({ currentInput: 'c' })
    const next = handleSpace(state, config, 'english')
    expect(next.confirmedChars).toBe(4)
  })

  it('handleSpace: accumulates across words without resetting', () => {
    let state = makeState({ currentInput: 'cat' })
    state = handleSpace(state, config, 'english') // +4
    state = { ...state, currentInput: 'dog' }
    state = handleSpace(state, config, 'english') // +4
    expect(state.confirmedChars).toBe(8)
  })

  it('tryFinishLastWord: advances by the word length alone, no separator credited', () => {
    const state = makeState({ words: ['cat'], currentWordIndex: 0, currentInput: 'cat' })
    const full = tryFinishLastWord(state)
    expect(full).not.toBeNull()
    expect(full!.confirmedChars).toBe(3) // 'cat'.length, no +1 separator
  })

  it('tryFinishLastWord: adds on top of whatever confirmedChars already accumulated from earlier words', () => {
    let state = makeState({ words: ['dog', 'cat'], currentWordIndex: 0, currentInput: 'dog' })
    state = handleSpace(state, config, 'english') // +4 (1 sep + 3 match) -> confirmedChars 4
    state = { ...state, currentInput: 'cat' }
    const full = tryFinishLastWord(state)
    expect(full).not.toBeNull()
    expect(full!.confirmedChars).toBe(7) // 4 + 3 (last word, no separator)
  })
})

// Weak Spot Training (Plan-miss-focus-mode): the run's weakSpotProfile
// snapshot (set once by freshState at run start — see useTypingTest.ts)
// must be reused verbatim by every time-mode refill, never recomputed.
describe('advanceAfterWord — weakSpotProfile threading', () => {
  const timeConfig: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false, weakSpotTraining: true }

  it('carries state.weakSpotProfile into the time-mode refill, biasing the extended batch', () => {
    const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { e: 1000 } }
    // Tail well below TIME_MODE_EXTEND_THRESHOLD (10) so a refill fires.
    const state = makeState({ words: ['w0', 'w1'], currentWordIndex: 2, weakSpotProfile: profile })
    const next = advanceAfterWord(state, timeConfig, 'english')
    expect(next.words.length).toBeGreaterThan(state.words.length)
    const refilled = next.words.slice(state.words.length)
    const withE = refilled.filter((w) => w.includes('e')).length
    expect(withE / refilled.length).toBeGreaterThan(0.5)
  })

  it('a run with no weakSpotProfile (toggle off / gate unmet) refills normally without one', () => {
    const state = makeState({ words: ['w0', 'w1'], currentWordIndex: 2, weakSpotProfile: undefined })
    const next = advanceAfterWord(state, timeConfig, 'english')
    expect(next.words.length).toBeGreaterThan(state.words.length)
  })
})
