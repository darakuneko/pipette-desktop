// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, renderHook, cleanup } from '@testing-library/react'
import { useInlineRename } from '../useInlineRename'

describe('useInlineRename', () => {
  afterEach(() => {
    cleanup()
  })

  describe('default mode (allowEmpty: false)', () => {
    it('commits a non-empty changed label', () => {
      const { result } = renderHook(() => useInlineRename<number>())

      act(() => result.current.startRename(0, 'Base'))
      act(() => result.current.setEditLabel('Renamed'))

      let commitResult: string | null = null
      act(() => { commitResult = result.current.commitRename(0) })

      expect(commitResult).toBe('Renamed')
      expect(result.current.editingId).toBeNull()
    })

    it('returns null and does not commit when cleared to empty', () => {
      const { result } = renderHook(() => useInlineRename<number>())

      act(() => result.current.startRename(0, 'Base'))
      act(() => result.current.setEditLabel(''))

      let commitResult: string | null = null
      act(() => { commitResult = result.current.commitRename(0) })

      expect(commitResult).toBeNull()
    })

    it('returns null when the value is unchanged', () => {
      const { result } = renderHook(() => useInlineRename<number>())

      act(() => result.current.startRename(0, 'Base'))

      let commitResult: string | null = null
      act(() => { commitResult = result.current.commitRename(0) })

      expect(commitResult).toBeNull()
    })

    it('trims surrounding whitespace before comparing and committing', () => {
      const { result } = renderHook(() => useInlineRename<number>())

      act(() => result.current.startRename(0, 'Base'))
      act(() => result.current.setEditLabel('  Renamed  '))

      let commitResult: string | null = null
      act(() => { commitResult = result.current.commitRename(0) })

      expect(commitResult).toBe('Renamed')
    })

    it('treats a whitespace-only edit as empty and does not commit', () => {
      const { result } = renderHook(() => useInlineRename<number>())

      act(() => result.current.startRename(0, 'Base'))
      act(() => result.current.setEditLabel('   '))

      let commitResult: string | null = null
      act(() => { commitResult = result.current.commitRename(0) })

      expect(commitResult).toBeNull()
    })
  })

  describe('allowEmpty mode', () => {
    it('commits an empty label when it differs from the original', () => {
      const { result } = renderHook(() => useInlineRename<number>({ allowEmpty: true }))

      act(() => result.current.startRename(0, 'XXXXXX'))
      act(() => result.current.setEditLabel(''))

      let commitResult: string | null = null
      act(() => { commitResult = result.current.commitRename(0) })

      expect(commitResult).toBe('')
      expect(result.current.editingId).toBeNull()
    })

    it('returns null when the original was already empty and stays empty', () => {
      const { result } = renderHook(() => useInlineRename<number>({ allowEmpty: true }))

      act(() => result.current.startRename(0, ''))

      let commitResult: string | null = null
      act(() => { commitResult = result.current.commitRename(0) })

      expect(commitResult).toBeNull()
    })

    it('still commits a non-empty changed label', () => {
      const { result } = renderHook(() => useInlineRename<number>({ allowEmpty: true }))

      act(() => result.current.startRename(0, 'Base'))
      act(() => result.current.setEditLabel('Renamed'))

      let commitResult: string | null = null
      act(() => { commitResult = result.current.commitRename(0) })

      expect(commitResult).toBe('Renamed')
    })
  })

  describe('cancelRename / escape / blur guard', () => {
    it('clears editingId without committing on cancelRename', () => {
      const { result } = renderHook(() => useInlineRename<number>())

      act(() => result.current.startRename(0, 'Base'))
      act(() => result.current.setEditLabel('Renamed'))
      act(() => result.current.cancelRename())

      expect(result.current.editingId).toBeNull()
    })

    it('guards a subsequent commitRename call (e.g. blur after Escape) from double-committing', () => {
      const { result } = renderHook(() => useInlineRename<number>())

      act(() => result.current.startRename(0, 'Base'))
      act(() => result.current.setEditLabel('Renamed'))
      act(() => result.current.cancelRename())

      let commitResult: string | null = null
      act(() => { commitResult = result.current.commitRename(0) })

      expect(commitResult).toBeNull()
    })

    it('allows a fresh commitRename to proceed normally after the guard consumes one call', () => {
      const { result } = renderHook(() => useInlineRename<number>())

      act(() => result.current.startRename(0, 'Base'))
      act(() => result.current.setEditLabel('Renamed'))
      act(() => result.current.cancelRename())
      act(() => { result.current.commitRename(0) }) // consumes the guard

      act(() => result.current.startRename(0, 'Base'))
      act(() => result.current.setEditLabel('SecondRename'))

      let commitResult: string | null = null
      act(() => { commitResult = result.current.commitRename(0) })

      expect(commitResult).toBe('SecondRename')
    })
  })

  describe('scheduleFlash', () => {
    it('sets confirmedId after a committed rename, then clears it after the flash duration', () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useInlineRename<number>())

      act(() => result.current.startRename(0, 'Base'))
      act(() => result.current.setEditLabel('Renamed'))
      act(() => { result.current.commitRename(0) })

      act(() => { vi.advanceTimersByTime(0) })
      expect(result.current.confirmedId).toBe(0)

      act(() => { vi.advanceTimersByTime(1200) })
      expect(result.current.confirmedId).toBeNull()

      vi.useRealTimers()
    })
  })

  describe('originalLabel / editLabel exposure', () => {
    it('exposes the original label captured at startRename', () => {
      const { result } = renderHook(() => useInlineRename<number>())

      act(() => result.current.startRename(0, 'Base'))

      expect(result.current.originalLabel).toBe('Base')
      expect(result.current.editLabel).toBe('Base')
    })
  })
})
