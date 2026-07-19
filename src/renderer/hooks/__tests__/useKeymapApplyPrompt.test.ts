// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useKeymapApplyPrompt, type UseKeymapApplyPromptOptions } from '../useKeymapApplyPrompt'
import { buildKeymapRewriteTable, type KeymapRewriteLayoutIds } from '../../../shared/keymap/keymap-apply'
import { BUILTIN_QWERTY_LAYOUT_ID } from '../../data/keyboard-layouts'

// Real rewrite-table engine (not mocked) — this suite exercises the
// WYSIWYG select semantics from Plan-qwerty-select-no-rewrite: the target
// table is always the selected pack's own table, never composed with
// whatever is currently applied. Real Colemak / Dvorak fixtures, same as
// shared/keymap/__tests__/keymap-apply.test.ts.
const COLEMAK: Record<string, string> = {
  KC_E: 'F', KC_R: 'P', KC_T: 'G', KC_Y: 'J', KC_U: 'L', KC_I: 'U', KC_O: 'Y',
  KC_P: ';', KC_S: 'R', KC_D: 'S', KC_F: 'T', KC_G: 'D', KC_J: 'N', KC_K: 'E',
  KC_L: 'I', KC_SCOLON: 'O', KC_N: 'K',
}
// Closed Dvorak map (see shared/keymap/__tests__/keymap-apply.test.ts for
// why the two extra entries vs. the raw Hub pack are required).
const DVORAK: Record<string, string> = {
  KC_Q: "'", KC_W: ',', KC_E: '.', KC_R: 'P', KC_T: 'Y', KC_Y: 'F', KC_U: 'G',
  KC_I: 'C', KC_O: 'R', KC_P: 'L', KC_LBRACKET: '/', KC_RBRACKET: '=',
  KC_A: 'A', KC_S: 'O', KC_D: 'E', KC_F: 'U', KC_G: 'I', KC_H: 'D', KC_J: 'H',
  KC_K: 'T', KC_L: 'N', KC_SCOLON: 'S', KC_QUOTE: '-', KC_Z: ';', KC_X: 'Q',
  KC_C: 'J', KC_V: 'K', KC_B: 'X', KC_N: 'B', KC_M: 'M', KC_COMMA: 'W',
  KC_DOT: 'V', KC_SLASH: 'Z', KC_MINUS: '[', KC_EQUAL: ']',
}
// A pack whose map is a shift-pair display style, not a permutation — fails
// buildKeymapRewriteTable the same way sample-packs/key-labels' Japanese
// QWERTY packs do (see shared/keymap/__tests__/keymap-apply.test.ts).
const NOT_APPLICABLE: Record<string, string> = { KC_2: '"\n2' }

interface FakeEntry {
  name: string
  map: Record<string, string>
  keymapApplicable: boolean
}

const registry = new Map<string, FakeEntry>()

const lookup = {
  ensure: vi.fn(async (_id: string) => {}),
  getName: vi.fn((id: string) => registry.get(id)?.name ?? id),
  getMap: vi.fn((id: string) => registry.get(id)?.map),
  getCompositeLabels: vi.fn(() => undefined),
  getKeymapApplicable: vi.fn((id: string) => registry.get(id)?.keymapApplicable === true),
}

vi.mock('../useKeyLabelLookup', () => ({
  useKeyLabelLookup: () => lookup,
}))

function colemakTable() {
  const result = buildKeymapRewriteTable(COLEMAK)
  if (!result.ok) throw new Error('fixture map failed to build')
  return result.table
}

function dvorakTable() {
  const result = buildKeymapRewriteTable(DVORAK)
  if (!result.ok) throw new Error('fixture map failed to build')
  return result.table
}

describe('useKeymapApplyPrompt — WYSIWYG select semantics (Plan-qwerty-select-no-rewrite)', () => {
  const onKeyboardLayoutChange = vi.fn()
  const onApplyKeymapRewrite = vi.fn().mockResolvedValue({ appliedCount: 2 })

  beforeEach(() => {
    vi.clearAllMocks()
    registry.clear()
    registry.set('colemak-id', { name: 'Colemak', map: COLEMAK, keymapApplicable: true })
    registry.set('dvorak-id', { name: 'Dvorak', map: DVORAK, keymapApplicable: true })
    registry.set('not-applicable-id', { name: 'Not Applicable', map: NOT_APPLICABLE, keymapApplicable: true })
    onApplyKeymapRewrite.mockResolvedValue({ appliedCount: 2 })
  })

  function setup(opts: Partial<UseKeymapApplyPromptOptions> & { keyboardLayout: string }) {
    return renderHook((props: Partial<UseKeymapApplyPromptOptions> & { keyboardLayout: string }) => useKeymapApplyPrompt({
      keymapEditable: true,
      onKeyboardLayoutChange,
      onApplyKeymapRewrite,
      ...props,
    }), { initialProps: opts })
  }

  // --- A1: QWERTY is always inert ---

  it('A1: selecting QWERTY switches display only, even with a different arrangement applied', async () => {
    const { result } = setup({ keyboardLayout: 'colemak-id', appliedKeymapLayout: 'colemak-id' })
    act(() => result.current.handleKeyboardLayoutChange(BUILTIN_QWERTY_LAYOUT_ID))
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID))
    expect(result.current.pendingApply).toBeNull()
    expect(onApplyKeymapRewrite).not.toHaveBeenCalled()
    expect(lookup.ensure).not.toHaveBeenCalled()
  })

  it('A1: selecting QWERTY closes an already-open confirm modal instead of applying it', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty', appliedKeymapLayout: 'colemak-id' })
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => result.current.handleKeyboardLayoutChange(BUILTIN_QWERTY_LAYOUT_ID))
    expect(result.current.pendingApply).toBeNull()
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID)
    expect(onApplyKeymapRewrite).not.toHaveBeenCalled()
  })

  // --- A2: same-value re-selection is the only guard ---

  it('A2: re-selecting the current select value is display-only, no modal, no lookup', async () => {
    const { result } = setup({ keyboardLayout: 'colemak-id', appliedKeymapLayout: 'colemak-id' })
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id'))
    expect(result.current.pendingApply).toBeNull()
    expect(lookup.ensure).not.toHaveBeenCalled()
  })

  // --- A3: non-eligible pack falls through to a plain display switch ---

  it('A3: a pack that is not keymapApplicable falls back to a display-only switch', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('not-applicable-id'))
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('not-applicable-id'))
    expect(result.current.pendingApply).toBeNull()
  })

  // --- A4: applicable pack prompts, Confirm applies its own (uncomposed) table ---

  it('A4: an applicable pack different from the current select prompts, and Confirm applies its own table', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty', appliedKeymapLayout: 'colemak-id' })
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).toEqual({ id: 'dvorak-id', name: 'Dvorak' }))
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1))
    const [table, layoutIds] = onApplyKeymapRewrite.mock.calls[0] as [Map<string, string>, KeymapRewriteLayoutIds]
    // The applied table is Dvorak's own table, unmodified by whatever is
    // (or was) applied — no compose with the Colemak base.
    expect(table).toEqual(dvorakTable())
    expect(layoutIds).toEqual({ before: 'colemak-id', after: 'dvorak-id' })
    // The applied arrangement stays selected — no forced QWERTY reset.
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('dvorak-id'))
    expect(onKeyboardLayoutChange).not.toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID)
  })

  it('A4: `before` is read at Confirm time from the latest appliedKeymapLayout', async () => {
    const { result, rerender } = setup({ keyboardLayout: 'qwerty', appliedKeymapLayout: 'colemak-id' })
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    // appliedKeymapLayout changes (e.g. an undo/redo elsewhere) while the
    // modal is still open, before the user clicks Apply.
    rerender({ keyboardLayout: 'qwerty', appliedKeymapLayout: BUILTIN_QWERTY_LAYOUT_ID })

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1))
    const [, layoutIds] = onApplyKeymapRewrite.mock.calls[0] as [unknown, KeymapRewriteLayoutIds]
    expect(layoutIds).toEqual({ before: BUILTIN_QWERTY_LAYOUT_ID, after: 'dvorak-id' })
  })

  // --- A5 / A6: Display Only / Cancel are unaffected ---

  it('A5: Display Only switches display straight to the target id without rewriting', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => result.current.handleApplyDisplayOnly())
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id')
    expect(onApplyKeymapRewrite).not.toHaveBeenCalled()
    expect(result.current.pendingApply).toBeNull()
  })

  it('A6: Cancel closes the modal without touching the select or the keymap', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => result.current.handleApplyCancel())
    expect(result.current.pendingApply).toBeNull()
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    expect(onApplyKeymapRewrite).not.toHaveBeenCalled()
  })

  // --- A7: appliedKeymapLayout matching the target no longer blocks the prompt ---

  it('A7: appliedKeymapLayout === target but keyboardLayout !== target still offers the modal (direct re-apply)', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty', appliedKeymapLayout: 'colemak-id' })
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    await waitFor(() => expect(result.current.pendingApply).toEqual({ id: 'colemak-id', name: 'Colemak' }))

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1))
    const [table] = onApplyKeymapRewrite.mock.calls[0] as [Map<string, string>, KeymapRewriteLayoutIds]
    expect(table).toEqual(colemakTable())
  })

  // --- C1 / C2: apply-result handling is unchanged ---

  it('C1: partial failure leaves the select untouched and surfaces the error', async () => {
    onApplyKeymapRewrite.mockResolvedValueOnce({ appliedCount: 1, error: 'device write failed' })
    const { result } = setup({ keyboardLayout: 'qwerty', appliedKeymapLayout: 'colemak-id' })
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(result.current.applyError).toBe('device write failed'))
    // The keymap is now a mix of old and new characters that matches
    // neither arrangement, so the display selection is left as-is.
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    expect(result.current.pendingApply).toBeNull()
  })

  it('C2: a zero-count success (nothing actually needed rewriting) still switches the select — count-gating is KeymapEditor\'s job, not this hook\'s', async () => {
    onApplyKeymapRewrite.mockResolvedValueOnce({ appliedCount: 0 })
    const { result } = setup({ keyboardLayout: 'qwerty', appliedKeymapLayout: 'colemak-id' })
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('dvorak-id'))
    expect(result.current.applyError).toBeNull()
  })

  // --- Selection race ---

  it('race: selecting QWERTY while an applicable pack lookup is still in flight never opens a modal', async () => {
    let resolveEnsure!: () => void
    lookup.ensure.mockImplementationOnce(() => new Promise<void>((res) => { resolveEnsure = res }))

    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    act(() => result.current.handleKeyboardLayoutChange(BUILTIN_QWERTY_LAYOUT_ID))

    // The stale colemak-id lookup resolves after the user has already
    // moved on to QWERTY — it must not open the modal retroactively.
    resolveEnsure()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(result.current.pendingApply).toBeNull()
    expect(onKeyboardLayoutChange).toHaveBeenCalledTimes(1)
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID)
  })

  it('selection race: a newer non-QWERTY selection wins even if the OLDER one\'s lookup resolves later', async () => {
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const firstEnsure = new Promise<void>((res) => { resolveFirst = res })
    const secondEnsure = new Promise<void>((res) => { resolveSecond = res })
    lookup.ensure
      .mockImplementationOnce(() => firstEnsure)
      .mockImplementationOnce(() => secondEnsure)

    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))

    // The NEWER (second) selection's lookup resolves first.
    resolveSecond()
    await waitFor(() => expect(result.current.pendingApply).toEqual({ id: 'dvorak-id', name: 'Dvorak' }))

    // The OLDER (first, now-stale) selection's lookup resolves after —
    // it must not clobber the second's prompt or fire a fallback
    // display-only switch for 'colemak-id'.
    resolveFirst()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(result.current.pendingApply).toEqual({ id: 'dvorak-id', name: 'Dvorak' })
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
  })

  // --- D3: keymapRestoreSeq defensively closes an open confirm modal ---
  // (Plan-qwerty-select-no-rewrite §snapshot/.vil 復元時のクリーンアップ) ---

  describe('keymapRestoreSeq (restore cleanup, D3)', () => {
    it('a change closes an open confirm modal', async () => {
      const { result, rerender } = setup({ keyboardLayout: 'qwerty', keymapRestoreSeq: 1 })
      act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
      await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

      rerender({ keyboardLayout: 'qwerty', keymapRestoreSeq: 2 })
      expect(result.current.pendingApply).toBeNull()
    })

    // The counter is monotonic for the session (a disconnect carries it
    // forward instead of zeroing it, see keyboard-types.ts / reset()), so
    // this hook only needs a plain "did it change" check — it does not
    // need to special-case a decrease itself.

    it('an unchanged value does not close the modal', async () => {
      const { result, rerender } = setup({ keyboardLayout: 'qwerty', keymapRestoreSeq: 1 })
      act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
      await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

      rerender({ keyboardLayout: 'qwerty', keymapRestoreSeq: 1 })
      expect(result.current.pendingApply).not.toBeNull()
    })
  })

  // --- keymap not editable falls through unchanged ---

  it('falls straight through to a display-only switch when the keymap is not editable', async () => {
    const { result } = renderHook(() => useKeymapApplyPrompt({
      keymapEditable: false,
      keyboardLayout: 'qwerty',
      onKeyboardLayoutChange,
      onApplyKeymapRewrite,
    }))
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    expect(lookup.ensure).not.toHaveBeenCalled()
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id')
  })
})
