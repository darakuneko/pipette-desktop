// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { createRef } from 'react'
import type { KeymapApplyResult } from '../keymap-editor-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

let capturedWidgetProps: Array<Record<string, unknown>> = []

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: Record<string, unknown>) => {
    capturedWidgetProps.push(props)
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: () => <div data-testid="tabbed-keycodes">TabbedKeycodes</div>,
}))

// Same mock shape as KeymapEditor-pickerPaste.test.tsx, extended with the
// three range predicates `rewriteNumericKeycode` (shared/keymap/keymap-apply.ts)
// calls unconditionally for every keymap/encoder entry. Forcing all three to
// `false` routes every rewrite through the "plain keycode" path — the
// composite (LSFT/LT/MT) inner-swap math already has dedicated coverage
// against the real keycodes module in shared/keymap/__tests__/keymap-apply.test.ts,
// so this suite only needs to prove the wiring (history / sequencing /
// partial-failure), not re-derive the numeric algorithm.
vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: (val: string | number) => {
    if (typeof val === 'number') return val
    const m = /^KC_(\d+)$/.exec(val)
    return m ? Number(m[1]) : 0
  },
  isMask: () => false,
  isTapDanceKeycode: () => false,
  getTapDanceIndex: () => -1,
  isMacroKeycode: () => false,
  getMacroIndex: () => -1,
  keycodeLabel: (qmkId: string) => qmkId,
  keycodeTooltip: (qmkId: string) => qmkId,
  isResetKeycode: () => false,
  isModifiableKeycode: () => false,
  isModTapKeycode: () => false,
  isLTKeycode: () => false,
  isModMaskKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
  findKeycode: (qmkId: string) => ({ qmkId, label: qmkId }),
}))

vi.mock('../../keycodes/ModifierCheckboxStrip', () => ({
  ModifierCheckboxStrip: () => null,
}))

vi.mock('../../../../preload/macro', () => ({
  deserializeAllMacros: () => [],
}))

import { KeymapEditor } from '../KeymapEditor'
import type { KeymapEditorHandle } from '../keymap-editor-types'
import type { KleKey } from '../../../../shared/kle/types'

const KEY_DEFAULTS: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
}

const makeKey = (x: number, col: number): KleKey => ({ ...KEY_DEFAULTS, x, col })
const makeLayout = () => ({ keys: [makeKey(0, 0), makeKey(1, 1)] })

describe('KeymapEditor — applyKeymapRewrite (Key Label apply-to-keymap)', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetKeysBulk = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)

  const defaultProps = {
    layout: makeLayout(),
    layers: 1,
    currentLayer: 0,
    keymap: new Map([
      ['0,0,0', 5], // KC_5 — present in the table, gets rewritten
      ['0,0,1', 6], // KC_6 — absent from the table, left untouched
    ]),
    encoderLayout: new Map([['0,0,0', 7]]), // KC_7 — present in the table
    encoderCount: 1,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk,
    onSetEncoder,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    onSetKey.mockResolvedValue(undefined)
    onSetKeysBulk.mockResolvedValue(undefined)
    onSetEncoder.mockResolvedValue(undefined)
    capturedWidgetProps = []
  })

  interface CapturedFlash { keys: Set<string>; generation: number; startedAt: number }

  function lastFlash(): CapturedFlash | undefined {
    const widget = capturedWidgetProps[capturedWidgetProps.length - 1]
    return widget?.flash as CapturedFlash | undefined
  }

  function lastFlashKeys(): Set<string> | undefined {
    return lastFlash()?.keys
  }

  it('rewrites only the keys/encoders present in the table and pushes one batch history entry', async () => {
    const ref = createRef<KeymapEditorHandle>()
    render(<KeymapEditor ref={ref} {...defaultProps} />)

    const table = new Map([
      ['KC_5', 'KC_50'],
      ['KC_7', 'KC_70'],
    ])

    let result
    await act(async () => {
      result = await ref.current!.applyKeymapRewrite(table)
    })

    expect(result).toEqual({ appliedCount: 2 })
    expect(onSetKey).toHaveBeenCalledTimes(1)
    expect(onSetKey).toHaveBeenCalledWith(0, 0, 0, 50)
    expect(onSetEncoder).toHaveBeenCalledWith(0, 0, 0, 70)

    // The rewrite lands on the SAME undo stack as manual edits: Ctrl+Z
    // reverts through the editor's own batch-undo path (onSetKeysBulk for
    // keys, onSetEncoder loop for encoders) exactly like a copy/paste batch.
    onSetKey.mockClear()
    onSetKeysBulk.mockClear()
    onSetEncoder.mockClear()

    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }) })

    expect(onSetKeysBulk).toHaveBeenCalledWith([{ layer: 0, row: 0, col: 0, keycode: 5 }])
    expect(onSetEncoder).toHaveBeenCalledWith(0, 0, 0, 7)
  })

  it('returns a no-op result when nothing in the table matches the current keymap', async () => {
    const ref = createRef<KeymapEditorHandle>()
    render(<KeymapEditor ref={ref} {...defaultProps} />)

    let result
    await act(async () => {
      result = await ref.current!.applyKeymapRewrite(new Map([['KC_999', 'KC_1']]))
    })

    expect(result).toEqual({ appliedCount: 0 })
    expect(onSetKey).not.toHaveBeenCalled()
    expect(onSetEncoder).not.toHaveBeenCalled()
  })

  it('stops at the first failing write and keeps only the successful entries in history', async () => {
    let calls = 0
    onSetKey.mockImplementation(async () => {
      calls++
      if (calls === 2) throw new Error('device write failed')
    })

    const ref = createRef<KeymapEditorHandle>()
    render(<KeymapEditor ref={ref} {...defaultProps} />)

    const table = new Map([
      ['KC_5', 'KC_50'],
      ['KC_6', 'KC_60'],
    ])

    let result
    await act(async () => {
      result = await ref.current!.applyKeymapRewrite(table)
    })

    expect(result).toEqual({ appliedCount: 1, error: 'device write failed' })
    // Encoder write never runs — the loop stops as soon as the key write throws.
    expect(onSetEncoder).not.toHaveBeenCalled()

    onSetKeysBulk.mockClear()
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }) })

    // Only the one successful write ([0,0,0]) is undo-able — [0,0,1] never
    // made it into the batch entry because its write threw.
    expect(onSetKeysBulk).toHaveBeenCalledWith([{ layer: 0, row: 0, col: 0, keycode: 5 }])
  })

  it('no-ops a re-entrant Apply instead of interleaving with an in-flight one', async () => {
    const ref = createRef<KeymapEditorHandle>()
    render(<KeymapEditor ref={ref} {...defaultProps} />)

    const table = new Map([
      ['KC_5', 'KC_50'],
      ['KC_7', 'KC_70'],
    ])

    let result1: KeymapApplyResult | undefined
    let result2: KeymapApplyResult | undefined
    await act(async () => {
      // Both calls fire synchronously (no await between them) so the second
      // lands while the first is still mid-flight, past its guard check but
      // before its first `await onSetKey` resolves.
      const p1 = ref.current!.applyKeymapRewrite(table)
      const p2 = ref.current!.applyKeymapRewrite(table)
      ;[result1, result2] = await Promise.all([p1, p2])
    })

    expect(result1).toEqual({ appliedCount: 2 })
    expect(result2).toEqual({ appliedCount: 0 })
    // Only the first call's writes happened — the second never touched onSetKey/onSetEncoder.
    expect(onSetKey).toHaveBeenCalledTimes(1)
    expect(onSetEncoder).toHaveBeenCalledTimes(1)
  })

  it('skips a position a concurrent edit already moved, and excludes it from the batch entry', async () => {
    const ref = createRef<KeymapEditorHandle>()
    const { rerender } = render(<KeymapEditor ref={ref} {...defaultProps} />)

    // Simulates a concurrent edit landing on [0,0,1] while the rewrite's
    // write to [0,0,0] is in flight: the mock mutates the live `keymap`
    // prop (via rerender) as a side effect of the first onSetKey call,
    // before the loop reaches the second position.
    const concurrentlyEditedKeymap = new Map([
      ['0,0,0', 50], // as if this rewrite's own first write had already landed
      ['0,0,1', 999], // moved away from the snapshot's oldKeycode (6) by someone else
    ])
    onSetKey.mockImplementation(async (_layer: number, row: number, col: number) => {
      if (row === 0 && col === 0) {
        act(() => {
          rerender(<KeymapEditor ref={ref} {...defaultProps} keymap={concurrentlyEditedKeymap} />)
        })
      }
    })

    const table = new Map([
      ['KC_5', 'KC_50'],
      ['KC_6', 'KC_60'],
    ])

    // Deliberately not wrapped in the test's usual `act(async () => ...)`:
    // the mock's own nested `act(() => rerender(...))` needs to flush
    // synchronously between the two writes, which an enclosing async act()
    // would otherwise defer until this whole call resolves.
    const result = await ref.current!.applyKeymapRewrite(table)

    // [0,0,0] wrote normally; [0,0,1] was skipped once its live value no
    // longer matched the snapshot's oldKeycode (6 -> 999).
    expect(result).toEqual({ appliedCount: 1 })
    expect(onSetKey).toHaveBeenCalledTimes(1)
    expect(onSetKey).toHaveBeenCalledWith(0, 0, 0, 50)

    // Flush the re-render `history.push`'s internal `setVersion` bump
    // scheduled (skipped above by deliberately not wrapping the call in
    // `act()`) before reading history back out via Ctrl+Z.
    await act(async () => {})

    onSetKeysBulk.mockClear()
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }) })

    // The batch entry contains only [0,0,0] — the skipped [0,0,1] never
    // entered history, so undo cannot clobber the concurrent edit sitting there.
    expect(onSetKeysBulk).toHaveBeenCalledWith([{ layer: 0, row: 0, col: 0, keycode: 5 }])
  })

  // --- 追加要求 (2026-07-18): appliedKeymapLayout bookkeeping ---

  describe('layoutIds bookkeeping (appliedKeymapLayout)', () => {
    it('persists appliedKeymapLayout immediately on a successful rewrite, and reverts/reapplies on undo/redo', async () => {
      const onAppliedKeymapLayoutChange = vi.fn()
      const ref = createRef<KeymapEditorHandle>()
      render(<KeymapEditor ref={ref} {...defaultProps} onAppliedKeymapLayoutChange={onAppliedKeymapLayoutChange} />)

      const table = new Map([
        ['KC_5', 'KC_50'],
        ['KC_7', 'KC_70'],
      ])

      let result
      await act(async () => {
        result = await ref.current!.applyKeymapRewrite(table, { before: 'qwerty', after: 'colemak-id' })
      })
      expect(result).toEqual({ appliedCount: 2 })
      // Fired immediately by the initial apply — not by undo/redo yet.
      expect(onAppliedKeymapLayoutChange).toHaveBeenCalledTimes(1)
      expect(onAppliedKeymapLayoutChange).toHaveBeenLastCalledWith('colemak-id')

      onAppliedKeymapLayoutChange.mockClear()
      await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }) })
      // Undo of the rewrite batch reverts appliedKeymapLayout to "before".
      expect(onAppliedKeymapLayoutChange).toHaveBeenCalledWith('qwerty')

      onAppliedKeymapLayoutChange.mockClear()
      await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true }) })
      // Redo re-applies the batch, moving appliedKeymapLayout forward again.
      expect(onAppliedKeymapLayoutChange).toHaveBeenCalledWith('colemak-id')
    })

    it('does not call onAppliedKeymapLayoutChange when applyKeymapRewrite is called without layoutIds', async () => {
      const onAppliedKeymapLayoutChange = vi.fn()
      const ref = createRef<KeymapEditorHandle>()
      render(<KeymapEditor ref={ref} {...defaultProps} onAppliedKeymapLayoutChange={onAppliedKeymapLayoutChange} />)

      await act(async () => {
        await ref.current!.applyKeymapRewrite(new Map([['KC_5', 'KC_50']]))
      })
      expect(onAppliedKeymapLayoutChange).not.toHaveBeenCalled()

      onAppliedKeymapLayoutChange.mockClear()
      await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }) })
      // The plain batch that was undone carries neither appliedLayoutBefore
      // nor appliedLayoutAfter, so undo must not touch the callback either.
      expect(onAppliedKeymapLayoutChange).not.toHaveBeenCalled()
    })

    it('does not persist appliedKeymapLayout when the rewrite matches nothing (no batch pushed)', async () => {
      const onAppliedKeymapLayoutChange = vi.fn()
      const ref = createRef<KeymapEditorHandle>()
      render(<KeymapEditor ref={ref} {...defaultProps} onAppliedKeymapLayoutChange={onAppliedKeymapLayoutChange} />)

      let result
      await act(async () => {
        result = await ref.current!.applyKeymapRewrite(new Map([['KC_999', 'KC_1']]), { before: 'qwerty', after: 'colemak-id' })
      })
      expect(result).toEqual({ appliedCount: 0 })
      expect(onAppliedKeymapLayoutChange).not.toHaveBeenCalled()
    })

    it('partial-failure rewrite (some writes succeeded before an error): the pushed batch omits appliedLayoutBefore/After and onAppliedKeymapLayoutChange is never fired', async () => {
      const onAppliedKeymapLayoutChange = vi.fn()
      let calls = 0
      onSetKey.mockImplementation(async () => {
        calls++
        if (calls === 2) throw new Error('device write failed')
      })

      const ref = createRef<KeymapEditorHandle>()
      render(<KeymapEditor ref={ref} {...defaultProps} onAppliedKeymapLayoutChange={onAppliedKeymapLayoutChange} />)

      const table = new Map([
        ['KC_5', 'KC_50'],
        ['KC_6', 'KC_60'],
      ])

      let result
      await act(async () => {
        result = await ref.current!.applyKeymapRewrite(table, { before: 'qwerty', after: 'colemak-id' })
      })
      // One write succeeded before the second one threw — a batch IS
      // pushed (there's something to undo), but it must not claim the
      // keymap now matches 'colemak-id': it's a mix of old and new keys.
      expect(result).toEqual({ appliedCount: 1, error: 'device write failed' })
      expect(onAppliedKeymapLayoutChange).not.toHaveBeenCalled()

      onSetKeysBulk.mockClear()
      await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }) })
      // Undo still correctly reverts the one successful write via the
      // plain (non-bookkept) batch path...
      expect(onSetKeysBulk).toHaveBeenCalledWith([{ layer: 0, row: 0, col: 0, keycode: 5 }])
      // ...and, because that batch carries neither appliedLayoutBefore nor
      // appliedLayoutAfter, undoing it never touches appliedKeymapLayout —
      // it's left at whatever it was before this failed rewrite attempt.
      expect(onAppliedKeymapLayoutChange).not.toHaveBeenCalled()
    })
  })

  // --- Post-apply flash (`flash`: KeyFlashState) ---

  describe('post-apply flash (flash: KeyFlashState)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('flashes the rewritten key positions on the current layer, then clears after the key-flash keyframe duration (1300ms)', async () => {
      vi.useFakeTimers()
      const ref = createRef<KeymapEditorHandle>()
      render(<KeymapEditor ref={ref} {...defaultProps} />)

      const table = new Map([
        ['KC_5', 'KC_50'],
        ['KC_7', 'KC_70'],
      ])

      await act(async () => {
        await ref.current!.applyKeymapRewrite(table)
      })

      // [0,0,0] was rewritten — flash carries its "row,col" position.
      // The encoder rewrite at [0,0,0] is NOT reflected here: flash isn't
      // threaded to EncoderWidget (see KeyboardWidget's `KeyFlashState` doc).
      expect(lastFlashKeys()).toEqual(new Set(['0,0']))

      // Matches style.css's `key-flash` keyframe (1300ms total) exactly,
      // so the overlay is never unmounted mid-fade.
      act(() => { vi.advanceTimersByTime(1300) })
      expect(lastFlash()).toBeUndefined()
    })

    it('does not populate flash when the rewrite matches nothing', async () => {
      vi.useFakeTimers()
      const ref = createRef<KeymapEditorHandle>()
      render(<KeymapEditor ref={ref} {...defaultProps} />)

      await act(async () => {
        await ref.current!.applyKeymapRewrite(new Map([['KC_999', 'KC_1']]))
      })

      expect(lastFlash()).toBeUndefined()
    })

    it('does not populate flash on a partial-failure apply', async () => {
      vi.useFakeTimers()
      let calls = 0
      onSetKey.mockImplementation(async () => {
        calls++
        if (calls === 2) throw new Error('device write failed')
      })

      const ref = createRef<KeymapEditorHandle>()
      render(<KeymapEditor ref={ref} {...defaultProps} />)

      const table = new Map([
        ['KC_5', 'KC_50'],
        ['KC_6', 'KC_60'],
      ])

      const result = await ref.current!.applyKeymapRewrite(table)
      expect(result).toEqual({ appliedCount: 1, error: 'device write failed' })
      expect(lastFlash()).toBeUndefined()
    })

    it('re-slices flash.keys to the newly-selected layer when the layer changes mid-window, keeping the same generation/startedAt', async () => {
      vi.useFakeTimers()
      const ref = createRef<KeymapEditorHandle>()
      const { rerender } = render(<KeymapEditor ref={ref} {...defaultProps} layers={2} />)

      const table = new Map([['KC_5', 'KC_50']])
      await act(async () => {
        await ref.current!.applyKeymapRewrite(table)
      })
      expect(lastFlashKeys()).toEqual(new Set(['0,0']))
      const { generation, startedAt } = lastFlash()!

      // Switch to layer 1, which had nothing rewritten — the derived set
      // should reflect the newly-current layer, not freeze at apply time,
      // but it's still the SAME apply event: generation/startedAt must
      // carry through unchanged so a late-mounted overlay on layer 1
      // (were anything there to flash) would sync to the same timeline.
      rerender(<KeymapEditor ref={ref} {...defaultProps} layers={2} currentLayer={1} />)
      expect(lastFlash()).toBeUndefined()

      rerender(<KeymapEditor ref={ref} {...defaultProps} layers={2} currentLayer={0} />)
      expect(lastFlash()).toEqual({ keys: new Set(['0,0']), generation, startedAt })
    })

    it('bumps the generation and refreshes startedAt on a second successful apply', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)
      const ref = createRef<KeymapEditorHandle>()
      render(<KeymapEditor ref={ref} {...defaultProps} />)

      await act(async () => {
        await ref.current!.applyKeymapRewrite(new Map([['KC_5', 'KC_50']]))
      })
      const first = lastFlash()!
      expect(first.generation).toBe(1)
      expect(first.startedAt).toBe(1_000_000)

      // Let the first flash's timer fire, then advance the clock and
      // apply again — a fresh apply event must get its own generation
      // and its own wall-clock start time, not reuse the first one's.
      act(() => { vi.advanceTimersByTime(1300) })
      expect(lastFlash()).toBeUndefined()

      // The mocked `onSetKey` doesn't mutate the `keymap` prop (this test
      // never rerenders with an updated map), so the same table still
      // finds [0,0,0]'s value unchanged from the first apply — reapplying
      // it is enough to prove a second successful apply gets its own
      // generation/startedAt, independent of what actually changed.
      vi.setSystemTime(1_010_000)
      await act(async () => {
        await ref.current!.applyKeymapRewrite(new Map([['KC_5', 'KC_50']]))
      })
      const second = lastFlash()!
      expect(second.generation).toBe(2)
      expect(second.startedAt).toBe(1_010_000)
    })
  })
})
