// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingTest } from '../useTypingTest'
import { deserialize } from '../../../shared/keycodes/keycodes'
import type { TypingTestConfig } from '../types'

function buildMultiLayerKeymap(layers: Array<{ layer: number; entries: Array<[number, number, string]> }>): Map<string, number> {
  const m = new Map<string, number>()
  for (const { layer, entries } of layers) {
    for (const [row, col, qmkId] of entries) {
      m.set(`${layer},${row},${col}`, deserialize(qmkId))
    }
  }
  return m
}

function pressKeys(keys: string[]): Set<string> {
  return new Set(keys)
}

describe('useTypingTest', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('starts in waiting state with words generated', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.words.length).toBeGreaterThan(0)
  })

  it('ignores backspace on empty input at first word', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent('Backspace', false, false, false))
    act(() => result.current.processKeyEvent('Backspace', false, false, false))

    expect(result.current.state.currentInput).toBe('')
    expect(result.current.state.currentWordIndex).toBe(0)
  })

  it('ignores backspace on empty input at non-first word without reverting', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent(' ', false, false, false))

    expect(result.current.state.currentWordIndex).toBe(1)
    expect(result.current.state.wordResults).toHaveLength(1)
    const correctBefore = result.current.state.correctChars

    act(() => result.current.processKeyEvent('Backspace', false, false, false))

    expect(result.current.state.currentWordIndex).toBe(1)
    expect(result.current.state.currentInput).toBe('')
    expect(result.current.state.correctChars).toBe(correctBefore)
  })

  it('resets to waiting state with empty progress on restart', async () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    expect(result.current.state.status).toBe('running')

    await act(async () => result.current.restart())

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
    expect(result.current.state.currentWordIndex).toBe(0)
    expect(result.current.state.wordResults).toHaveLength(0)
  })

  it('initial accuracy is 100%', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.accuracy).toBe(100)
  })

  it('initial wpm is 0', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.wpm).toBe(0)
  })

  it('initial elapsed seconds is 0', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.elapsedSeconds).toBe(0)
  })

  it('increments elapsed seconds each second while running', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    expect(result.current.state.status).toBe('running')
    expect(result.current.elapsedSeconds).toBe(0)

    act(() => vi.advanceTimersByTime(3000))
    expect(result.current.elapsedSeconds).toBe(3)
  })

  it('decreases WPM as idle time passes after typing', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent(' ', false, false, false))

    expect(result.current.state.correctChars).toBeGreaterThan(0)

    act(() => vi.advanceTimersByTime(1000))
    const wpmAfter1s = result.current.wpm
    expect(wpmAfter1s).toBeGreaterThan(0)

    act(() => vi.advanceTimersByTime(60000))
    expect(result.current.wpm).toBeLessThan(wpmAfter1s)
  })

  it('restartWithCountdown starts in countdown status', async () => {
    const { result } = renderHook(() => useTypingTest())

    await act(async () => result.current.restartWithCountdown())

    expect(result.current.state.status).toBe('countdown')
    expect(result.current.state.words.length).toBeGreaterThan(0)
  })

  it('countdown transitions to waiting after 3 seconds', async () => {
    const { result } = renderHook(() => useTypingTest())

    await act(async () => result.current.restartWithCountdown())
    expect(result.current.state.status).toBe('countdown')

    act(() => vi.advanceTimersByTime(3000))
    expect(result.current.state.status).toBe('waiting')
  })
})

describe('useTypingTest initialConfig/initialLanguage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('uses initialConfig when provided', () => {
    const initialConfig: TypingTestConfig = {
      mode: 'words',
      wordCount: 60,
      punctuation: true,
      numbers: false,
    }
    const { result } = renderHook(() => useTypingTest(initialConfig))

    expect(result.current.config).toEqual(initialConfig)
    expect(result.current.state.words).toHaveLength(60)
  })

  it('uses initialLanguage when provided', () => {
    const { result } = renderHook(() => useTypingTest(undefined, 'english'))

    expect(result.current.language).toBe('english')
  })

  it('uses both initialConfig and initialLanguage', () => {
    const initialConfig: TypingTestConfig = {
      mode: 'time',
      duration: 60,
      punctuation: false,
      numbers: true,
    }
    const { result } = renderHook(() => useTypingTest(initialConfig, 'english'))

    expect(result.current.config).toEqual(initialConfig)
    expect(result.current.language).toBe('english')
  })

  it('falls back to defaults when initialConfig is undefined', () => {
    const { result } = renderHook(() => useTypingTest(undefined, undefined))

    expect(result.current.config).toEqual({
      mode: 'words',
      wordCount: 30,
      punctuation: false,
      numbers: false,
    })
    expect(result.current.language).toBe('english')
  })

  it('initialConfig quote mode works', () => {
    const initialConfig: TypingTestConfig = { mode: 'quote', quoteLength: 'short' }
    const { result } = renderHook(() => useTypingTest(initialConfig))

    expect(result.current.config).toEqual(initialConfig)
    expect(result.current.state.currentQuote).not.toBeNull()
  })
})

describe('useTypingTest config', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('exposes config and setConfig', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.config).toBeDefined()
    expect(result.current.config.mode).toBe('words')
    expect(typeof result.current.setConfig).toBe('function')
  })

  it('defaults to words mode with 30 words', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.config).toEqual({
      mode: 'words',
      wordCount: 30,
      punctuation: false,
      numbers: false,
    })
  })

  it('setConfig changes mode and regenerates words', async () => {
    const { result } = renderHook(() => useTypingTest())
    const wordsBefore = result.current.state.words

    const newConfig: TypingTestConfig = {
      mode: 'words',
      wordCount: 60,
      punctuation: false,
      numbers: false,
    }
    await act(async () => result.current.setConfig(newConfig))

    expect(result.current.config).toEqual(newConfig)
    expect(result.current.state.words).toHaveLength(60)
    expect(result.current.state.words).not.toEqual(wordsBefore)
  })

  it('words mode with punctuation generates punctuated words', async () => {
    const { result } = renderHook(() => useTypingTest())

    const config: TypingTestConfig = {
      mode: 'words',
      wordCount: 60,
      punctuation: true,
      numbers: false,
    }
    await act(async () => result.current.setConfig(config))

    const joined = result.current.state.words.join(' ')
    expect(joined).toMatch(/[.,]/)
  })

  it('words mode with numbers generates some numeric words', async () => {
    const { result } = renderHook(() => useTypingTest())

    const config: TypingTestConfig = {
      mode: 'words',
      wordCount: 100,
      punctuation: false,
      numbers: true,
    }
    await act(async () => result.current.setConfig(config))

    const hasNumber = result.current.state.words.some((w) => /\d/.test(w))
    expect(hasNumber).toBe(true)
  })

  it('quote mode generates words from a quote', async () => {
    const { result } = renderHook(() => useTypingTest())

    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    await act(async () => result.current.setConfig(config))

    expect(result.current.state.words.length).toBeGreaterThan(0)
    expect(result.current.state.currentQuote).not.toBeNull()
    expect(result.current.state.currentQuote?.source).toBeDefined()
  })

  it('restart regenerates words with current config', async () => {
    const { result } = renderHook(() => useTypingTest())

    const config: TypingTestConfig = {
      mode: 'words',
      wordCount: 15,
      punctuation: false,
      numbers: false,
    }
    await act(async () => result.current.setConfig(config))

    act(() => result.current.processKeyEvent('a', false, false, false))
    expect(result.current.state.status).toBe('running')

    await act(async () => result.current.restart())

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.words).toHaveLength(15)
  })
})

describe('useTypingTest time mode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('time mode generates a large batch of words', async () => {
    const { result } = renderHook(() => useTypingTest())

    const config: TypingTestConfig = {
      mode: 'time',
      duration: 30,
      punctuation: false,
      numbers: false,
    }
    await act(async () => result.current.setConfig(config))

    expect(result.current.state.words.length).toBeGreaterThanOrEqual(60)
  })

  it('remainingSeconds starts at the configured duration', async () => {
    const { result } = renderHook(() => useTypingTest())

    const config: TypingTestConfig = {
      mode: 'time',
      duration: 30,
      punctuation: false,
      numbers: false,
    }
    await act(async () => result.current.setConfig(config))

    expect(result.current.remainingSeconds).toBe(30)
  })

  it('remainingSeconds counts down while running', async () => {
    const { result } = renderHook(() => useTypingTest())

    const config: TypingTestConfig = {
      mode: 'time',
      duration: 15,
      punctuation: false,
      numbers: false,
    }
    await act(async () => result.current.setConfig(config))

    act(() => result.current.processKeyEvent('a', false, false, false))
    expect(result.current.state.status).toBe('running')

    act(() => vi.advanceTimersByTime(5000))
    expect(result.current.remainingSeconds).toBe(10)
  })

  it('finishes when timer reaches 0', async () => {
    const { result } = renderHook(() => useTypingTest())

    const config: TypingTestConfig = {
      mode: 'time',
      duration: 15,
      punctuation: false,
      numbers: false,
    }
    await act(async () => result.current.setConfig(config))

    act(() => result.current.processKeyEvent('a', false, false, false))

    act(() => vi.advanceTimersByTime(15000))
    expect(result.current.state.status).toBe('finished')
    expect(result.current.remainingSeconds).toBe(0)
  })

  it('time mode does not finish from completing all words', async () => {
    const { result } = renderHook(() => useTypingTest())

    const config: TypingTestConfig = {
      mode: 'time',
      duration: 60,
      punctuation: false,
      numbers: false,
    }
    await act(async () => result.current.setConfig(config))

    // Type through several words quickly using processKeyEvent
    for (let i = 0; i < 10; i++) {
      act(() => result.current.processKeyEvent('a', false, false, false))
      act(() => result.current.processKeyEvent(' ', false, false, false))
    }

    // Should still be running since time hasn't expired
    expect(result.current.state.status).toBe('running')
  })

  it('remainingSeconds is null in words mode', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.remainingSeconds).toBeNull()
  })

  it('extends words when approaching end of list', async () => {
    const { result } = renderHook(() => useTypingTest())

    const config: TypingTestConfig = {
      mode: 'time',
      duration: 60,
      punctuation: false,
      numbers: false,
    }
    await act(async () => result.current.setConfig(config))

    const initialWordCount = result.current.state.words.length

    // Type through enough words to trigger extension (initial batch is 60)
    for (let i = 0; i < initialWordCount - 5; i++) {
      act(() => result.current.processKeyEvent('a', false, false, false))
      act(() => result.current.processKeyEvent(' ', false, false, false))
    }

    // Words should have been extended beyond the initial batch
    expect(result.current.state.words.length).toBeGreaterThan(initialWordCount)
    expect(result.current.state.status).toBe('running')
  })
})

describe('useTypingTest baseLayer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('defaults baseLayer to 0', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.baseLayer).toBe(0)
  })

  it('setBaseLayer changes baseLayer', async () => {
    const { result } = renderHook(() => useTypingTest())
    await act(async () => result.current.setBaseLayer(2))
    expect(result.current.baseLayer).toBe(2)
  })

  it('setBaseLayer resets test state', async () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    expect(result.current.state.status).toBe('running')

    await act(async () => result.current.setBaseLayer(1))
    expect(result.current.state.status).toBe('waiting')
  })
})

describe('useTypingTest layer tracking with MO/LT', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('updates effectiveLayer when MO key is held', () => {
    const { result } = renderHook(() => useTypingTest())

    const multiKeymap = buildMultiLayerKeymap([
      { layer: 0, entries: [[0, 0, 'KC_A'], [3, 0, 'MO(1)'], [1, 0, 'KC_SPACE']] },
      { layer: 1, entries: [[0, 0, 'KC_B']] },
    ])

    act(() => result.current.processMatrixFrame(pressKeys(['3,0']), multiKeymap))
    expect(result.current.effectiveLayer).toBe(1)
  })

  it('updates effectiveLayer when LT key is held with another key', () => {
    const { result } = renderHook(() => useTypingTest())

    const multiKeymap = buildMultiLayerKeymap([
      { layer: 0, entries: [[0, 0, 'KC_A'], [3, 0, 'LT(1,KC_SPC)'], [1, 0, 'KC_SPACE']] },
      { layer: 1, entries: [[0, 0, 'KC_B']] },
    ])

    act(() => result.current.processMatrixFrame(pressKeys(['3,0']), multiKeymap))
    expect(result.current.effectiveLayer).toBe(1)
  })

  it('picks highest layer when multiple MO keys are held', () => {
    const { result } = renderHook(() => useTypingTest())

    const multiKeymap = buildMultiLayerKeymap([
      { layer: 0, entries: [[0, 0, 'KC_A'], [3, 0, 'MO(1)'], [3, 1, 'MO(2)'], [1, 0, 'KC_SPACE']] },
      { layer: 1, entries: [[0, 0, 'KC_B']] },
      { layer: 2, entries: [[0, 0, 'KC_C']] },
    ])

    act(() => result.current.processMatrixFrame(pressKeys(['3,0', '3,1']), multiKeymap))
    expect(result.current.effectiveLayer).toBe(2)
  })

  it('discovers layer switches on non-base layers (LT→layer1→MO(2)→layer2)', () => {
    const { result } = renderHook(() => useTypingTest())

    const multiKeymap = buildMultiLayerKeymap([
      { layer: 0, entries: [[0, 0, 'KC_A'], [3, 0, 'LT(1,KC_SPC)'], [1, 0, 'KC_SPACE']] },
      { layer: 1, entries: [[0, 0, 'KC_B'], [3, 1, 'MO(2)']] },
      { layer: 2, entries: [[0, 0, 'KC_C']] },
    ])

    act(() => result.current.processMatrixFrame(pressKeys(['3,0']), multiKeymap))
    act(() => result.current.processMatrixFrame(pressKeys(['3,0', '3,1']), multiKeymap))

    expect(result.current.effectiveLayer).toBe(2)
  })

  it('detects LM as a layer switch', () => {
    const { result } = renderHook(() => useTypingTest())

    const multiKeymap = buildMultiLayerKeymap([
      { layer: 0, entries: [[0, 0, 'KC_A'], [3, 0, 'LM(1, MOD_LSFT)'], [1, 0, 'KC_SPACE']] },
      { layer: 1, entries: [[0, 0, 'KC_B']] },
    ])

    act(() => result.current.processMatrixFrame(pressKeys(['3,0']), multiKeymap))
    expect(result.current.effectiveLayer).toBe(1)
  })

  it('uses per-key effective keycode for layer-switch detection (higher layer overrides)', () => {
    const { result } = renderHook(() => useTypingTest())

    const multiKeymap = buildMultiLayerKeymap([
      { layer: 0, entries: [[0, 0, 'KC_A'], [3, 0, 'MO(1)'], [3, 1, 'MO(2)'], [1, 0, 'KC_SPACE']] },
      { layer: 1, entries: [[3, 1, 'KC_SPACE']] },
      { layer: 2, entries: [[0, 0, 'KC_C']] },
    ])

    act(() => result.current.processMatrixFrame(pressKeys(['3,0']), multiKeymap))
    act(() => result.current.processMatrixFrame(pressKeys(['3,0', '3,1']), multiKeymap))

    // Layer 1 overrides MO(2) with KC_SPACE, so layer 2 should NOT activate
    expect(result.current.effectiveLayer).toBe(1)
  })
})

describe('useTypingTest effectiveLayer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('defaults effectiveLayer to baseLayer (0)', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.effectiveLayer).toBe(0)
  })

  it('resets effectiveLayer to baseLayer when MO key is released', () => {
    const { result } = renderHook(() => useTypingTest())

    const multiKeymap = buildMultiLayerKeymap([
      { layer: 0, entries: [[0, 0, 'KC_A'], [3, 0, 'MO(1)'], [1, 0, 'KC_SPACE']] },
      { layer: 1, entries: [[0, 0, 'KC_B']] },
    ])

    // Press MO(1)
    act(() => result.current.processMatrixFrame(pressKeys(['3,0']), multiKeymap))
    expect(result.current.effectiveLayer).toBe(1)

    // Release all keys — need a new key press to trigger frame processing
    act(() => result.current.processMatrixFrame(new Set(), multiKeymap))
    // Press a normal key without MO held
    act(() => result.current.processMatrixFrame(pressKeys(['0,0']), multiKeymap))

    expect(result.current.effectiveLayer).toBe(0)
  })

  it('follows baseLayer when setBaseLayer is called', async () => {
    const { result } = renderHook(() => useTypingTest())

    await act(async () => result.current.setBaseLayer(2))
    expect(result.current.effectiveLayer).toBe(2)
  })
})

describe('useTypingTest processKeyEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('appends printable characters to current input', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent('b', false, false, false))

    expect(result.current.state.currentInput).toBe('ab')
  })

  it('transitions from waiting to running on first printable key', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))

    expect(result.current.state.status).toBe('running')
    expect(result.current.state.startTime).not.toBeNull()
  })

  it('handles space as word submit', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent(' ', false, false, false))

    expect(result.current.state.currentWordIndex).toBe(1)
    expect(result.current.state.currentInput).toBe('')
    expect(result.current.state.wordResults).toHaveLength(1)
  })

  it('Enter does not submit word (only space keys submit)', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent('Enter', false, false, false))

    expect(result.current.state.currentWordIndex).toBe(0)
    expect(result.current.state.wordResults).toHaveLength(0)
  })

  it('handles full-width space (U+3000) as word submit', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent('\u3000', false, false, false))

    expect(result.current.state.currentWordIndex).toBe(1)
    expect(result.current.state.currentInput).toBe('')
    expect(result.current.state.wordResults).toHaveLength(1)
  })

  it('handles Backspace to delete last character', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent('b', false, false, false))
    act(() => result.current.processKeyEvent('Backspace', false, false, false))

    expect(result.current.state.currentInput).toBe('a')
  })

  it('does not start test on Backspace', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('Backspace', false, false, false))

    expect(result.current.state.status).toBe('waiting')
  })

  it('ignores Ctrl+key combos', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('c', true, false, false))

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
  })

  it('ignores Alt+key combos', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, true, false))

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
  })

  it('allows AltGr (Ctrl+Alt) printable characters', () => {
    const { result } = renderHook(() => useTypingTest())

    // AltGr reports as Ctrl+Alt on international keyboards
    act(() => result.current.processKeyEvent('@', true, true, false))

    expect(result.current.state.status).toBe('running')
    expect(result.current.state.currentInput).toBe('@')
  })

  it('ignores Meta+key combos', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('a', false, false, true))

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
  })

  it('ignores IME Process key', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('Process', false, false, false))

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
  })

  it('ignores Dead key', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('Dead', false, false, false))

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
  })

  it('ignores Unidentified key', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('Unidentified', false, false, false))

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
  })

  it('does not start test on non-input keys like Shift', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('Shift', false, false, false))

    expect(result.current.state.status).toBe('waiting')
  })

  it('does not start test on Control key', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('Control', false, false, false))

    expect(result.current.state.status).toBe('waiting')
  })

  it('does not start test on Tab key', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('Tab', false, false, false))

    expect(result.current.state.status).toBe('waiting')
  })

  it('does not start test on Escape key', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('Escape', false, false, false))

    expect(result.current.state.status).toBe('waiting')
  })

  it('ignores key events during countdown', async () => {
    const { result } = renderHook(() => useTypingTest())

    await act(async () => result.current.restartWithCountdown())
    expect(result.current.state.status).toBe('countdown')

    act(() => result.current.processKeyEvent('a', false, false, false))

    expect(result.current.state.status).toBe('countdown')
    expect(result.current.state.currentInput).toBe('')
  })

  it('ignores key events during finished state', () => {
    const { result } = renderHook(() => useTypingTest())

    // Type through all words to finish
    const words = result.current.state.words
    for (let i = 0; i < words.length; i++) {
      for (const char of words[i]) {
        act(() => result.current.processKeyEvent(char, false, false, false))
      }
      act(() => result.current.processKeyEvent(' ', false, false, false))
    }

    expect(result.current.state.status).toBe('finished')

    act(() => result.current.processKeyEvent('a', false, false, false))

    expect(result.current.state.status).toBe('finished')
  })

  it('handles uppercase characters from DOM (shift resolved by firmware)', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processKeyEvent('A', false, false, false))

    expect(result.current.state.currentInput).toBe('A')
  })
})

describe('useTypingTest composition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('compositionText defaults to empty string', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.state.compositionText).toBe('')
  })

  it('processCompositionEnd with non-empty data starts test from waiting state', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.state.status).toBe('waiting')

    act(() => result.current.processCompositionEnd('あ'))
    expect(result.current.state.status).toBe('running')
    expect(result.current.state.startTime).not.toBeNull()
  })

  it('processCompositionStart does not start test (timer deferred to compositionEnd)', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processCompositionStart())
    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.startTime).toBeNull()
  })

  it('processCompositionUpdate sets compositionText', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processCompositionStart())
    act(() => result.current.processCompositionUpdate('あ'))
    expect(result.current.state.compositionText).toBe('あ')

    act(() => result.current.processCompositionUpdate('あい'))
    expect(result.current.state.compositionText).toBe('あい')
  })

  it('processCompositionEnd appends data to currentInput and clears compositionText', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processCompositionStart())
    act(() => result.current.processCompositionUpdate('あ'))
    expect(result.current.state.compositionText).toBe('あ')

    act(() => result.current.processCompositionEnd('あ'))
    expect(result.current.state.currentInput).toBe('あ')
    expect(result.current.state.compositionText).toBe('')
  })

  it('canceled composition (empty compositionEnd) does not alter currentInput or start test', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processCompositionStart())
    act(() => result.current.processCompositionUpdate('あ'))
    act(() => result.current.processCompositionEnd(''))

    expect(result.current.state.currentInput).toBe('')
    expect(result.current.state.compositionText).toBe('')
    expect(result.current.state.status).toBe('waiting')
  })

  it('Space after compositionEnd submits the word', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processCompositionEnd('あ'))
    expect(result.current.state.currentInput).toBe('あ')

    // The IME confirm keydown (Enter/Space) fires with isComposing=true
    // and is blocked by the capture handler, so it never reaches processKeyEvent.
    // The next Space is the user's real intent to advance.
    act(() => result.current.processKeyEvent(' ', false, false, false))
    expect(result.current.state.currentWordIndex).toBe(1)
  })

  it('full-width space after compositionEnd submits the word', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processCompositionEnd('あ'))

    act(() => result.current.processKeyEvent('\u3000', false, false, false))
    expect(result.current.state.currentWordIndex).toBe(1)
  })

  it('Enter after compositionEnd does not submit the word', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processCompositionEnd('あ'))

    act(() => result.current.processKeyEvent('Enter', false, false, false))
    expect(result.current.state.currentWordIndex).toBe(0)
  })

  it('compositionText resets on restart', async () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.processCompositionStart())
    act(() => result.current.processCompositionUpdate('あ'))
    expect(result.current.state.compositionText).toBe('あ')

    await act(async () => result.current.restart())
    expect(result.current.state.compositionText).toBe('')
  })

  it('ignores composition events in finished state', () => {
    const { result } = renderHook(() => useTypingTest())

    // Type through all words to finish
    const words = result.current.state.words
    for (let i = 0; i < words.length; i++) {
      for (const char of words[i]) {
        act(() => result.current.processKeyEvent(char, false, false, false))
      }
      act(() => result.current.processKeyEvent(' ', false, false, false))
    }
    expect(result.current.state.status).toBe('finished')

    act(() => result.current.processCompositionStart())
    act(() => result.current.processCompositionUpdate('あ'))
    act(() => result.current.processCompositionEnd('あ'))

    expect(result.current.state.compositionText).toBe('')
    expect(result.current.state.status).toBe('finished')
  })

  it('ignores composition events during countdown', async () => {
    const { result } = renderHook(() => useTypingTest())

    await act(async () => result.current.restartWithCountdown())
    expect(result.current.state.status).toBe('countdown')

    act(() => result.current.processCompositionStart())
    act(() => result.current.processCompositionUpdate('あ'))
    act(() => result.current.processCompositionEnd('あ'))

    expect(result.current.state.compositionText).toBe('')
    expect(result.current.state.status).toBe('countdown')
  })
})

describe('useTypingTest windowFocused', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('defaults windowFocused to true', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.windowFocused).toBe(true)
  })

  it('setWindowFocused changes windowFocused state', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.setWindowFocused(false))
    expect(result.current.windowFocused).toBe(false)

    act(() => result.current.setWindowFocused(true))
    expect(result.current.windowFocused).toBe(true)
  })

  it('processKeyEvent ignores input when window is not focused', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.setWindowFocused(false))
    act(() => result.current.processKeyEvent('a', false, false, false))

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
  })

  it('processKeyEvent resumes processing when focus is restored', () => {
    const { result } = renderHook(() => useTypingTest())

    act(() => result.current.setWindowFocused(false))
    act(() => result.current.processKeyEvent('a', false, false, false))
    expect(result.current.state.currentInput).toBe('')

    act(() => result.current.setWindowFocused(true))
    act(() => result.current.processKeyEvent('a', false, false, false))
    expect(result.current.state.currentInput).toBe('a')
  })
})
