// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useKeymapApplyPrompt } from '../useKeymapApplyPrompt'
import type { KeymapRewriteLayoutIds } from '../../../shared/keymap/keymap-apply'

// Real rewrite-table engine (not mocked) — this suite exercises the
// composition/eligibility branching added for the 追加要求 (2026-07-18)
// section of Plan-key-label-keymap-apply, so it needs real
// buildKeymapRewriteTable / composeRewriteTables behavior, not a stub.
// Real Colemak / Dvorak fixtures, same as shared/keymap/__tests__/keymap-apply.test.ts.
// Dvorak must be a CLOSED map (every target is also a source, see the
// closure check in buildKeymapRewriteTable) — this is pipette-hub's real
// "Dvorak" pack (data/key-labels-seed.json) plus the two entries
// (KC_MINUS -> "[", KC_EQUAL -> "]") its closure-fix plan adds; the
// unfixed 33-entry pack is intentionally non-closed and covered by its
// own dedicated test in keymap-apply.test.ts, not here.
const COLEMAK: Record<string, string> = {
  KC_E: 'F', KC_R: 'P', KC_T: 'G', KC_Y: 'J', KC_U: 'L', KC_I: 'U', KC_O: 'Y',
  KC_P: ';', KC_S: 'R', KC_D: 'S', KC_F: 'T', KC_G: 'D', KC_J: 'N', KC_K: 'E',
  KC_L: 'I', KC_SCOLON: 'O', KC_N: 'K',
}
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

describe('useKeymapApplyPrompt — composed eligibility (追加要求 2026-07-18)', () => {
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

  function setup(appliedKeymapLayout?: string) {
    return renderHook(() => useKeymapApplyPrompt({
      keymapEditable: true,
      appliedKeymapLayout,
      onKeyboardLayoutChange,
      onApplyKeymapRewrite,
    }))
  }

  it('QWERTY -> Colemak (nothing applied yet): prompts with the plain Colemak table', async () => {
    const { result } = setup(undefined)
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    await waitFor(() => expect(result.current.pendingApply).toEqual({ id: 'colemak-id', name: 'Colemak' }))
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
  })

  it('Colemak applied -> QWERTY: composes to the inverse Colemak table (non-empty) and prompts', async () => {
    const { result } = setup('colemak-id')
    act(() => result.current.handleKeyboardLayoutChange('qwerty'))
    await waitFor(() => expect(result.current.pendingApply).toEqual({ id: 'qwerty', name: 'qwerty' }))
  })

  it('Colemak applied -> Dvorak: composes a direct table and prompts (fixes the latent double-rewrite bug)', async () => {
    const { result } = setup('colemak-id')
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).toEqual({ id: 'dvorak-id', name: 'Dvorak' }))
  })

  it('re-selecting the already-applied arrangement switches display only (no modal)', async () => {
    const { result } = setup('colemak-id')
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id'))
    expect(result.current.pendingApply).toBeNull()
  })

  it('target not keymapApplicable: falls back to display-only switch', async () => {
    const { result } = setup(undefined)
    act(() => result.current.handleKeyboardLayoutChange('not-applicable-id'))
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('not-applicable-id'))
    expect(result.current.pendingApply).toBeNull()
  })

  it('applied pack no longer installed/eligible: logs and falls back to display-only switch', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = setup('missing-id')
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id'))
    expect(result.current.pendingApply).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('handleApplyConfirm passes {before, after} layoutIds and switches display to qwerty, not the target (double-remap fix)', async () => {
    const { result } = setup('colemak-id')
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => { result.current.handleApplyConfirm() })

    await waitFor(() => expect(onKeyboardLayoutChange).toHaveBeenCalledWith('qwerty'))
    expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)
    const [, layoutIds] = onApplyKeymapRewrite.mock.calls[0] as [unknown, KeymapRewriteLayoutIds]
    expect(layoutIds).toEqual({ before: 'colemak-id', after: 'dvorak-id' })
    // Display switches to the built-in QWERTY id, never to 'dvorak-id' —
    // the keymap now holds Dvorak's keycodes directly, so displaying
    // Dvorak's labels on top would re-translate them (double-applied look).
    expect(onKeyboardLayoutChange).not.toHaveBeenCalledWith('dvorak-id')
  })

  it('handleApplyDisplayOnly still switches display straight to the target id (unaffected by the fix)', async () => {
    const { result } = setup(undefined)
    act(() => result.current.handleKeyboardLayoutChange('colemak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => result.current.handleApplyDisplayOnly())
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id')
    expect(onApplyKeymapRewrite).not.toHaveBeenCalled()
  })

  // --- codex focused review: selection race, stale `before`, partial failure ---

  it('selection race: a newer selection wins even if the OLDER one\'s lookups resolve later', async () => {
    // Queue two one-shot `ensure` implementations in call order: the first
    // selection (colemak-id) triggers the first `ensure` call, the second
    // selection (dvorak-id) triggers the second. Resolving them out of
    // order (second first) simulates the older request's network/IPC
    // round-trip finishing after the newer one's.
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const firstEnsure = new Promise<void>((res) => { resolveFirst = res })
    const secondEnsure = new Promise<void>((res) => { resolveSecond = res })
    lookup.ensure
      .mockImplementationOnce(() => firstEnsure)
      .mockImplementationOnce(() => secondEnsure)

    const { result } = setup(undefined)
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

  it('captures {before} at SELECTION time — a later appliedKeymapLayout change while the modal is open does not affect Confirm', async () => {
    const { result, rerender } = renderHook(
      (props: { appliedKeymapLayout?: string }) => useKeymapApplyPrompt({
        keymapEditable: true,
        appliedKeymapLayout: props.appliedKeymapLayout,
        onKeyboardLayoutChange,
        onApplyKeymapRewrite,
      }),
      { initialProps: { appliedKeymapLayout: 'colemak-id' } },
    )

    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    // appliedKeymapLayout changes (e.g. an undo/redo elsewhere) while the
    // modal is still open, before the user clicks Apply.
    rerender({ appliedKeymapLayout: 'qwerty' })

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1))
    const [, layoutIds] = onApplyKeymapRewrite.mock.calls[0] as [unknown, KeymapRewriteLayoutIds]
    // `before` is 'colemak-id' — what the composed table was actually built
    // against at selection time — not the 'qwerty' the prop changed to.
    expect(layoutIds).toEqual({ before: 'colemak-id', after: 'dvorak-id' })
  })

  it('partial-failure result: does not switch display (neither target nor qwerty), but still surfaces the error and closes the modal', async () => {
    onApplyKeymapRewrite.mockResolvedValueOnce({ appliedCount: 1, error: 'device write failed' })
    const { result } = setup('colemak-id')
    act(() => result.current.handleKeyboardLayoutChange('dvorak-id'))
    await waitFor(() => expect(result.current.pendingApply).not.toBeNull())

    act(() => { result.current.handleApplyConfirm() })
    await waitFor(() => expect(result.current.applyError).toBe('device write failed'))
    // Neither the display-double-remap qwerty switch nor a target switch
    // happens — the keymap is now a mix of old and new characters that
    // matches neither arrangement, so the display selection is left as-is.
    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    expect(result.current.pendingApply).toBeNull()
  })
})
