// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInputModes } from '../useInputModes'
import { getFileImportTextData, clearFileImportTextCache } from '../../../typing-test/word-generator'
import type { TypingTestMemory } from '../../../../shared/types/pipette-settings'

const mockTypingAnalyticsEvent = vi.fn<(event: unknown) => Promise<void>>()
const mockTypingAnalyticsFlush = vi.fn<(uid: string) => Promise<void>>()
const mockTypingRunLogSave = vi.fn<(uid: string, log: unknown) => Promise<{ success: boolean }>>()

function installVialApi(): void {
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsEvent: mockTypingAnalyticsEvent,
      typingAnalyticsFlush: mockTypingAnalyticsFlush,
      typingRunLogSave: mockTypingRunLogSave,
    },
    writable: true,
    configurable: true,
  })
}

beforeEach(() => {
  mockTypingAnalyticsEvent.mockReset().mockResolvedValue(undefined)
  mockTypingAnalyticsFlush.mockReset().mockResolvedValue(undefined)
  mockTypingRunLogSave.mockReset().mockResolvedValue({ success: true })
  installVialApi()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  clearFileImportTextCache()
})

async function flushMicrotasks(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve()
    }
  })
}

function buildKeymap(): Map<string, number> {
  const m = new Map<string, number>()
  m.set('0,0,0', 0x04) // KC_A
  return m
}

const sampleKeyboard = {
  uid: '0xAABB',
  vendorId: 0xFEED,
  productId: 0x0000,
  productName: 'Pipette Keyboard',
}

/** Shared setup for the three tests exercising a real (non-viewOnly)
 *  practice run through to completion — a `wordCount`-word run, unlocked,
 *  with the given initial consent. `rerender({ recordingConsentAccepted })`
 *  flips consent mid-run for the revocation test. */
function renderRunLogHook({ consent, wordCount }: { consent: boolean; wordCount: number }) {
  const onSaveTypingTestResult = vi.fn()
  const stableKeymap = buildKeymap()
  const stableConfig = { mode: 'words' as const, wordCount, punctuation: false, numbers: false }
  return renderHook(
    ({ recordingConsentAccepted }: { recordingConsentAccepted: boolean }) => useInputModes({
      rows: 1,
      cols: 1,
      keymap: stableKeymap,
      unlocked: true,
      typingTestMode: true,
      typingTestViewOnly: false,
      typingRecordKeyboard: sampleKeyboard,
      onSaveTypingTestResult,
      savedTypingTestConfig: stableConfig,
      recordingConsentAccepted,
    }),
    { initialProps: { recordingConsentAccepted: consent } },
  )
}

describe('useInputModes — run-log recording', () => {
  it('never saves a run log for pure REC input (typingTestViewOnly), even with consent granted', async () => {
    const keymap = buildKeymap()
    const { result } = renderHook(() => useInputModes({
      rows: 1,
      cols: 1,
      keymap,
      typingTestMode: true,
      typingTestViewOnly: true,
      typingRecordEnabled: true,
      typingRecordKeyboard: sampleKeyboard,
      recordingConsentAccepted: true,
    }))

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
    })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(), keymap)
    })
    await flushMicrotasks()

    // The per-minute analytics pipeline still runs (untagged REC input) —
    // it's the run-log save specifically that must never fire.
    expect(mockTypingAnalyticsEvent).toHaveBeenCalled()
    expect(mockTypingRunLogSave).not.toHaveBeenCalled()
  })

  it('saves a run log once a tagged practice run finishes, with consent granted', async () => {
    const { result } = renderRunLogHook({ consent: true, wordCount: 1 })
    const keymap = buildKeymap()

    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })
    const [word] = result.current.typingTest.state.words
    const runId = result.current.typingTest.state.runId
    for (const char of word) {
      // A real keystroke is both a matrix press/release (registers the
      // word attribution noteRegistration needs — see run-log-recorder.ts's
      // `record()` doc comment on why it never mints a buffer on its own)
      // and the DOM char event; drive both so there's something to save.
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
      })
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(), keymap)
      })
      act(() => {
        result.current.typingTest.processKeyEvent(char, false, false, false)
      })
    }
    expect(result.current.typingTest.state.status).toBe('finished')
    await flushMicrotasks()

    expect(mockTypingRunLogSave).toHaveBeenCalledTimes(1)
    const [savedUid, savedLog] = mockTypingRunLogSave.mock.calls[0] as [string, { runId: string; uid: string; romajiInput?: boolean }]
    expect(savedUid).toBe(sampleKeyboard.uid)
    expect(savedLog.runId).toBe(runId)
    expect(savedLog.uid).toBe(sampleKeyboard.uid)
    // An ordinary verbatim (non-romaji) English words run must not flag
    // romajiInput — reuses the same isRomajiInputActive determination
    // already made for the saved TypingTestResult, forwarded verbatim.
    expect(savedLog.romajiInput).toBeUndefined()
  })

  it('never saves a run log without recording consent, even for a completed practice run', async () => {
    const { result } = renderRunLogHook({ consent: false, wordCount: 1 })
    const keymap = buildKeymap()

    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })
    const [word] = result.current.typingTest.state.words
    for (const char of word) {
      // Drive both the matrix press/release (what noteRegistration/record
      // actually gate on) and the DOM char event, same as the passing
      // "saves a run log" test above — without the matrix side, this test
      // could never fail regardless of the consent gate (nothing would
      // ever have entered the buffer in the first place).
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
      })
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(), keymap)
      })
      act(() => {
        result.current.typingTest.processKeyEvent(char, false, false, false)
      })
    }
    expect(result.current.typingTest.state.status).toBe('finished')
    await flushMicrotasks()

    expect(mockTypingRunLogSave).not.toHaveBeenCalled()
  })

  it('discards the buffer when consent is revoked mid-run, so the finished run is not saved', async () => {
    const { result, rerender } = renderRunLogHook({ consent: true, wordCount: 2 })
    const keymap = buildKeymap()

    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })
    const [firstWord] = result.current.typingTest.state.words
    for (const char of firstWord) {
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
      })
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(), keymap)
      })
      act(() => {
        result.current.typingTest.processKeyEvent(char, false, false, false)
      })
    }
    act(() => {
      result.current.typingTest.processKeyEvent(' ', false, false, false)
    })
    expect(result.current.typingTest.state.status).not.toBe('finished')

    // Consent revoked mid-run — the recorder's buffer must be discarded
    // immediately, before the run goes on to finish.
    rerender({ recordingConsentAccepted: false })

    const [secondWord] = result.current.typingTest.state.words.slice(1)
    for (const char of secondWord) {
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
      })
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(), keymap)
      })
      act(() => {
        result.current.typingTest.processKeyEvent(char, false, false, false)
      })
    }
    expect(result.current.typingTest.state.status).toBe('finished')
    await flushMicrotasks()

    expect(mockTypingRunLogSave).not.toHaveBeenCalled()
  })

  it('does not attribute matrix keystrokes registered while unfocused, but resumes once refocused (P1)', async () => {
    // Two words: the first is typed and submitted entirely while
    // focused, which puts the run solidly mid-'running' (regardless of
    // either word's length) before the unfocused phase — avoids the
    // waiting->running transition edge (see testLabelRef's own gating
    // comment in useInputModes.ts), where the very first keystroke of a
    // run goes untagged for an unrelated, pre-existing reason.
    const { result } = renderRunLogHook({ consent: true, wordCount: 2 })
    const keymap = buildKeymap()

    // Let useInputModes's mount-time "sync saved config" effect settle
    // BEFORE reading any state below — that effect fires exactly once
    // per (re)mount (it's a no-op afterward, since savedTypingTestConfig's
    // reference is stable across this hook's renders) and calls
    // typingTest.setConfig(), which regenerates words/runId asynchronously.
    // Every other test in this suite dodges it by never `await`-ing
    // mid-run (so it never gets a chance to fire until after the run has
    // already finished synchronously); THIS test needs an early `await`
    // to observe the per-minute analytics call while still unfocused, so
    // it must flush the one-time reset up front instead, or it would fire
    // mid-run and reset currentWordIndex/words/runId out from under it.
    await flushMicrotasks()
    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })
    const [word1, word2] = result.current.typingTest.state.words
    for (const char of word1) {
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
      })
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(), keymap)
      })
      act(() => {
        result.current.typingTest.processKeyEvent(char, false, false, false)
      })
    }
    act(() => {
      result.current.typingTest.processKeyEvent(' ', false, false, false)
    })
    expect(result.current.typingTest.state.currentWordIndex).toBe(1)
    expect(result.current.typingTest.state.status).toBe('running')

    // Alt-tab away mid-run: a press on the SAME physical keyboard, typed
    // into an entirely different, unfocused application — must never be
    // attributed to the run log. No processKeyEvent accompanies it (a
    // foreign app's keydown never reaches this app's char handler), so
    // word2's own input is untouched by this.
    act(() => {
      result.current.typingTest.setWindowFocused(false)
    })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
    })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(), keymap)
    })
    await flushMicrotasks()
    // The per-minute analytics pipeline is unaffected by focus.
    expect(mockTypingAnalyticsEvent).toHaveBeenCalled()
    mockTypingAnalyticsEvent.mockClear()

    // Refocus and finish typing word2 (the whole word — nothing of it was
    // consumed above) normally.
    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })
    for (const char of word2) {
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
      })
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(), keymap)
      })
      act(() => {
        result.current.typingTest.processKeyEvent(char, false, false, false)
      })
    }
    expect(result.current.typingTest.state.status).toBe('finished')
    await flushMicrotasks()

    expect(mockTypingRunLogSave).toHaveBeenCalledTimes(1)
    const [, savedLog] = mockTypingRunLogSave.mock.calls[0] as [string, { words: { keystrokes: unknown[] }[] }]
    const totalKeystrokes = savedLog.words.reduce((sum, w) => sum + w.keystrokes.length, 0)
    // The very first char of word1 lands while status is still 'waiting'
    // (untagged — an existing, unrelated trade-off, see testLabelRef's
    // own comment), so exactly `word1.length - 1 + word2.length` presses
    // are attributable in this exact drive pattern. The point of this
    // assertion is that the unfocused press did not add a spurious +1.
    expect(totalKeystrokes).toBe(word1.length - 1 + word2.length)
  })

  it('discards the buffer on pause, so a resumed-then-finished run saves no raw log (P3)', async () => {
    // Pause/resume (memory mode) only exists for imported fileImport
    // text — captureMemory() returns null for every other mode, so
    // pauseTypingTest() is a no-op there. Set up a one-word fileImport
    // text ("hello") the same way useTypingTest.fileImportText.test.ts does.
    const mockGet = vi.fn().mockResolvedValue({
      success: true,
      data: { meta: { id: 't' }, data: { name: 'T', text: 'hello' } },
    })
    window.vialAPI = {
      ...window.vialAPI,
      typingTestTextStoreGet: mockGet,
    } as unknown as typeof window.vialAPI
    await getFileImportTextData('t')

    const onSaveTypingTestResult = vi.fn()
    const onTypingTestMemoryChange = vi.fn()
    const keymap = buildKeymap()
    const { result, rerender } = renderHook(
      ({ savedTypingTestMemory }: { savedTypingTestMemory?: TypingTestMemory }) => useInputModes({
        rows: 1,
        cols: 1,
        keymap,
        unlocked: true,
        typingTestMode: true,
        typingTestViewOnly: false,
        typingRecordKeyboard: sampleKeyboard,
        onSaveTypingTestResult,
        savedTypingTestConfig: { mode: 'fileImport', textId: 't' },
        savedTypingTestMemory,
        onTypingTestMemoryChange,
        recordingConsentAccepted: true,
      }),
      { initialProps: {} },
    )

    await flushMicrotasks()
    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })
    expect(result.current.typingTest.state.words).toEqual(['hello'])

    // Type "he" (2 of 5 chars), then pause.
    for (const char of ['h', 'e']) {
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
      })
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(), keymap)
      })
      act(() => {
        result.current.typingTest.processKeyEvent(char, false, false, false)
      })
    }

    // Pause mid-run — the run-log buffer must be discarded immediately.
    act(() => {
      result.current.pauseTypingTest()
    })
    expect(onTypingTestMemoryChange).toHaveBeenCalled()
    const savedMemory = onTypingTestMemoryChange.mock.calls[0][0] as TypingTestMemory
    expect(savedMemory.currentInput).toBe('he')

    // Feed the captured memory back in (mirrors the real caller
    // persisting it to device prefs and passing it back down) and resume.
    rerender({ savedTypingTestMemory: savedMemory })
    act(() => {
      result.current.resumeTypingTest()
    })
    await flushMicrotasks()

    // Finish the run — the summary result still saves normally (memory
    // mode is unaffected), but no raw keystroke log should ever be sent.
    for (const char of ['l', 'l', 'o']) {
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
      })
      act(() => {
        result.current.typingTest.processMatrixFrame(new Set(), keymap)
      })
      act(() => {
        result.current.typingTest.processKeyEvent(char, false, false, false)
      })
    }
    expect(result.current.typingTest.state.status).toBe('finished')
    await flushMicrotasks()

    expect(onSaveTypingTestResult).toHaveBeenCalled()
    expect(mockTypingRunLogSave).not.toHaveBeenCalled()
  })
})
