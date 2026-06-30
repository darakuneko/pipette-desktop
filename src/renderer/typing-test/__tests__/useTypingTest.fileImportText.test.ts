// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingTest } from '../useTypingTest'
import { getFileImportTextData, clearFileImportTextCache } from '../word-generator'

const mockGet = vi.fn()
const originalVialAPI = window.vialAPI

beforeEach(() => {
  vi.clearAllMocks()
  clearFileImportTextCache()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    typingTestTextStoreGet: mockGet,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  clearFileImportTextCache()
  window.vialAPI = originalVialAPI
})

const type = (result: { current: { processKeyEvent: (k: string, c: boolean, a: boolean, m: boolean) => void } }, key: string): void => {
  act(() => result.current.processKeyEvent(key, false, false, false))
}

describe('useTypingTest — imported fileImport text (line breaks)', () => {
  it('Enter advances at a line break, Space advances within a line; the wrong key is a no-op', async () => {
    // "a b" / "c d" → words [a,b,c,d], line break after index 1 (the word "b").
    mockGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 't' }, data: { name: 'T', text: 'a b\nc d' } },
    })
    // Warm the cache so the hook's synchronous initial state has the words.
    await getFileImportTextData('t')

    const { result } = renderHook(() => useTypingTest({ mode: 'fileImport', textId: 't' }, 'english'))
    expect(result.current.state.words).toEqual(['a', 'b', 'c', 'd'])
    expect([...result.current.state.lineBreaks]).toEqual([1])

    // Word 0 ("a") is mid-line → Space advances, Enter would be a no-op.
    type(result, 'a')
    type(result, 'Enter') // mismatch at a non-line-end word → ignored
    expect(result.current.state.currentWordIndex).toBe(0)
    type(result, ' ')
    expect(result.current.state.currentWordIndex).toBe(1)

    // Word 1 ("b") ends a line → Enter advances, Space is a no-op.
    type(result, 'b')
    type(result, ' ') // mismatch at a line-end word → ignored
    expect(result.current.state.currentWordIndex).toBe(1)
    type(result, 'Enter')
    expect(result.current.state.currentWordIndex).toBe(2)

    // Word 2 ("c") mid-line → Space advances.
    type(result, 'c')
    type(result, ' ')
    expect(result.current.state.currentWordIndex).toBe(3)

    // Last word finishes on the final character (no separator needed).
    type(result, 'd')
    expect(result.current.state.status).toBe('finished')
  })

  it('words mode ignores Enter (line breaks empty) — existing behaviour unchanged', () => {
    const { result } = renderHook(() => useTypingTest({ mode: 'words', wordCount: 5, punctuation: false, numbers: false }, 'english'))
    expect([...result.current.state.lineBreaks]).toEqual([])

    const firstWord = result.current.state.words[0]
    for (const ch of firstWord) type(result, ch)
    type(result, 'Enter') // ignored in words mode
    expect(result.current.state.currentWordIndex).toBe(0)
    type(result, ' ') // Space advances as usual
    expect(result.current.state.currentWordIndex).toBe(1)
  })
})

describe('useTypingTest — memory mode (pause / capture / restore)', () => {
  const setupFileImport = async () => {
    mockGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 't' }, data: { name: 'T', text: 'a b\nc d' } },
    })
    await getFileImportTextData('t')
    return renderHook(() => useTypingTest({ mode: 'fileImport', textId: 't' }, 'english'))
  }

  it('captureMemory snapshots progress; pause freezes and blocks input', async () => {
    const { result } = await setupFileImport()
    type(result, 'a')
    type(result, ' ')
    expect(result.current.state.currentWordIndex).toBe(1)

    const mem = result.current.captureMemory()
    expect(mem).not.toBeNull()
    expect(mem?.textId).toBe('t')
    expect(mem?.currentWordIndex).toBe(1)
    expect(mem?.wordResults).toEqual([{ word: 'a', typed: 'a', correct: true }])
    expect(typeof mem?.elapsedMs).toBe('number')

    act(() => result.current.pause())
    expect(result.current.state.status).toBe('paused')
    // Input is ignored while paused.
    type(result, 'c')
    expect(result.current.state.currentInput).toBe('')
  })

  it('captureMemory returns null for non-fileImport modes', () => {
    const { result } = renderHook(() => useTypingTest({ mode: 'words', wordCount: 5, punctuation: false, numbers: false }, 'english'))
    expect(result.current.captureMemory()).toBeNull()
  })

  it('restoreState(resume=true) continues running at the saved position', async () => {
    const { result } = await setupFileImport()
    const memory = {
      textId: 't', currentWordIndex: 2, currentInput: 'c',
      wordResults: [
        { word: 'a', typed: 'a', correct: true },
        { word: 'b', typed: 'b', correct: true },
      ],
      correctChars: 4, incorrectChars: 0, elapsedMs: 5000, wpmHistory: [10, 20],
      savedAt: new Date(0).toISOString(),
    }
    let ok = false
    await act(async () => { ok = await result.current.restoreState(memory, true) })
    expect(ok).toBe(true)
    expect(result.current.state.status).toBe('running')
    expect(result.current.state.currentWordIndex).toBe(2)
    expect(result.current.state.currentInput).toBe('c')
    expect(result.current.state.wpmHistory).toEqual([10, 20])
  })

  it('restoreState(resume=false) restores the snapshot frozen as paused', async () => {
    const { result } = await setupFileImport()
    const memory = {
      textId: 't', currentWordIndex: 1, currentInput: '',
      wordResults: [{ word: 'a', typed: 'a', correct: true }],
      correctChars: 2, incorrectChars: 0, elapsedMs: 1000, wpmHistory: [],
      savedAt: new Date(0).toISOString(),
    }
    await act(async () => { await result.current.restoreState(memory, false) })
    expect(result.current.state.status).toBe('paused')
    expect(result.current.state.currentWordIndex).toBe(1)
  })
})
