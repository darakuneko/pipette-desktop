// SPDX-License-Identifier: GPL-2.0-or-later

// Plan-typing-mistake-analysis Phase 1: verbatim mode's per-position mistake
// attribution (Backspace tallies a wrong char immediately; word-submit
// tallies whatever is still wrong/missing at that point, skipping positions
// already tallied via Backspace).

import { describe, it, expect } from 'vitest'
import { handleBackspace, handleSpace, tryFinishLastWord, type TypingTestState } from '../run-state'
import type { TypingTestConfig } from '../types'

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
    currentQuote: null,
    wpmHistory: [],
    lineBreaks: new Set(),
    lineIndents: [],
    romajiKeystrokes: '',
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
