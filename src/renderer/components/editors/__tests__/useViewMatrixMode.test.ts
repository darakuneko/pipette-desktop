// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useViewMatrixMode } from '../useViewMatrixMode'

describe('useViewMatrixMode', () => {
  it('starts inactive with no selection', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    expect(result.current.active).toBe(false)
    expect(result.current.selectedKeys.size).toBe(0)
  })

  it('enter activates the mode', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.enter())
    expect(result.current.active).toBe(true)
  })

  it('exit deactivates the mode and clears the selection', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.enter())
    act(() => result.current.selectKey(1, 2))
    act(() => result.current.exit())
    expect(result.current.active).toBe(false)
    expect(result.current.selectedKeys.size).toBe(0)
  })

  it('toggle flips active state each call', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.toggle())
    expect(result.current.active).toBe(true)
    act(() => result.current.toggle())
    expect(result.current.active).toBe(false)
  })

  it('toggle off clears the selection (mirrors exit)', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.toggle())
    act(() => result.current.selectKey(3, 4))
    act(() => result.current.toggle())
    expect(result.current.active).toBe(false)
    expect(result.current.selectedKeys.size).toBe(0)
  })

  it('selectKey selects exactly the clicked key', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.selectKey(2, 5))
    expect(result.current.selectedKeys).toEqual(new Set(['2,5']))
  })

  it('clearSelection empties the selection without deactivating the mode', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.enter())
    act(() => result.current.selectKey(2, 5))
    act(() => result.current.clearSelection())
    expect(result.current.selectedKeys.size).toBe(0)
    expect(result.current.active).toBe(true)
  })

  it('selectKey replaces a previous selection with the newly clicked key', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.selectKey(1, 1))
    act(() => result.current.selectKey(9, 9))
    expect(result.current.selectedKeys).toEqual(new Set(['9,9']))
  })

  it('toggleKeySelection adds a key not yet in the selection', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.selectKey(0, 0))
    act(() => result.current.toggleKeySelection(0, 1))
    expect(result.current.selectedKeys).toEqual(new Set(['0,0', '0,1']))
  })

  it('toggleKeySelection removes a key already in the selection', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.selectKey(0, 0))
    act(() => result.current.toggleKeySelection(0, 1))
    act(() => result.current.toggleKeySelection(0, 0))
    expect(result.current.selectedKeys).toEqual(new Set(['0,1']))
  })

  it('extendSelection fills a contiguous range from the last anchor using key order', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    const keyOrder = [
      { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 0, col: 3 },
    ]
    act(() => result.current.selectKey(0, 0))
    act(() => result.current.extendSelection(0, 2, keyOrder))
    expect(result.current.selectedKeys).toEqual(new Set(['0,0', '0,1', '0,2']))
  })

  it('extendSelection with no prior anchor falls back to selecting just the clicked key', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    const keyOrder = [{ row: 0, col: 0 }, { row: 0, col: 1 }]
    act(() => result.current.extendSelection(0, 1, keyOrder))
    expect(result.current.selectedKeys).toEqual(new Set(['0,1']))
  })

  it('toggleKeySelection moves the range anchor for a subsequent extendSelection', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    const keyOrder = [
      { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 0, col: 3 },
    ]
    act(() => result.current.selectKey(0, 0))
    act(() => result.current.toggleKeySelection(0, 3))
    act(() => result.current.extendSelection(0, 1, keyOrder))
    // Anchor moved to (0,3) by the last toggle — range 1..3.
    expect(result.current.selectedKeys).toEqual(new Set(['0,1', '0,2', '0,3']))
  })
})
