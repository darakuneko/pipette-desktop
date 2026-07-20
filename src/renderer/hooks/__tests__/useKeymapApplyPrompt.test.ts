// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useKeymapApplyPrompt, type UseKeymapApplyPromptOptions } from '../useKeymapApplyPrompt'
import { buildKeymapRewriteTable } from '../../../shared/keymap/keymap-apply'
import { BUILTIN_QWERTY_LAYOUT_ID } from '../../data/keyboard-layouts'

// Real rewrite-table engine (not mocked) — this suite exercises the
// WYSIWYG select semantics from Plan-qwerty-select-no-rewrite: the target
// table is always the selected pack's own table, applied directly against
// whatever the keymap currently holds. Real Colemak / Dvorak fixtures, same
// as shared/keymap/__tests__/keymap-apply.test.ts.
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

describe('useKeymapApplyPrompt — WYSIWYG select semantics (Plan-qwerty-select-no-rewrite Phase K)', () => {
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

  it('A1: selecting QWERTY switches display only, never written', async () => {
    const { result } = setup({ keyboardLayout: 'colemak-id' })
    act(() => result.current.handleKeyboardLayoutChange(BUILTIN_QWERTY_LAYOUT_ID))
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID, false))
    expect(result.current.pendingApply).toBeNull()
    expect(onApplyKeymapRewrite).not.toHaveBeenCalled()
    expect(lookup.ensure).not.toHaveBeenCalled()
  })

  it('A1: selecting QWERTY closes an already-open confirm modal instead of applying it', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => result.current.handleKeyboardLayoutChange(BUILTIN_QWERTY_LAYOUT_ID))
    expect(result.current.pendingApply).toBeNull()
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID, false)
    expect(onApplyKeymapRewrite).not.toHaveBeenCalled()
  })

  // --- A2: same-value re-selection is a true no-op — the hook must not
  // call the setter at all, so whatever `keymapWritten` currently holds
  // (owned entirely by the caller, not by this hook) survives untouched
  // for free. This also means the hook has no need to know its value. ---

  it('A2: re-selecting the current select value is a true no-op — no setter call, no modal, no lookup', async () => {
    const { result } = setup({ keyboardLayout: 'colemak-id' })
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    expect(result.current.pendingApply).toBeNull()
    expect(lookup.ensure).not.toHaveBeenCalled()
  })

  // --- A3: non-eligible pack falls through to a plain display switch ---

  it('A3: a pack that is not keymapApplicable falls back to a display-only switch, never written', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('not-applicable-id'))
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('not-applicable-id', false))
    expect(result.current.pendingApply).toBeNull()
  })

  // --- A4: applicable pack prompts, Confirm applies its own table, and a
  // clean success KEEPS the select on the rewritten arrangement, marked
  // written (Phase K — no more forced QWERTY reset) ---

  it('A4: an applicable pack different from the current select prompts, and Confirm applies its own table, keeping the select on it and marking it written', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).toEqual({ id: 'dvorak-id', name: 'Dvorak' }))
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1))
    const [table] = onApplyKeymapRewrite.mock.calls[0] as [Map<string, string>]
    // The applied table is Dvorak's own table — no compose with anything
    // currently applied.
    expect(table).toEqual(dvorakTable())
    // Clean success with appliedCount > 0 keeps the select on the rewritten
    // arrangement and marks it written — never resets to QWERTY.
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('dvorak-id', true))
  })

  it('A4: re-applying the same pack the select already shows still offers a fresh Rewrite (no appliedKeymapLayout gate)', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    await waitFor(() => expect(result.current.pendingApply).toEqual({ id: 'colemak-id', name: 'Colemak' }))

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1))
    const [table] = onApplyKeymapRewrite.mock.calls[0] as [Map<string, string>]
    expect(table).toEqual(colemakTable())
  })

  // --- A5 / A6: Display Only / Cancel are unaffected ---

  it('A5: Display Only switches display straight to the target id without rewriting, never written', async () => {
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => result.current.handleApplyDisplayOnly())
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id', false)
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

  // --- C1 / C2: apply-result handling ---

  it('C1: partial failure leaves the select AND written flag untouched, and surfaces the error', async () => {
    onApplyKeymapRewrite.mockResolvedValueOnce({ appliedCount: 1, error: 'device write failed' })
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(result.current.applyError).toBe('device write failed'))
    // The keymap is now a mix of old and new characters that matches
    // neither arrangement, so the display selection (and written flag) is
    // left as-is — no save call at all, unlike a clean success.
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    expect(result.current.pendingApply).toBeNull()
  })

  it('C2: a zero-count success (nothing actually needed rewriting) is treated as a plain display-only switch, not written', async () => {
    onApplyKeymapRewrite.mockResolvedValueOnce({ appliedCount: 0 })
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('dvorak-id', false))
    expect(result.current.applyError).toBeNull()
  })

  // --- Double-Confirm re-entrancy guard ---
  // A double-clicked Apply must never fire a second `onApplyKeymapRewrite`
  // while the first is still in flight: `KeymapEditor.applyKeymapRewrite`'s
  // own re-entrancy guard would answer that second call with
  // `{ appliedCount: 0 }` and NO error, which this hook would otherwise read
  // as a clean success and mark the select written even though the real
  // (first) apply may later end in a partial failure whose contract is
  // "select/written untouched".

  describe('double-Confirm re-entrancy guard', () => {
    function pendingApplyResult() {
      let resolve!: (result: { appliedCount: number; error?: string }) => void
      const promise = new Promise<{ appliedCount: number; error?: string }>((res) => { resolve = res })
      return { promise, resolve: (r: { appliedCount: number; error?: string }) => resolve(r) }
    }

    it('double-Confirm while the first apply is pending: onApplyKeymapRewrite fires once, and a later partial-failure resolution leaves the select untouched', async () => {
      const { promise, resolve } = pendingApplyResult()
      onApplyKeymapRewrite.mockImplementationOnce(() => promise)

      const { result } = setup({ keyboardLayout: 'qwerty' })
      act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
      await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

      act(() => { result.current.handleApplyConfirm() })
      expect(result.current.isApplying).toBe(true)

      // Second click lands while the first is still awaiting
      // onApplyKeymapRewrite — must be a pure no-op, not a second call.
      act(() => { result.current.handleApplyConfirm() })
      expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolve({ appliedCount: 1, error: 'device write failed' })
        await promise.catch(() => {})
      })

      expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)
      expect(result.current.applyError).toBe('device write failed')
      // Partial failure: the select/written must stay untouched — the
      // second click's no-op result must never have driven this.
      expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
      expect(result.current.isApplying).toBe(false)
    })

    it('double-Confirm where the first apply resolves cleanly: still applies exactly once and marks the select written exactly once', async () => {
      const { promise, resolve } = pendingApplyResult()
      onApplyKeymapRewrite.mockImplementationOnce(() => promise)

      const { result } = setup({ keyboardLayout: 'qwerty' })
      act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
      await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

      act(() => { result.current.handleApplyConfirm() })
      act(() => { result.current.handleApplyConfirm() })
      expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolve({ appliedCount: 2 })
        await promise
      })

      expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)
      expect(onKeyboardLayoutChange).toHaveBeenCalledTimes(1)
      expect(onKeyboardLayoutChange).toHaveBeenCalledWith('dvorak-id', true)
      expect(result.current.isApplying).toBe(false)
    })

    it('Cancel and Display Only are no-ops while an apply is in flight', async () => {
      const { promise, resolve } = pendingApplyResult()
      onApplyKeymapRewrite.mockImplementationOnce(() => promise)

      const { result } = setup({ keyboardLayout: 'qwerty' })
      act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
      await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

      act(() => { result.current.handleApplyConfirm() })
      expect(result.current.isApplying).toBe(true)

      act(() => result.current.handleApplyCancel())
      expect(result.current.pendingApply).not.toBeNull() // modal must stay open

      act(() => result.current.handleApplyDisplayOnly())
      expect(onKeyboardLayoutChange).not.toHaveBeenCalled()

      await act(async () => {
        resolve({ appliedCount: 2 })
        await promise
      })
      expect(result.current.isApplying).toBe(false)
    })
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
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID, false)
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

  // --- D3: keymapRestoreSeq defensively closes an open confirm modal, and
  // (Phase K) forces keymapWritten back to false for the CURRENT select
  // value without changing the select value itself ---
  // (Plan-qwerty-select-no-rewrite §snapshot/.vil 復元時のクリーンアップ) ---

  describe('keymapRestoreSeq (restore cleanup, D3 + Phase K written reset)', () => {
    it('a change closes an open confirm modal and forces keymapWritten=false for the current select value', async () => {
      const { result, rerender } = setup({ keyboardLayout: 'qwerty', keymapRestoreSeq: 1 })
      act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
      await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

      rerender({ keyboardLayout: 'qwerty', keymapRestoreSeq: 2 })
      expect(result.current.pendingApply).toBeNull()
      // Select VALUE is untouched (still 'qwerty', unchanged by the pending
      // selection that never landed) — only written resets.
      expect(onKeyboardLayoutChange).toHaveBeenCalledWith('qwerty', false)
    })

    it('restore cleanup resets written to false for a select that was already marked written, keeping the select value itself', async () => {
      // The hook itself no longer tracks `keymapWritten` (removed — its
      // only prior use was the same-value guard, now a true no-op instead)
      // — the restore effect always forces `false` unconditionally for
      // whatever `keyboardLayout` currently is, regardless of what the
      // caller's own written flag happened to hold beforehand.
      const { rerender } = setup({ keyboardLayout: 'colemak-id', keymapRestoreSeq: 1 })
      rerender({ keyboardLayout: 'colemak-id', keymapRestoreSeq: 2 })
      expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id', false)
    })

    // The counter is monotonic for the session (a disconnect carries it
    // forward instead of zeroing it, see keyboard-types.ts / reset()), so
    // this hook only needs a plain "did it change" check — it does not
    // need to special-case a decrease itself.

    it('an unchanged value does not close the modal or touch written', async () => {
      const { result, rerender } = setup({ keyboardLayout: 'qwerty', keymapRestoreSeq: 1 })
      act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
      await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

      rerender({ keyboardLayout: 'qwerty', keymapRestoreSeq: 1 })
      expect(result.current.pendingApply).not.toBeNull()
      expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    })

    it('restore race: a pack lookup already in flight before the restore must not re-open the modal once it resolves', async () => {
      let resolveEnsure!: () => void
      lookup.ensure.mockImplementationOnce(() => new Promise<void>((res) => { resolveEnsure = res }))

      const { result, rerender } = setup({ keyboardLayout: 'qwerty', keymapRestoreSeq: 1 })
      act(() => result.current.handleKeyboardLayoutChange('colemak-id'))

      // The restore lands while the selection above is still awaiting its
      // pack lookup — nothing is pending yet either way.
      rerender({ keyboardLayout: 'qwerty', keymapRestoreSeq: 2 })
      expect(result.current.pendingApply).toBeNull()

      // The stale lookup (started BEFORE the restore) resolves after — it
      // must not open the modal against the keymap the restore just
      // replaced.
      resolveEnsure()
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
      expect(result.current.pendingApply).toBeNull()
    })

    it('restore race: a restore landing while Confirm is in flight discards the apply\'s own result entirely — only the restore\'s own reset lands', async () => {
      let resolveApply!: (r: { appliedCount: number; error?: string }) => void
      const applyPromise = new Promise<{ appliedCount: number; error?: string }>((res) => { resolveApply = res })
      onApplyKeymapRewrite.mockImplementationOnce(() => applyPromise)

      const { result, rerender } = setup({ keyboardLayout: 'qwerty', keymapRestoreSeq: 1 })
      act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
      await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

      act(() => { result.current.handleApplyConfirm() })
      expect(result.current.isApplying).toBe(true)

      // Restore lands mid-apply: closes the modal and forces written=false
      // for the select's CURRENT value ('qwerty' — the in-flight apply
      // hasn't landed yet, so the select hasn't moved to 'dvorak-id').
      rerender({ keyboardLayout: 'qwerty', keymapRestoreSeq: 2 })
      expect(onKeyboardLayoutChange).toHaveBeenCalledWith('qwerty', false)
      onKeyboardLayoutChange.mockClear()

      await act(async () => {
        resolveApply({ appliedCount: 2 })
        await applyPromise
      })

      // The apply's own clean-success branch must be discarded entirely —
      // no save call for 'dvorak-id' at all, since the restore's cleanup
      // already won.
      expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
      expect(result.current.isApplying).toBe(false)
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
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id', false)
  })
})
