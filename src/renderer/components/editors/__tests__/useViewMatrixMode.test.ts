// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useViewMatrixMode } from '../useViewMatrixMode'

describe('useViewMatrixMode', () => {
  it('starts inactive with no editing key', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    expect(result.current.active).toBe(false)
    expect(result.current.editingKey).toBeNull()
  })

  it('enter activates the mode', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.enter())
    expect(result.current.active).toBe(true)
  })

  it('exit deactivates the mode and closes the editor', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.enter())
    act(() => result.current.openEditor(1, 2))
    act(() => result.current.exit())
    expect(result.current.active).toBe(false)
    expect(result.current.editingKey).toBeNull()
  })

  it('toggle flips active state each call', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.toggle())
    expect(result.current.active).toBe(true)
    act(() => result.current.toggle())
    expect(result.current.active).toBe(false)
  })

  it('toggle off clears an open editor (mirrors exit)', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.toggle())
    act(() => result.current.openEditor(3, 4))
    act(() => result.current.toggle())
    expect(result.current.active).toBe(false)
    expect(result.current.editingKey).toBeNull()
  })

  it('openEditor sets the editing key position', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.openEditor(2, 5))
    expect(result.current.editingKey).toEqual({ row: 2, col: 5 })
  })

  it('closeEditor clears the editing key without deactivating the mode', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.enter())
    act(() => result.current.openEditor(2, 5))
    act(() => result.current.closeEditor())
    expect(result.current.editingKey).toBeNull()
    expect(result.current.active).toBe(true)
  })

  it('openEditor replaces a previously open editor key', () => {
    const { result } = renderHook(() => useViewMatrixMode())
    act(() => result.current.openEditor(1, 1))
    act(() => result.current.openEditor(9, 9))
    expect(result.current.editingKey).toEqual({ row: 9, col: 9 })
  })
})
