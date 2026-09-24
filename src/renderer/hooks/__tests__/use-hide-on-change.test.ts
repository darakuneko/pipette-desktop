// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useHideOnChange } from '../use-hide-on-change'

describe('useHideOnChange', () => {
  it('hides on mount', () => {
    const hide = vi.fn()
    renderHook(() => useHideOnChange(hide, [1]))
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('hides again only when a dependency changes', () => {
    const hide = vi.fn()
    const keymap = new Map<string, number>()
    const { rerender } = renderHook(({ layer, map }) => useHideOnChange(hide, [layer, map]), {
      initialProps: { layer: 0, map: keymap },
    })
    hide.mockClear()
    rerender({ layer: 0, map: keymap })
    expect(hide).not.toHaveBeenCalled()
    rerender({ layer: 1, map: keymap })
    expect(hide).toHaveBeenCalledTimes(1)
    rerender({ layer: 1, map: new Map(keymap) })
    expect(hide).toHaveBeenCalledTimes(2)
  })

  it('calls the latest hide when the hide function itself changes', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ hide }) => useHideOnChange(hide, ['x']), { initialProps: { hide: first } })
    rerender({ hide: second })
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
  })
})
