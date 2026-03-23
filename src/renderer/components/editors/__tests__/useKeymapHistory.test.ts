// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeymapHistory } from '../useKeymapHistory'
import type { HistoryEntry, SingleHistoryEntry } from '../useKeymapHistory'

const keyEntry = (old: number, neu: number, row = 0, col = 0, layer = 0): SingleHistoryEntry => ({
  kind: 'key', layer, row, col, oldKeycode: old, newKeycode: neu,
})

const encoderEntry = (old: number, neu: number, idx = 0, dir: 0 | 1 = 0, layer = 0): SingleHistoryEntry => ({
  kind: 'encoder', layer, idx, dir, oldKeycode: old, newKeycode: neu,
})

describe('useKeymapHistory', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
    expect(result.current.peekUndo).toBeNull()
    expect(result.current.peekRedo).toBeNull()
  })

  it('push enables undo and clears redo', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    act(() => result.current.push(keyEntry(5, 4)))
    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)
    expect(result.current.peekUndo).toEqual(keyEntry(5, 4))
  })

  it('undo returns entry and enables redo', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    act(() => result.current.push(keyEntry(5, 4)))

    let entry: HistoryEntry | null = null
    act(() => { entry = result.current.undo() })

    expect(entry).toEqual(keyEntry(5, 4))
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)
    expect(result.current.peekRedo).toEqual(keyEntry(5, 4))
  })

  it('redo returns entry and re-enables undo', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    act(() => result.current.push(keyEntry(5, 4)))
    act(() => { result.current.undo() })

    let entry: HistoryEntry | null = null
    act(() => { entry = result.current.redo() })

    expect(entry).toEqual(keyEntry(5, 4))
    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)
  })

  it('new push after undo clears redo stack', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    act(() => result.current.push(keyEntry(5, 4)))
    act(() => result.current.push(keyEntry(4, 6)))
    act(() => { result.current.undo() })
    expect(result.current.canRedo).toBe(true)

    // New operation clears redo
    act(() => result.current.push(keyEntry(4, 7)))
    expect(result.current.canRedo).toBe(false)
  })

  it('multi-step undo/redo', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    act(() => result.current.push(keyEntry(5, 4)))
    act(() => result.current.push(keyEntry(4, 6)))
    act(() => result.current.push(keyEntry(6, 7)))

    let e1: HistoryEntry | null = null
    let e2: HistoryEntry | null = null
    act(() => { e1 = result.current.undo() })
    act(() => { e2 = result.current.undo() })
    expect(e1).toEqual(keyEntry(6, 7))
    expect(e2).toEqual(keyEntry(4, 6))
    expect(result.current.canUndo).toBe(true) // still one left

    // Redo in order
    let r1: HistoryEntry | null = null
    act(() => { r1 = result.current.redo() })
    expect(r1).toEqual(keyEntry(4, 6))
  })

  it('undo on empty returns null', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    let entry: HistoryEntry | null = null
    act(() => { entry = result.current.undo() })
    expect(entry).toBeNull()
  })

  it('redo on empty returns null', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    let entry: HistoryEntry | null = null
    act(() => { entry = result.current.redo() })
    expect(entry).toBeNull()
  })

  it('respects maxHistory limit', () => {
    const { result } = renderHook(() => useKeymapHistory(3))
    act(() => result.current.push(keyEntry(1, 2)))
    act(() => result.current.push(keyEntry(2, 3)))
    act(() => result.current.push(keyEntry(3, 4)))
    act(() => result.current.push(keyEntry(4, 5))) // should evict oldest

    // Only 3 entries remain
    let count = 0
    act(() => { while (result.current.undo()) count++ })
    expect(count).toBe(3)
  })

  it('clear resets both stacks', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    act(() => result.current.push(keyEntry(5, 4)))
    act(() => { result.current.undo() })
    expect(result.current.canRedo).toBe(true)

    act(() => result.current.clear())
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })

  it('supports encoder entries', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    const enc = encoderEntry(10, 20, 1, 1, 2)
    act(() => result.current.push(enc))

    let entry: HistoryEntry | null = null
    act(() => { entry = result.current.undo() })
    expect(entry).toEqual(enc)
  })

  it('supports batch entries', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    const batch: HistoryEntry = {
      kind: 'batch',
      entries: [keyEntry(5, 4, 0, 0), keyEntry(6, 7, 0, 1), encoderEntry(8, 9)],
    }
    act(() => result.current.push(batch))

    let entry: HistoryEntry | null = null
    act(() => { entry = result.current.undo() })
    expect(entry).toEqual(batch)
    if (entry && entry.kind === 'batch') {
      expect(entry.entries).toHaveLength(3)
    }
  })

  it('supports maskPart on key entries', () => {
    const { result } = renderHook(() => useKeymapHistory(100))
    const entry: SingleHistoryEntry = {
      kind: 'key', layer: 0, row: 0, col: 0,
      oldKeycode: 0x0204, newKeycode: 0x0404, maskPart: 'outer',
    }
    act(() => result.current.push(entry))
    expect(result.current.peekUndo).toEqual(entry)
  })
})
