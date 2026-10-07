// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDropVanishedEdits } from '../use-drop-vanished-edits'
import { useInlineRename } from '../useInlineRename'

describe('useDropVanishedEdits', () => {
  it('cancels a rename whose row vanished, so a later blur commit submits nothing', () => {
    const { result, rerender } = renderHook(({ ids }) => {
      const rename = useInlineRename<string>()
      useDropVanishedEdits(ids, [{ id: rename.editingId, clear: rename.cancelRename }])
      return rename
    }, { initialProps: { ids: ['a', 'b'] } })

    act(() => { result.current.startRename('a', 'A') })
    act(() => { result.current.setEditLabel('Draft') })
    rerender({ ids: ['b'] })

    expect(result.current.editingId).toBeNull()
    let committed: string | null = 'unset'
    act(() => { committed = result.current.commitRename('a') })
    expect(committed).toBeNull()
  })

  it('keeps edits for rows that are still present and clears only vanished ones', () => {
    const keepClear = vi.fn()
    const goneClear = vi.fn()
    const { rerender } = renderHook(({ ids }) => useDropVanishedEdits(ids, [
      { id: 'a', clear: keepClear },
      { id: 'b', clear: goneClear },
      { id: null, clear: goneClear },
    ]), { initialProps: { ids: ['a', 'b'] } })

    rerender({ ids: ['a'] })

    expect(keepClear).not.toHaveBeenCalled()
    expect(goneClear).toHaveBeenCalledTimes(1)
  })
})
