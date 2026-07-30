// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingTest } from '../useTypingTest'
import { deserialize } from '../../../shared/keycodes/keycodes'
import { MAX_TAP_HOLD_DEFER_MS } from '../../../shared/qmk-settings-tapping-term'
import type { TypingTestConfig } from '../types'
import type { TypingAnalyticsEventPayload } from '../../../shared/types/typing-analytics'

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

/** useTypingTest's analytics options now split gate/tag (prepare, at press
 *  time) from shipping (emit, once the item is ready to leave the ordering
 *  queue) — see UseTypingTestOptions. These tests only exercise
 *  useTypingTest's own queueing/ordering/tap-hold logic, not the gating a
 *  real caller (useInputModes) layers on top, so prepare here always
 *  authorizes (opaque token `true`) and emit forwards the bare payload —
 *  reproducing the single-argument `sink(payload)` shape these tests were
 *  written against.
 *
 *  `kind: 'matrix-release'` events are filtered out by default: every
 *  pre-existing test in this file was written against a world where a
 *  release edge never produced its own event, and pinning that behavior
 *  means those assertions (call counts especially) must keep seeing
 *  exactly what they saw before. Tests that specifically cover the new
 *  duration/release emit opt in via `includeReleases: true`. */
function analyticsOptions(
  sink: (payload: TypingAnalyticsEventPayload) => void,
  options?: { includeReleases?: boolean },
) {
  return {
    onPrepareAnalyticsEvent: () => true,
    onEmitAnalyticsEvent: (_prepared: unknown, event: TypingAnalyticsEventPayload) => {
      if (event.kind === 'matrix-release' && !options?.includeReleases) return
      sink(event)
    },
  }
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

describe('useTypingTest KSPC (totalKeystrokes)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('counts one keystroke per accepted printable character', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent('b', false, false, false))
    expect(result.current.state.totalKeystrokes).toBe(2)
  })

  it('counts a Backspace on empty input (rejected, but still a physical keystroke)', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent('Backspace', false, false, false)) // deletes 'a'
    act(() => result.current.processKeyEvent('Backspace', false, false, false)) // empty — no-op in the reducer
    expect(result.current.state.currentInput).toBe('')
    expect(result.current.state.totalKeystrokes).toBe(3)
  })

  it('counts a wrong submit key (Enter where Space is expected) as a keystroke', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent('Enter', false, false, false)) // no-op (Space expected)
    expect(result.current.state.currentWordIndex).toBe(0)
    expect(result.current.state.totalKeystrokes).toBe(1)
  })

  it('does not count multi-character key names (Shift, Control, ...)', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processKeyEvent('Shift', false, false, false))
    expect(result.current.state.totalKeystrokes).toBe(0)
  })

  it('resets to 0 on restart', async () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processKeyEvent('a', false, false, false))
    expect(result.current.state.totalKeystrokes).toBe(1)
    await act(async () => result.current.restart())
    expect(result.current.state.totalKeystrokes).toBe(0)
  })

  it('exposes a live kspc ratio once some keystrokes and confirmed chars exist', () => {
    const { result } = renderHook(() => useTypingTest({ mode: 'words', wordCount: 5, punctuation: false, numbers: false }, 'english'))
    const word = result.current.state.words[0]
    for (const ch of word) act(() => result.current.processKeyEvent(ch, false, false, false))
    act(() => result.current.processKeyEvent(' ', false, false, false))
    // word typed correctly + 1 separator keystroke, no mistakes -> keystrokes === chars -> kspc 1.
    expect(result.current.kspc).toBe(1)
  })

  it('kspc is null before anything is confirmed', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.kspc).toBeNull()
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

  it('marks the run KSPC-uncomputable once a composition commits real text', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.state.kspcUncomputable).toBe(false)
    act(() => result.current.processCompositionEnd('あ'))
    expect(result.current.state.kspcUncomputable).toBe(true)
    expect(result.current.kspc).toBeNull()
  })

  it('marks the run KSPC-uncomputable even when the composition is canceled (empty data)', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processCompositionStart())
    act(() => result.current.processCompositionEnd(''))
    expect(result.current.state.kspcUncomputable).toBe(true)
  })

  it('stays uncomputable for the rest of the run even after further normal typing (one-way)', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processCompositionEnd('あ'))
    expect(result.current.state.kspcUncomputable).toBe(true)
    act(() => result.current.processKeyEvent('a', false, false, false))
    act(() => result.current.processKeyEvent(' ', false, false, false))
    expect(result.current.state.kspcUncomputable).toBe(true)
    expect(result.current.kspc).toBeNull()
  })

  it('resets to computable again on restart (fresh run)', async () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processCompositionEnd('あ'))
    expect(result.current.state.kspcUncomputable).toBe(true)
    await act(async () => result.current.restart())
    expect(result.current.state.kspcUncomputable).toBe(false)
  })

  it('marks the run KSPC-uncomputable at composition START, before any compositionEnd', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processCompositionStart())
    expect(result.current.state.kspcUncomputable).toBe(true)
  })

  it('a time-mode run that expires mid-composition (compositionEnd never fires) is still uncomputable', async () => {
    const { result } = renderHook(() => useTypingTest())
    const config: TypingTestConfig = { mode: 'time', duration: 15, punctuation: false, numbers: false }
    await act(async () => result.current.setConfig(config))

    // A real keystroke starts the run's timer running.
    act(() => result.current.processKeyEvent('a', false, false, false))
    expect(result.current.state.status).toBe('running')

    // IME composition opens but the user never confirms it before time runs
    // out — compositionEnd is never called, only compositionStart.
    act(() => result.current.processCompositionStart())
    act(() => result.current.processCompositionUpdate('あ'))

    act(() => vi.advanceTimersByTime(15000))
    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.kspcUncomputable).toBe(true)
    expect(result.current.kspc).toBeNull()
  })

  it('does not flag kspcUncomputable for composition that starts during countdown', async () => {
    const { result } = renderHook(() => useTypingTest())
    await act(async () => result.current.restartWithCountdown())
    expect(result.current.state.status).toBe('countdown')

    act(() => result.current.processCompositionStart())
    expect(result.current.state.kspcUncomputable).toBe(false)
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

  describe('analytics sink', () => {
    it('emits a char event for printable keys when a sink is provided', () => {
      const sink = vi.fn()
      const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

      act(() => result.current.processKeyEvent('a', false, false, false))

      expect(sink).toHaveBeenCalledTimes(1)
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'char', key: 'a' }))
    })

    it('emits a char event for Backspace', () => {
      const sink = vi.fn()
      const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

      act(() => result.current.processKeyEvent('a', false, false, false))
      act(() => result.current.processKeyEvent('Backspace', false, false, false))

      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'char', key: 'Backspace' }))
    })

    it('does not emit char events for modifier-only keys', () => {
      const sink = vi.fn()
      const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

      act(() => result.current.processKeyEvent('Shift', false, false, false))
      act(() => result.current.processKeyEvent('Control', false, false, false))
      act(() => result.current.processKeyEvent('Meta', false, false, false))

      expect(sink).not.toHaveBeenCalled()
    })

    it('does not emit char events when the window is not focused', () => {
      const sink = vi.fn()
      const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

      act(() => result.current.setWindowFocused(false))
      act(() => result.current.processKeyEvent('a', false, false, false))

      expect(sink).not.toHaveBeenCalled()
    })

    it('emits matrix events only on press edges', () => {
      const sink = vi.fn()
      const keymap = buildMultiLayerKeymap([
        { layer: 0, entries: [[0, 0, 'KC_A'], [0, 1, 'KC_B']] },
      ])
      const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

      act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
      expect(sink).toHaveBeenCalledTimes(1)
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'matrix', row: 0, col: 0 }))

      // Same key still held — should not re-emit
      act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
      expect(sink).toHaveBeenCalledTimes(1)

      // New key pressed — one more emit
      act(() => result.current.processMatrixFrame(pressKeys(['0,0', '0,1']), keymap))
      expect(sink).toHaveBeenCalledTimes(2)
      expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'matrix', row: 0, col: 1 }))
    })

    it('emits matrix events even when the window is not focused', () => {
      // Matrix events come from HID polling, so they should record physical
      // keystrokes regardless of window focus. The caller gates on record mode.
      const sink = vi.fn()
      const keymap = buildMultiLayerKeymap([
        { layer: 0, entries: [[0, 0, 'KC_A']] },
      ])
      const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

      act(() => result.current.setWindowFocused(false))
      act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))

      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'matrix', row: 0, col: 0 }))
    })

    it('resetMatrixPressTracking re-emits the next press edge after a reset', () => {
      const sink = vi.fn()
      const keymap = buildMultiLayerKeymap([
        { layer: 0, entries: [[0, 0, 'KC_A']] },
      ])
      const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

      act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
      expect(sink).toHaveBeenCalledTimes(1)

      // Without reset, the same held key stays silent.
      act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
      expect(sink).toHaveBeenCalledTimes(1)

      // resetMatrixPressTracking now returns a promise (so a record-off
      // caller can await the drain before flushing) — void it here since
      // this test only cares about the synchronous reset of prevPressed,
      // which happens before the promise settles.
      act(() => { void result.current.resetMatrixPressTracking() })
      act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
      expect(sink).toHaveBeenCalledTimes(2)
    })

    it('does not require a sink for normal typing test operation', () => {
      const { result } = renderHook(() => useTypingTest())
      act(() => result.current.processKeyEvent('a', false, false, false))
      expect(result.current.state.currentInput).toBe('a')
    })

    describe('masked-key tap/hold classification', () => {
      it('defers the matrix emit for masked keys until they resolve (release or deadline)', () => {
        const sink = vi.fn()
        // LT1(KC_SPACE) on (0, 0), plain KC_A on (0, 1).
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)'], [0, 1, 'KC_A']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
        // No emit yet — masked keys wait for release.
        expect(sink).not.toHaveBeenCalled()
      })

      it('classifies a short press as a tap on the release edge', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))

        vi.advanceTimersByTime(100)
        act(() => result.current.processMatrixFrame(new Set(), keymap))

        expect(sink).toHaveBeenCalledTimes(1)
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'matrix',
          row: 0,
          col: 0,
          action: 'tap',
        }))
      })

      it('classifies a still-held key as a hold once its deadline passes, without waiting for release', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))

        // Nothing releases the key — the deadline timer alone must fire the
        // 'hold' classification while it's still held.
        act(() => vi.advanceTimersByTime(500))

        expect(sink).toHaveBeenCalledTimes(1)
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'matrix',
          action: 'hold',
        }))

        // The eventual physical release must not re-emit — the deadline
        // already resolved and removed this press.
        act(() => result.current.processMatrixFrame(new Set(), keymap))
        expect(sink).toHaveBeenCalledTimes(1)
      })

      it('resolves a still-held key as hold at MAX_TAP_HOLD_DEFER_MS even when TAPPING_TERM is configured larger', () => {
        // A TAPPING_TERM above the cap is the accepted trade-off documented
        // on MAX_TAP_HOLD_DEFER_MS: the deferred-emit deadline must never
        // exceed the cap, so a genuine (if unusually long) tap held past
        // the cap resolves as a hold before the keyboard's own TAPPING_TERM
        // would have fired.
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)']] },
        ])
        const largeTerm = MAX_TAP_HOLD_DEFER_MS + 2000
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: largeTerm }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))

        // Still unresolved just short of the cap.
        act(() => vi.advanceTimersByTime(MAX_TAP_HOLD_DEFER_MS - 1))
        expect(sink).not.toHaveBeenCalled()

        // Crossing the cap resolves it as hold — well before largeTerm.
        act(() => vi.advanceTimersByTime(1))
        expect(sink).toHaveBeenCalledTimes(1)
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'matrix',
          action: 'hold',
        }))
      })

      it('resolves duration === tappingTermMs as hold (boundary matches the pre-queue duration < term comparison)', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        const pressAt = new Date('2026-04-18T10:00:00.000Z')
        vi.setSystemTime(pressAt)
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))

        // Move the clock to exactly the deadline WITHOUT advancing fake
        // timers, so the deadline timer itself never fires — this exercises
        // the release-edge duration comparison, not the timer fallback.
        vi.setSystemTime(new Date(pressAt.getTime() + 200))
        act(() => result.current.processMatrixFrame(new Set(), keymap))

        expect(sink).toHaveBeenCalledTimes(1)
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'matrix',
          action: 'hold',
        }))
      })

      it('leaves non-masked keys firing on the press edge without an action field', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'KC_A']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
        expect(sink).toHaveBeenCalledTimes(1)
        const payload = sink.mock.calls[0][0] as { action?: string }
        expect(payload.action).toBeUndefined()

        // Release should NOT produce a second event for non-masked keys.
        vi.advanceTimersByTime(50)
        act(() => result.current.processMatrixFrame(new Set(), keymap))
        expect(sink).toHaveBeenCalledTimes(1)
      })

      it('resetMatrixPressTracking finalizes a pending masked-key press as hold and flushes the queue behind it, losing nothing', () => {
        const sink = vi.fn()
        // LT1(KC_SPACE) on (0, 0), plain KC_A on (0, 1).
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)'], [0, 1, 'KC_A']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
        // A normal key pressed while the masked press is unresolved queues
        // behind it instead of emitting — nothing has been sent yet.
        act(() => result.current.processMatrixFrame(pressKeys(['0,0', '0,1']), keymap))
        expect(sink).not.toHaveBeenCalled()

        // Recording stops mid-hold — both the masked press and the queued
        // key behind it must still reach the sink, in press order. Void
        // the returned promise — see the earlier reset test for why.
        act(() => { void result.current.resetMatrixPressTracking() })

        expect(sink).toHaveBeenCalledTimes(2)
        expect(sink).toHaveBeenNthCalledWith(1, expect.objectContaining({
          kind: 'matrix', row: 0, col: 0, action: 'hold',
        }))
        const [, letterPayload] = sink.mock.calls.map((c) => c[0] as { row: number; col: number; action?: string })
        expect(letterPayload.row).toBe(0)
        expect(letterPayload.col).toBe(1)
        expect(letterPayload.action).toBeUndefined()

        // The physical release that eventually arrives must not re-emit.
        act(() => result.current.processMatrixFrame(new Set(), keymap))
        expect(sink).toHaveBeenCalledTimes(2)
      })

      it('clears the pending deadline timer on unmount so it cannot fire against a torn-down hook', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)']] },
        ])
        const { result, unmount } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
        expect(sink).not.toHaveBeenCalled()

        unmount()

        // The deadline timer that would have fired at +200ms must never
        // call back into a hook that has already torn down.
        act(() => vi.advanceTimersByTime(500))
        expect(sink).not.toHaveBeenCalled()
      })
    })

    describe('press-order emission across an unresolved tap-hold', () => {
      it('emits a quickly-tapped masked key before a later letter, in press order', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)'], [0, 1, 'KC_A']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
        vi.advanceTimersByTime(50)
        act(() => result.current.processMatrixFrame(new Set(), keymap))
        expect(sink).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(50)
        act(() => result.current.processMatrixFrame(pressKeys(['0,1']), keymap))

        expect(sink).toHaveBeenCalledTimes(2)
        expect(sink).toHaveBeenNthCalledWith(1, expect.objectContaining({ row: 0, col: 0, action: 'tap' }))
        const letterPayload = sink.mock.calls[1][0] as { row: number; col: number; action?: string }
        expect(letterPayload.row).toBe(0)
        expect(letterPayload.col).toBe(1)
        expect(letterPayload.action).toBeUndefined()
      })

      it('a normal key pressed while a masked key is unresolved is not emitted before it, even when overlapping (rolled keys)', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)'], [0, 1, 'KC_A']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        // Thumb LT1(KC_SPACE) pressed first.
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))

        // The next letter is pressed BEFORE the thumb key releases (an
        // ordinary fast roll) — it must queue, not emit.
        vi.advanceTimersByTime(30)
        act(() => result.current.processMatrixFrame(pressKeys(['0,0', '0,1']), keymap))
        expect(sink).not.toHaveBeenCalled()

        // The thumb key releases as a tap. Both events land now, still
        // ordered by press time — the masked key (pressed first) before
        // the letter (pressed second), even though the letter's release
        // resolved earlier in wall-clock terms than nothing did (the
        // letter itself never had a release edge, only a press).
        vi.advanceTimersByTime(30)
        act(() => result.current.processMatrixFrame(pressKeys(['0,1']), keymap))

        expect(sink).toHaveBeenCalledTimes(2)
        expect(sink).toHaveBeenNthCalledWith(1, expect.objectContaining({ row: 0, col: 0, action: 'tap' }))
        const letterPayload = sink.mock.calls[1][0] as { row: number; col: number; action?: string; ts: number }
        expect(letterPayload.row).toBe(0)
        expect(letterPayload.col).toBe(1)
        expect(letterPayload.action).toBeUndefined()
        const tapHoldPayload = sink.mock.calls[0][0] as { ts: number }
        expect(tapHoldPayload.ts).toBeLessThan(letterPayload.ts)
      })
    })

    describe('event.layer uses the source layer (key location), not the layer the key activates', () => {
      it('records MO1 at the base layer where MO1 is defined', () => {
        const sink = vi.fn()
        // MO1 on (0, 0) at layer 0. Layer 1 leaves (0, 0) transparent.
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'MO(1)']] },
          { layer: 1, entries: [[0, 0, 'KC_TRNS']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))

        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'matrix',
          row: 0,
          col: 0,
          layer: 0,
        }))
        const payload = sink.mock.calls[0][0] as { action?: string }
        expect(payload.action).toBeUndefined()
      })

      it('records LT1 tap on the base layer where LT1 is defined', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)']] },
          { layer: 1, entries: [[0, 0, 'KC_TRNS']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
        vi.advanceTimersByTime(100)
        act(() => result.current.processMatrixFrame(new Set(), keymap))

        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'matrix',
          layer: 0,
          action: 'tap',
        }))
      })

      it('records LT1 hold on the base layer where LT1 is defined', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)']] },
          { layer: 1, entries: [[0, 0, 'KC_TRNS']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink), tappingTermMs: 200 }))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
        vi.advanceTimersByTime(500)
        act(() => result.current.processMatrixFrame(new Set(), keymap))

        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'matrix',
          layer: 0,
          action: 'hold',
        }))
      })

      it('records MO1 at the base layer even when MO1 is defined on layer 1 too', () => {
        // Real-world keymaps often repeat the layer-switch key on the
        // target layer (so it stays visible / releases correctly when
        // held across nested layers). Without the carried-keys fix the
        // press would resolve from layer 1 and disappear from the base
        // view.
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'MO(1)']] },
          { layer: 1, entries: [[0, 0, 'MO(1)']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))

        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'matrix',
          row: 0,
          col: 0,
          layer: 0,
        }))
      })

      it('records keys pressed while MO1 is held at the upper layer', () => {
        const sink = vi.fn()
        // MO1 on (0, 0) at base. (1, 1) resolves to KC_A on layer 1 only.
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'MO(1)'], [1, 1, 'KC_TRNS']] },
          { layer: 1, entries: [[0, 0, 'KC_TRNS'], [1, 1, 'KC_A']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0', '1,1']), keymap))

        const calls = sink.mock.calls.map((c) => c[0]) as Array<{ row: number; col: number; layer: number }>
        const mo1 = calls.find((c) => c.row === 0 && c.col === 0)
        const kcA = calls.find((c) => c.row === 1 && c.col === 1)
        expect(mo1?.layer).toBe(0)
        expect(kcA?.layer).toBe(1)
      })
    })

    // Tracker-level semantics (overlap true/false/undefined, chords, holes,
    // pollGapMs first-edge-only, pre-hole discard) are covered exhaustively
    // in matrix-press-duration.test.ts. These hook-level tests stick to
    // wiring: that the hook actually calls into the tracker and forwards
    // its output onto the right events, not re-deriving the tracker's own
    // branch logic.
    describe('press duration + overlap + observation holes (hook wiring)', () => {
      it('emits a matrix-release event on release, with the release ts and elapsed duration', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([{ layer: 0, entries: [[0, 0, 'KC_A']] }])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink, { includeReleases: true })))

        const pressAt = new Date('2026-04-18T10:00:00.000Z')
        vi.setSystemTime(pressAt)
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))

        vi.setSystemTime(new Date(pressAt.getTime() + 120))
        act(() => result.current.processMatrixFrame(new Set(), keymap))

        expect(sink).toHaveBeenCalledTimes(2)
        expect(sink).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'matrix', row: 0, col: 0 }))
        expect(sink).toHaveBeenNthCalledWith(2, expect.objectContaining({
          kind: 'matrix-release', row: 0, col: 0, layer: 0, durationMs: 120,
        }))
      })

      it('does not emit a release for a masked key (duration tracking is independent of the tap/hold queue)', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([{ layer: 0, entries: [[0, 0, 'LT1(KC_SPACE)']] }])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, { ...analyticsOptions(sink, { includeReleases: true }), tappingTermMs: 200 }))

        const pressAt = new Date('2026-04-18T10:00:00.000Z')
        vi.setSystemTime(pressAt)
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))

        vi.setSystemTime(new Date(pressAt.getTime() + 80))
        act(() => result.current.processMatrixFrame(new Set(), keymap))

        // The tap classification AND the release-duration event both land.
        expect(sink).toHaveBeenCalledTimes(2)
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'matrix', action: 'tap' }))
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'matrix-release', durationMs: 80 }))
      })

      it('resetMatrixPressTracking discards an unresolved press instead of synthesizing a release', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([{ layer: 0, entries: [[0, 0, 'KC_A']] }])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink, { includeReleases: true })))

        vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
        expect(sink).toHaveBeenCalledTimes(1)

        act(() => { void result.current.resetMatrixPressTracking() })
        vi.advanceTimersByTime(500)

        // No release ever ships for the discarded press, even once the
        // physical release eventually arrives — the tracker forgot it.
        act(() => result.current.processMatrixFrame(new Set(), keymap))
        expect(sink).toHaveBeenCalledTimes(1)
      })

      it('forwards overlap and pollGapMs from the tracker onto the emitted matrix event', () => {
        const sink = vi.fn()
        const keymap = buildMultiLayerKeymap([
          { layer: 0, entries: [[0, 0, 'KC_A'], [0, 1, 'KC_B']] },
        ])
        const { result } = renderHook(() => useTypingTest(undefined, undefined, analyticsOptions(sink)))

        const start = new Date('2026-04-18T10:00:00.000Z')
        vi.setSystemTime(start)
        act(() => result.current.processMatrixFrame(pressKeys(['0,0']), keymap))
        vi.setSystemTime(new Date(start.getTime() + 20))
        act(() => result.current.processMatrixFrame(pressKeys(['0,0', '0,1']), keymap))

        expect(sink).toHaveBeenCalledTimes(2)
        const second = sink.mock.calls[1][0] as { overlap?: boolean; pollGapMs?: number }
        expect(second.overlap).toBe(true)
        expect(second.pollGapMs).toBe(20)
      })
    })
  })
})
