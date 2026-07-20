// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useKeymapApplyPrompt, type UseKeymapApplyPromptOptions } from '../useKeymapApplyPrompt'
import { buildKeymapRewriteTable } from '../../../shared/keymap/keymap-apply'
import { BUILTIN_QWERTY_LAYOUT_ID } from '../../data/keyboard-layouts'

// Real rewrite-table engine (not mocked) — this suite exercises the v7
// シミュレーションタブ方式 semantics from Plan-qwerty-select-no-rewrite: the
// select's onChange (`handleKeyboardLayoutChange`) is a plain display
// switch for every value, never a lookup or a modal. `requestApply` is the
// ONLY entry point into the confirm modal now — called by KeymapEditor's
// simulation-tab Apply button, which is only reachable while
// `useDevicePrefs.remapKind === 'simulated'`. Task-kaw-requestApply-reuse:
// the hook no longer resolves the target's map/table itself — callers pass
// in `activeRewriteTable`/`activeLayoutName` (mirroring `useDevicePrefs`'s
// own already-resolved values), so `requestApply` reads them synchronously
// instead of running its own `useKeyLabelLookup` fetch + build.
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

describe('useKeymapApplyPrompt — simulation tab Apply flow (Plan-qwerty-select-no-rewrite v7)', () => {
  const onKeyboardLayoutChange = vi.fn()
  const onApplyKeymapRewrite = vi.fn().mockResolvedValue({ appliedCount: 2 })

  beforeEach(() => {
    vi.clearAllMocks()
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

  // Shared by the double-Confirm and layout-change-race suites below — both
  // need to hold `onApplyKeymapRewrite`'s promise open to land assertions
  // mid-flight before resolving it.
  function pendingApplyResult() {
    let resolve!: (result: { appliedCount: number; error?: string }) => void
    const promise = new Promise<{ appliedCount: number; error?: string }>((res) => { resolve = res })
    return { promise, resolve: (r: { appliedCount: number; error?: string }) => resolve(r) }
  }

  // --- handleKeyboardLayoutChange: plain display switch for EVERY value ---

  it('handleKeyboardLayoutChange never opens the modal, for any value including a rewrite-eligible pack', () => {
    const { result } = setup({ keyboardLayout: 'qwerty' })
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('dvorak-id')
    expect(result.current.pendingApply).toBeNull()
  })

  it('handleKeyboardLayoutChange switches straight to QWERTY too — no special-cased early return needed anymore', () => {
    const { result } = setup({ keyboardLayout: 'colemak-id', activeRewriteTable: colemakTable(), activeLayoutName: 'Colemak' })
    act(() => result.current.handleKeyboardLayoutChange(BUILTIN_QWERTY_LAYOUT_ID))
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID)
    expect(result.current.pendingApply).toBeNull()
  })

  it('handleKeyboardLayoutChange closes an already-open confirm modal (defensive, ahead of the layout-watch effect)', () => {
    const { result, rerender } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).toEqual({ id: 'dvorak-id', name: 'Dvorak' })

    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    expect(result.current.pendingApply).toBeNull()
    rerender({ keyboardLayout: 'colemak-id', activeRewriteTable: colemakTable(), activeLayoutName: 'Colemak' })
    expect(result.current.pendingApply).toBeNull()
  })

  // --- requestApply: the only entry point into the modal, resolves
  // synchronously off the already-provided `activeRewriteTable` ---

  it('requestApply opens the modal for the current (rewrite-eligible) keyboardLayout', () => {
    const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).toEqual({ id: 'dvorak-id', name: 'Dvorak' })
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
  })

  it('requestApply falls back to the raw id when activeLayoutName is not provided', () => {
    const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable() })
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).toEqual({ id: 'dvorak-id', name: 'dvorak-id' })
  })

  it('requestApply is a no-op against QWERTY', () => {
    const { result } = setup({ keyboardLayout: BUILTIN_QWERTY_LAYOUT_ID, activeRewriteTable: colemakTable() })
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).toBeNull()
  })

  it('requestApply is a no-op against a pack that is not (or no longer) rewrite-eligible', () => {
    const { result } = setup({ keyboardLayout: 'not-applicable-id', activeRewriteTable: undefined })
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).toBeNull()
  })

  it('requestApply is a no-op when the keymap is not editable', () => {
    const { result } = renderHook(() => useKeymapApplyPrompt({
      keymapEditable: false,
      keyboardLayout: 'dvorak-id',
      activeRewriteTable: dvorakTable(),
      activeLayoutName: 'Dvorak',
      onKeyboardLayoutChange,
      onApplyKeymapRewrite,
    }))
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).toBeNull()
  })

  // --- Confirm applies the current layout's own table, resets to QWERTY on
  // clean success (destructive one-shot) ---

  it('Confirm applies the current keyboardLayout\'s own table and resets the select to QWERTY on clean success', async () => {
    const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).toEqual({ id: 'dvorak-id', name: 'Dvorak' })

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1))
    const [table] = onApplyKeymapRewrite.mock.calls[0] as [Map<string, string>]
    expect(table).toEqual(dvorakTable())
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID))
  })

  it('re-requesting Apply for the pack the select already shows still offers a fresh Rewrite', async () => {
    const { result } = setup({ keyboardLayout: 'colemak-id', activeRewriteTable: colemakTable(), activeLayoutName: 'Colemak' })
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).toEqual({ id: 'colemak-id', name: 'Colemak' })

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1))
    const [table] = onApplyKeymapRewrite.mock.calls[0] as [Map<string, string>]
    expect(table).toEqual(colemakTable())
  })

  it('Cancel closes the modal without touching the select or the keymap', () => {
    const { result } = setup({ keyboardLayout: 'colemak-id', activeRewriteTable: colemakTable(), activeLayoutName: 'Colemak' })
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).not.toBeNull()

    act(() => result.current.handleApplyCancel())
    expect(result.current.pendingApply).toBeNull()
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    expect(onApplyKeymapRewrite).not.toHaveBeenCalled()
  })

  // --- C1 / C2: apply-result handling ---

  it('C1: partial failure leaves the select untouched (no forced QWERTY reset) and surfaces the error', async () => {
    onApplyKeymapRewrite.mockResolvedValueOnce({ appliedCount: 1, error: 'device write failed' })
    const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).not.toBeNull()

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(result.current.applyError).toBe('device write failed'))
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    expect(result.current.pendingApply).toBeNull()
  })

  it('C2: a zero-count success (keymap already matched the target — Apply intent satisfied) still resets the select to QWERTY', async () => {
    onApplyKeymapRewrite.mockResolvedValueOnce({ appliedCount: 0 })
    const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
    act(() => { result.current.requestApply() })
    expect(result.current.pendingApply).not.toBeNull()

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID))
    expect(result.current.applyError).toBeNull()
  })

  // --- Double-Confirm re-entrancy guard ---

  describe('double-Confirm re-entrancy guard', () => {
    it('double-Confirm while the first apply is pending: onApplyKeymapRewrite fires once, and a later partial-failure resolution leaves the select untouched', async () => {
      const { promise, resolve } = pendingApplyResult()
      onApplyKeymapRewrite.mockImplementationOnce(() => promise)

      const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).not.toBeNull()

      act(() => { result.current.handleApplyConfirm() })
      expect(result.current.isApplying).toBe(true)

      act(() => { result.current.handleApplyConfirm() })
      expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolve({ appliedCount: 1, error: 'device write failed' })
        await promise.catch(() => {})
      })

      expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)
      expect(result.current.applyError).toBe('device write failed')
      expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
      expect(result.current.isApplying).toBe(false)
    })

    it('double-Confirm where the first apply resolves cleanly: still applies exactly once and resets the select exactly once', async () => {
      const { promise, resolve } = pendingApplyResult()
      onApplyKeymapRewrite.mockImplementationOnce(() => promise)

      const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).not.toBeNull()

      act(() => { result.current.handleApplyConfirm() })
      act(() => { result.current.handleApplyConfirm() })
      expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolve({ appliedCount: 2 })
        await promise
      })

      expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)
      expect(onKeyboardLayoutChange).toHaveBeenCalledTimes(1)
      expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID)
      expect(result.current.isApplying).toBe(false)
    })

    it('Cancel is a no-op while an apply is in flight', async () => {
      const { promise, resolve } = pendingApplyResult()
      onApplyKeymapRewrite.mockImplementationOnce(() => promise)

      const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).not.toBeNull()

      act(() => { result.current.handleApplyConfirm() })
      expect(result.current.isApplying).toBe(true)

      act(() => result.current.handleApplyCancel())
      expect(result.current.pendingApply).not.toBeNull() // modal must stay open

      await act(async () => {
        resolve({ appliedCount: 2 })
        await promise
      })
      expect(result.current.isApplying).toBe(false)
    })
  })

  // --- RACE (Plan-qwerty-select-no-rewrite v7, new/mandatory): the select
  // no longer routes through this hook's onChange-time lookup, so a
  // `keyboardLayout` change can land at any time — while the modal for a
  // DIFFERENT pack is already open. Must be caught by watching the value
  // itself. ---

  describe('layout-change race', () => {
    it('a layout change while the confirm modal is open for a DIFFERENT pack closes it (open Colemak, select Dvorak, Confirm must not fire)', () => {
      const { result, rerender } = setup({ keyboardLayout: 'colemak-id', activeRewriteTable: colemakTable(), activeLayoutName: 'Colemak' })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).toEqual({ id: 'colemak-id', name: 'Colemak' })

      // The select moves on to Dvorak — simulated here the same way App.tsx
      // actually drives it: `keyboardLayout` (and its sibling
      // `activeRewriteTable`/`activeLayoutName`, always in sync with it via
      // `useDevicePrefs`) change out from under the hook.
      rerender({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
      expect(result.current.pendingApply).toBeNull()

      act(() => { result.current.handleApplyConfirm() })
      expect(onApplyKeymapRewrite).not.toHaveBeenCalled()
    })

    it('an unchanged keyboardLayout value does not close an open modal', () => {
      const { result, rerender } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).not.toBeNull()

      rerender({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
      expect(result.current.pendingApply).not.toBeNull()
    })

    // --- FIX B (external review): a layout change WHILE Confirm's own
    // onApplyKeymapRewrite is still awaiting must discard that apply's
    // result entirely, not just close the (already-closed) modal — a clean
    // success arriving after the user has already moved on to a different
    // pack must never clobber that new selection back to QWERTY. ---

    it('FIX B: a layout change mid-apply discards a later clean success — no QWERTY reset, the new selection stands', async () => {
      const { promise, resolve } = pendingApplyResult()
      onApplyKeymapRewrite.mockImplementationOnce(() => promise)

      const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).not.toBeNull()

      act(() => { result.current.handleApplyConfirm() })
      expect(result.current.isApplying).toBe(true)

      // The user picks a different pack (Colemak) while Dvorak's apply is
      // still in flight — same call the footer select's onChange makes.
      act(() => { result.current.handleKeyboardLayoutChange('colemak-id') })
      expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id')
      onKeyboardLayoutChange.mockClear()

      // The STALE Dvorak apply now resolves cleanly.
      await act(async () => {
        resolve({ appliedCount: 2 })
        await promise
      })

      // Must NOT reset to QWERTY — that would clobber the Colemak selection
      // the user already made.
      expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
      expect(result.current.isApplying).toBe(false)
      expect(result.current.applyError).toBeNull()
    })

    it('FIX B: a layout change mid-apply also discards a later partial failure — no stray error surfaced against the abandoned pack', async () => {
      const { promise, resolve } = pendingApplyResult()
      onApplyKeymapRewrite.mockImplementationOnce(() => promise)

      const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).not.toBeNull()

      act(() => { result.current.handleApplyConfirm() })
      act(() => { result.current.handleKeyboardLayoutChange(BUILTIN_QWERTY_LAYOUT_ID) })
      onKeyboardLayoutChange.mockClear()

      await act(async () => {
        resolve({ appliedCount: 1, error: 'device write failed' })
        await promise.catch(() => {})
      })

      expect(result.current.applyError).toBeNull()
      expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    })

    it('FIX B control: an unchanged layout still resets to QWERTY on clean success (baseline, unaffected by the new guard)', async () => {
      const { result } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak' })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).not.toBeNull()

      act(() => { result.current.handleApplyConfirm() })
      await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID))
    })
  })

  // --- D3: keymapRestoreSeq defensively closes an open confirm modal
  // (Plan-qwerty-select-no-rewrite §snapshot/.vil 復元時のクリーンアップ) ---

  describe('keymapRestoreSeq (restore cleanup, D3)', () => {
    it('a change closes an open confirm modal', () => {
      const { result, rerender } = setup({ keyboardLayout: 'colemak-id', activeRewriteTable: colemakTable(), activeLayoutName: 'Colemak', keymapRestoreSeq: 1 })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).not.toBeNull()

      rerender({ keyboardLayout: 'colemak-id', activeRewriteTable: colemakTable(), activeLayoutName: 'Colemak', keymapRestoreSeq: 2 })
      expect(result.current.pendingApply).toBeNull()
    })

    it('an unchanged value does not close the modal', () => {
      const { result, rerender } = setup({ keyboardLayout: 'colemak-id', activeRewriteTable: colemakTable(), activeLayoutName: 'Colemak', keymapRestoreSeq: 1 })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).not.toBeNull()

      rerender({ keyboardLayout: 'colemak-id', activeRewriteTable: colemakTable(), activeLayoutName: 'Colemak', keymapRestoreSeq: 1 })
      expect(result.current.pendingApply).not.toBeNull()
      expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    })

    it('restore race: a restore landing while Confirm is in flight discards the apply\'s own result entirely — only the modal close lands', async () => {
      let resolveApply!: (r: { appliedCount: number; error?: string }) => void
      const applyPromise = new Promise<{ appliedCount: number; error?: string }>((res) => { resolveApply = res })
      onApplyKeymapRewrite.mockImplementationOnce(() => applyPromise)

      const { result, rerender } = setup({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak', keymapRestoreSeq: 1 })
      act(() => { result.current.requestApply() })
      expect(result.current.pendingApply).not.toBeNull()

      act(() => { result.current.handleApplyConfirm() })
      expect(result.current.isApplying).toBe(true)

      rerender({ keyboardLayout: 'dvorak-id', activeRewriteTable: dvorakTable(), activeLayoutName: 'Dvorak', keymapRestoreSeq: 2 })
      expect(result.current.pendingApply).toBeNull()

      await act(async () => {
        resolveApply({ appliedCount: 2 })
        await applyPromise
      })

      expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
      expect(result.current.isApplying).toBe(false)
    })
  })
})
