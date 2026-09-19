// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeymapHistoryActions } from '../use-keymap-history-actions'
import { useKeymapHistory } from '../useKeymapHistory'
import { BulkKeyWriteError } from '../../../hooks/useKeyboard'
import type { BulkKeyEntry } from '../../../hooks/useKeyboard'
import type { SingleHistoryEntry } from '../useKeymapHistory'

const keyEntry = (old: number, neu: number, row = 0, col = 0, layer = 0): SingleHistoryEntry => ({
  kind: 'key', layer, row, col, oldKeycode: old, newKeycode: neu,
})

const encoderEntry = (old: number, neu: number, idx = 0, dir: 0 | 1 = 0, layer = 0): SingleHistoryEntry => ({
  kind: 'encoder', layer, idx, dir, oldKeycode: old, newKeycode: neu,
})

type SetKeyFn = (layer: number, row: number, col: number, keycode: number) => Promise<void>
type SetKeysBulkFn = (entries: BulkKeyEntry[]) => Promise<void>
type SetEncoderFn = (layer: number, idx: number, dir: number, keycode: number) => Promise<void>

interface HarnessOverrides {
  onSetKeysBulk?: ReturnType<typeof vi.fn<SetKeysBulkFn>>
  onSetEncoder?: ReturnType<typeof vi.fn<SetEncoderFn>>
}

function renderHarness(overrides: HarnessOverrides = {}) {
  const onSetKey = vi.fn<SetKeyFn>().mockResolvedValue(undefined)
  const onSetKeysBulk = overrides.onSetKeysBulk ?? vi.fn<SetKeysBulkFn>().mockResolvedValue(undefined)
  const onSetEncoder = overrides.onSetEncoder ?? vi.fn<SetEncoderFn>().mockResolvedValue(undefined)
  const onHistoryApplied = vi.fn()
  const closePopoverIfEpochMatches = vi.fn()

  const rendered = renderHook(() => {
    const history = useKeymapHistory(100)
    const actions = useKeymapHistoryActions({
      history,
      popoverState: null,
      currentLayer: 0,
      onSetKey,
      onSetKeysBulk,
      onSetEncoder,
      onHistoryApplied,
      getPopoverEpoch: () => 0,
      closePopoverIfEpochMatches,
    })
    return { history, ...actions }
  })

  /** Pushes one batch entry onto the undo stack, the shape every test here
   *  starts from. */
  function pushBatch(entries: SingleHistoryEntry[]) {
    act(() => rendered.result.current.history.push({ kind: 'batch', entries }))
  }

  return { ...rendered, pushBatch, onSetKey, onSetKeysBulk, onSetEncoder, onHistoryApplied, closePopoverIfEpochMatches }
}

describe('useKeymapHistoryActions — batch undo/redo partial-failure', () => {
  it('a batch undo where BulkKeyWriteError.appliedCount > 0 clears both stacks', async () => {
    const onSetKeysBulk = vi.fn<SetKeysBulkFn>()
    const { result, pushBatch, onHistoryApplied, closePopoverIfEpochMatches } = renderHarness({ onSetKeysBulk })
    pushBatch([keyEntry(1, 4, 0, 0), keyEntry(2, 5, 0, 1), keyEntry(3, 6, 0, 2)])
    expect(result.current.history.canUndo).toBe(true)

    const failure = new BulkKeyWriteError(2, new Error('device write failed'))
    onSetKeysBulk.mockRejectedValueOnce(failure)

    await act(async () => {
      await expect(result.current.handleUndo()).rejects.toBe(failure)
    })

    expect(result.current.history.canUndo).toBe(false)
    expect(result.current.history.canRedo).toBe(false)
    expect(onHistoryApplied).not.toHaveBeenCalled()
    expect(closePopoverIfEpochMatches).not.toHaveBeenCalled()
  })

  it('a batch undo where BulkKeyWriteError.appliedCount === 0 leaves the entry in place for a retry', async () => {
    const onSetKeysBulk = vi.fn<SetKeysBulkFn>()
    const { result, pushBatch, closePopoverIfEpochMatches } = renderHarness({ onSetKeysBulk })
    pushBatch([keyEntry(1, 4, 0, 0), keyEntry(2, 5, 0, 1)])

    const failure = new BulkKeyWriteError(0, new Error('unlock cancelled'))
    onSetKeysBulk.mockRejectedValueOnce(failure)

    await act(async () => {
      await expect(result.current.handleUndo()).rejects.toBe(failure)
    })

    // Nothing landed: the entry (and the in-flight guard) survive untouched.
    expect(result.current.history.canUndo).toBe(true)
    expect(result.current.history.canRedo).toBe(false)
    expect(closePopoverIfEpochMatches).not.toHaveBeenCalled()

    // A retry (this time it succeeds) re-runs the SAME entry — proving the
    // failed attempt never silently popped it — and the in-flight guard was
    // released so this second call actually runs.
    onSetKeysBulk.mockResolvedValueOnce(undefined)
    await act(async () => { await result.current.handleUndo() })

    // Undo replays the batch in reverse order.
    expect(onSetKeysBulk).toHaveBeenLastCalledWith([
      { layer: 0, row: 0, col: 1, keycode: 2 },
      { layer: 0, row: 0, col: 0, keycode: 1 },
    ])
    expect(result.current.history.canUndo).toBe(false)
    expect(result.current.history.canRedo).toBe(true)
    expect(closePopoverIfEpochMatches).toHaveBeenCalledTimes(1)
  })

  it('keys succeed then the encoder write fails: both stacks are cleared', async () => {
    const onSetKeysBulk = vi.fn<SetKeysBulkFn>().mockResolvedValue(undefined)
    const onSetEncoder = vi.fn<SetEncoderFn>()
    const { result, pushBatch, closePopoverIfEpochMatches } = renderHarness({ onSetKeysBulk, onSetEncoder })
    pushBatch([keyEntry(1, 4, 0, 0), encoderEntry(9, 10)])

    const failure = new Error('encoder write failed')
    onSetEncoder.mockRejectedValueOnce(failure)

    await act(async () => {
      await expect(result.current.handleUndo()).rejects.toBe(failure)
    })

    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    expect(result.current.history.canUndo).toBe(false)
    expect(result.current.history.canRedo).toBe(false)
    expect(closePopoverIfEpochMatches).not.toHaveBeenCalled()
  })

  it('the second of two encoder writes failing (no key entries) still counts as landed and clears', async () => {
    const onSetEncoder = vi.fn<SetEncoderFn>()
    const { result, pushBatch, closePopoverIfEpochMatches } = renderHarness({ onSetEncoder })
    pushBatch([encoderEntry(1, 2, 0, 0), encoderEntry(3, 4, 1, 0)])

    const failure = new Error('encoder write failed')
    onSetEncoder.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure)

    await act(async () => {
      await expect(result.current.handleUndo()).rejects.toBe(failure)
    })

    expect(result.current.history.canUndo).toBe(false)
    expect(result.current.history.canRedo).toBe(false)
    expect(closePopoverIfEpochMatches).not.toHaveBeenCalled()
  })

  it('the first of two encoder writes failing (no key entries, nothing landed) leaves the entry in place', async () => {
    const onSetEncoder = vi.fn<SetEncoderFn>()
    const { result, pushBatch, closePopoverIfEpochMatches } = renderHarness({ onSetEncoder })
    pushBatch([encoderEntry(1, 2, 0, 0), encoderEntry(3, 4, 1, 0)])

    const failure = new Error('encoder write failed')
    onSetEncoder.mockRejectedValueOnce(failure)

    await act(async () => {
      await expect(result.current.handleUndo()).rejects.toBe(failure)
    })

    expect(result.current.history.canUndo).toBe(true)
    expect(closePopoverIfEpochMatches).not.toHaveBeenCalled()
  })

  it('the in-flight guard is released after a failed undo, allowing an immediate retry', async () => {
    const onSetKeysBulk = vi.fn<SetKeysBulkFn>()
    const { result, pushBatch, closePopoverIfEpochMatches } = renderHarness({ onSetKeysBulk })
    pushBatch([keyEntry(1, 4, 0, 0)])

    onSetKeysBulk.mockRejectedValueOnce(new BulkKeyWriteError(0, new Error('fail')))
    await act(async () => {
      await expect(result.current.handleUndo()).rejects.toThrow('fail')
    })
    expect(closePopoverIfEpochMatches).not.toHaveBeenCalled()

    onSetKeysBulk.mockResolvedValueOnce(undefined)
    await act(async () => { await result.current.handleUndo() })
    expect(onSetKeysBulk).toHaveBeenCalledTimes(2)
    expect(result.current.history.canRedo).toBe(true)
    expect(closePopoverIfEpochMatches).toHaveBeenCalledTimes(1)
  })

  it('a partial undo failure clears both stacks even when the redo stack already held an entry', async () => {
    const onSetKeysBulk = vi.fn<SetKeysBulkFn>().mockResolvedValue(undefined)
    const { result, pushBatch, closePopoverIfEpochMatches } = renderHarness({ onSetKeysBulk })
    pushBatch([keyEntry(1, 4, 0, 0)])
    pushBatch([keyEntry(2, 5, 0, 1)])

    // Successfully undo the top entry so the redo stack is non-empty while
    // one entry remains on the undo stack.
    await act(async () => { await result.current.handleUndo() })
    expect(result.current.history.canUndo).toBe(true)
    expect(result.current.history.canRedo).toBe(true)

    const failure = new BulkKeyWriteError(1, new Error('device write failed'))
    onSetKeysBulk.mockRejectedValueOnce(failure)

    await act(async () => {
      await expect(result.current.handleUndo()).rejects.toBe(failure)
    })

    expect(result.current.history.canUndo).toBe(false)
    expect(result.current.history.canRedo).toBe(false)
    expect(closePopoverIfEpochMatches).toHaveBeenCalledTimes(1)
  })

  it('a batch redo where BulkKeyWriteError.appliedCount > 0 clears both stacks', async () => {
    const onSetKeysBulk = vi.fn<SetKeysBulkFn>().mockResolvedValue(undefined)
    const { result, pushBatch, closePopoverIfEpochMatches } = renderHarness({ onSetKeysBulk })
    pushBatch([keyEntry(1, 4, 0, 0), keyEntry(2, 5, 0, 1)])
    await act(async () => { await result.current.handleUndo() })
    expect(result.current.history.canRedo).toBe(true)

    const failure = new BulkKeyWriteError(1, new Error('device write failed'))
    onSetKeysBulk.mockRejectedValueOnce(failure)

    await act(async () => {
      await expect(result.current.handleRedo()).rejects.toBe(failure)
    })

    expect(result.current.history.canUndo).toBe(false)
    expect(result.current.history.canRedo).toBe(false)
    expect(closePopoverIfEpochMatches).toHaveBeenCalledTimes(1) // only the earlier successful undo
  })

  it('a batch redo where BulkKeyWriteError.appliedCount === 0 leaves the entry in place for a retry', async () => {
    const onSetKeysBulk = vi.fn<SetKeysBulkFn>().mockResolvedValue(undefined)
    const { result, pushBatch, closePopoverIfEpochMatches } = renderHarness({ onSetKeysBulk })
    pushBatch([keyEntry(1, 4, 0, 0), keyEntry(2, 5, 0, 1)])
    await act(async () => { await result.current.handleUndo() })
    expect(result.current.history.canRedo).toBe(true)
    closePopoverIfEpochMatches.mockClear()

    const failure = new BulkKeyWriteError(0, new Error('unlock cancelled'))
    onSetKeysBulk.mockRejectedValueOnce(failure)

    await act(async () => {
      await expect(result.current.handleRedo()).rejects.toBe(failure)
    })

    // Nothing landed: the redo entry survives untouched for a retry.
    expect(result.current.history.canUndo).toBe(false)
    expect(result.current.history.canRedo).toBe(true)
    expect(closePopoverIfEpochMatches).not.toHaveBeenCalled()

    // A retry re-runs the SAME entry with its forward (new) values, in
    // original order, and this time commits.
    onSetKeysBulk.mockResolvedValueOnce(undefined)
    await act(async () => { await result.current.handleRedo() })

    expect(onSetKeysBulk).toHaveBeenLastCalledWith([
      { layer: 0, row: 0, col: 0, keycode: 4 },
      { layer: 0, row: 0, col: 1, keycode: 5 },
    ])
    expect(result.current.history.canUndo).toBe(true)
    expect(result.current.history.canRedo).toBe(false)
    expect(closePopoverIfEpochMatches).toHaveBeenCalledTimes(1)
  })
})
