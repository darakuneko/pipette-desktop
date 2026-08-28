// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { useRef } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeymapSelectionHandlers } from '../useKeymapSelectionHandlers'
import { nextAdvanceKey } from '../keymap-auto-advance'
import { useKeymapMultiSelect } from '../useKeymapMultiSelect'
import { useKeymapHistory } from '../useKeymapHistory'
import type { UseKeymapSelectionOptions } from '../useKeymapSelectionHandlers'
import type { KleKey } from '../../../../shared/kle/types'
import type { Keycode } from '../../../../shared/keycodes/keycodes'

// ---------------------------------------------------------------------------
// nextAdvanceKey — pure function
// ---------------------------------------------------------------------------

describe('nextAdvanceKey', () => {
  const keys = [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }]

  it('returns the next key in the walk', () => {
    expect(nextAdvanceKey(keys, { row: 0, col: 0 })).toEqual({ row: 0, col: 1 })
  })

  it('returns null for the last key', () => {
    expect(nextAdvanceKey(keys, { row: 0, col: 2 })).toBeNull()
  })

  it('returns null when `from` is not in the list', () => {
    expect(nextAdvanceKey(keys, { row: 5, col: 5 })).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(nextAdvanceKey([], { row: 0, col: 0 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// useKeymapSelectionHandlers — popover Auto Move follow-along
// ---------------------------------------------------------------------------

const KEY_DEFAULTS: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
}

const makeKey = (row: number, col: number): KleKey => ({ ...KEY_DEFAULTS, row, col })

// Three keys in a row: (0,0) -> (0,1) -> (0,2), matching the walk order
// `sortKeysByViewMatrix` produces with no view-matrix overrides.
const SELECTABLE_KEYS = [makeKey(0, 0), makeKey(0, 1), makeKey(0, 2)]

// The rect passed to handleKeyDoubleClick when opening the popover — its
// exact identity/value never matters to the tests below (it's immediately
// superseded by a real measurement on the first advance), so one shared
// stand-in rect is enough.
const OPEN_RECT = { top: -1, left: -1, bottom: -1, right: -1, width: 0, height: 0, x: -1, y: -1, toJSON: () => ({}) } as DOMRect

/** Builds the primary keymap pane's content container with real
 *  `data-key-pos` child elements (mirroring `KeyWidget.tsx`), each with a
 *  stubbed `getBoundingClientRect`/`scrollIntoView` — plus one duplicate
 *  element OUTSIDE the container for a position that already has one
 *  inside, mirroring the Keyboard tab's hidden layout picker (wall 2).
 *  Rect objects are kept by reference in `rects` so assertions can check
 *  identity instead of deep-equality (a struct with a function field like
 *  `toJSON` never round-trips through `toEqual` cleanly). */
function setupKeyboardDom(): { container: HTMLDivElement; rects: Record<string, DOMRect>; scrollSpies: Record<string, ReturnType<typeof vi.fn>>; cleanup: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const rects: Record<string, DOMRect> = {
    '0,0': { top: 0, left: 0, bottom: 40, right: 60, width: 60, height: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    '0,1': { top: 10, left: 10, bottom: 50, right: 70, width: 60, height: 40, x: 10, y: 10, toJSON: () => ({}) } as DOMRect,
    '0,2': { top: 20, left: 20, bottom: 60, right: 80, width: 60, height: 40, x: 20, y: 20, toJSON: () => ({}) } as DOMRect,
  }
  const scrollSpies: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const [pos, rect] of Object.entries(rects)) {
    const el = document.createElement('div')
    el.setAttribute('data-key-pos', pos)
    el.getBoundingClientRect = () => rect
    const scrollSpy = vi.fn()
    el.scrollIntoView = scrollSpy
    scrollSpies[pos] = scrollSpy
    container.appendChild(el)
  }
  const outsideDuplicate = document.createElement('div')
  outsideDuplicate.setAttribute('data-key-pos', '0,1')
  outsideDuplicate.getBoundingClientRect = () => ({ top: 999, left: 999, bottom: 999, right: 999, width: 0, height: 0, x: 999, y: 999, toJSON: () => ({}) }) as DOMRect
  outsideDuplicate.scrollIntoView = vi.fn()
  document.body.appendChild(outsideDuplicate)
  return {
    container,
    rects,
    scrollSpies,
    cleanup: () => { container.remove(); outsideDuplicate.remove() },
  }
}

type HarnessOverrides = Partial<Omit<UseKeymapSelectionOptions, 'multiSelect' | 'history'>>

function useHarness(overrides: HarnessOverrides) {
  const hasActiveSingleSelectionRef = useRef(false)
  const multiSelect = useKeymapMultiSelect({ hasActiveSingleSelectionRef })
  const history = useKeymapHistory(100)
  return useKeymapSelectionHandlers({
    keymap: new Map(),
    encoderLayout: new Map(),
    currentLayer: 0,
    advancableKeys: SELECTABLE_KEYS,
    autoAdvance: true,
    onSetKey: vi.fn().mockResolvedValue(undefined),
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    multiSelect,
    history,
    ...overrides,
  })
}

const BASIC_KC = { qmkId: 'KC_A' } as Keycode
// A masked-template qmkId — `isMask` matches anything with a `(` whose
// prefix is a known masked keycode. `LSFT(kc)` is one of the statically
// registered modifier masks (module-load time, unlike LT/LM's per-layer
// templates which only exist after `recreateKeyboardKeycodes`).
const MASK_KC = { qmkId: 'LSFT(KC_A)' } as Keycode

describe('useKeymapSelectionHandlers — popover Auto Move follow-along', () => {
  let dom: ReturnType<typeof setupKeyboardDom>

  beforeEach(() => { dom = setupKeyboardDom() })
  afterEach(() => { dom.cleanup() })

  function renderHarness(overrides: HarnessOverrides = {}) {
    const containerRef = { current: dom.container }
    return renderHook(() => useHarness({ keyboardContentRef: containerRef, ...overrides }))
  }

  it('moves popoverState and selectedKey to the next key on a normal confirm', async () => {
    const { result } = renderHarness({ autoAdvance: true })
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))
    expect(result.current.selectedKey).toEqual({ row: 0, col: 0 })

    await act(async () => { await result.current.handlePopoverKeycodeSelect(BASIC_KC) })

    expect(result.current.selectedKey).toEqual({ row: 0, col: 1 })
    expect(result.current.popoverState).toMatchObject({ kind: 'key', row: 0, col: 1 })
    expect(result.current.popoverState?.anchorRect).toBe(dom.rects['0,1'])
  })

  it('closes the popover when Auto Move is off — a genuine confirm still closes like every confirm did before this feature', async () => {
    const { result } = renderHarness({ autoAdvance: false })
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))

    await act(async () => { await result.current.handlePopoverKeycodeSelect(BASIC_KC) })

    expect(result.current.selectedKey).toEqual({ row: 0, col: 0 })
    expect(result.current.popoverState).toBeNull()
  })

  it('does not advance when a mask-type keycode is selected — popover stays open in place', async () => {
    const { result } = renderHarness({ autoAdvance: true })
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))

    await act(async () => { await result.current.handlePopoverKeycodeSelect(MASK_KC) })

    expect(result.current.selectedKey).toEqual({ row: 0, col: 0 })
    expect(result.current.popoverState).toMatchObject({ kind: 'key', row: 0, col: 0 })
  })

  it('does not advance on a raw LT/LM mode/layer/mod change (advance=false) — write happens, popover stays put', async () => {
    const onSetKey = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHarness({ autoAdvance: true, onSetKey })
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))

    await act(async () => { await result.current.handlePopoverRawKeycodeSelect(0x4104, false) })

    expect(onSetKey).toHaveBeenCalledWith(0, 0, 0, 0x4104)
    expect(result.current.selectedKey).toEqual({ row: 0, col: 0 })
    expect(result.current.popoverState).toMatchObject({ kind: 'key', row: 0, col: 0 })
  })

  it('advances on a raw confirm (advance=true) — mirrors a wrapped inner key pick or Code tab Apply', async () => {
    const { result } = renderHarness({ autoAdvance: true })
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))

    await act(async () => { await result.current.handlePopoverRawKeycodeSelect(4, true) })

    expect(result.current.selectedKey).toEqual({ row: 0, col: 1 })
    expect(result.current.popoverState).toMatchObject({ kind: 'key', row: 0, col: 1 })
  })

  it('closes on a raw confirm (advance=true) when Auto Move is off', async () => {
    const { result } = renderHarness({ autoAdvance: false })
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))

    await act(async () => { await result.current.handlePopoverRawKeycodeSelect(4, true) })

    expect(result.current.selectedKey).toEqual({ row: 0, col: 0 })
    expect(result.current.popoverState).toBeNull()
  })

  it('closes the popover on the last key — nothing left to advance to', async () => {
    const { result } = renderHarness({ autoAdvance: true })
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[2], OPEN_RECT, false))

    await act(async () => { await result.current.handlePopoverKeycodeSelect(BASIC_KC) })

    expect(result.current.selectedKey).toEqual({ row: 0, col: 2 })
    expect(result.current.popoverState).toBeNull()
  })

  it('closes the popover when the next key has no on-screen element to anchor to', async () => {
    // Remove (0,1)'s element so the walk's next position can't be measured.
    dom.container.querySelector('[data-key-pos="0,1"]')?.remove()
    const { result } = renderHarness({ autoAdvance: true })
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))

    await act(async () => { await result.current.handlePopoverKeycodeSelect(BASIC_KC) })

    expect(result.current.selectedKey).toEqual({ row: 0, col: 0 })
    expect(result.current.popoverState).toBeNull()
  })

  it('uses the primary pane element, not the duplicate data-key-pos outside the container', async () => {
    const { result } = renderHarness({ autoAdvance: true })
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))

    await act(async () => { await result.current.handlePopoverKeycodeSelect(BASIC_KC) })

    // The container's own (0,1) rect must be used — the outside
    // duplicate's stubbed rect (999,999) must never be picked up.
    expect(result.current.popoverState?.anchorRect).toBe(dom.rects['0,1'])
  })

  it('encoders never advance — a confirm just closes the popover', async () => {
    const { result } = renderHarness({ autoAdvance: true })
    act(() => result.current.handleEncoderDoubleClick(SELECTABLE_KEYS[0], 0, OPEN_RECT, false))

    await act(async () => { await result.current.handlePopoverKeycodeSelect(BASIC_KC) })

    expect(result.current.popoverState).toBeNull()
    expect(result.current.selectedEncoder).toEqual({ idx: -1, dir: 0 })
  })

  it('a stale write completing after a different key was opened does not resurrect or overwrite the new popover', async () => {
    let resolveWrite: (() => void) | undefined
    const onSetKey = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveWrite = resolve }))
    const { result } = renderHarness({ autoAdvance: true, onSetKey })

    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))

    let pending!: Promise<void>
    act(() => { pending = result.current.handlePopoverKeycodeSelect(BASIC_KC) })

    // While that write is still in flight, the user opens a different key.
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[2], OPEN_RECT, false))
    expect(result.current.selectedKey).toEqual({ row: 0, col: 2 })

    // Now let the stale write resolve.
    await act(async () => { resolveWrite?.(); await pending })

    // The stale completion's advance must not have touched the popover
    // the user already moved on to.
    expect(result.current.selectedKey).toEqual({ row: 0, col: 2 })
    expect(result.current.popoverState).toMatchObject({ kind: 'key', row: 0, col: 2 })
  })

  it('a stale completion never scrolls to the stale next key — the epoch guard runs before scrollIntoView', async () => {
    let resolveWrite: (() => void) | undefined
    const onSetKey = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveWrite = resolve }))
    const { result } = renderHarness({ autoAdvance: true, onSetKey })

    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))

    let pending!: Promise<void>
    act(() => { pending = result.current.handlePopoverKeycodeSelect(BASIC_KC) })

    // While that write is still in flight, the user opens a different key —
    // this is the stale write's would-be next key, (0,1), that must never
    // be scrolled to once the old write finally resolves.
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[2], OPEN_RECT, false))

    // Now let the stale write resolve.
    await act(async () => { resolveWrite?.(); await pending })

    expect(dom.scrollSpies['0,1']).not.toHaveBeenCalled()
  })

  it('a normal confirm still scrolls the next key into view (regression check for the epoch guard reordering)', async () => {
    const { result } = renderHarness({ autoAdvance: true })
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[0], OPEN_RECT, false))

    await act(async () => { await result.current.handlePopoverKeycodeSelect(BASIC_KC) })

    expect(dom.scrollSpies['0,1']).toHaveBeenCalledTimes(1)
    expect(result.current.selectedKey).toEqual({ row: 0, col: 1 })
  })
})

// ---------------------------------------------------------------------------
// useKeymapSelectionHandlers — runHistoryStep popover epoch guard
// ---------------------------------------------------------------------------

describe('useKeymapSelectionHandlers — runHistoryStep popover epoch guard', () => {
  let dom: ReturnType<typeof setupKeyboardDom>

  beforeEach(() => { dom = setupKeyboardDom() })
  afterEach(() => { dom.cleanup() })

  function renderHarness(overrides: HarnessOverrides = {}) {
    const containerRef = { current: dom.container }
    return renderHook(() => useHarness({ keyboardContentRef: containerRef, ...overrides }))
  }

  it('does not close a popover opened while an undo write is still in flight', async () => {
    let resolveUndoWrite: (() => void) | undefined
    const onSetKey = vi.fn()
      .mockResolvedValueOnce(undefined) // the keycode-select write that seeds the undo entry
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveUndoWrite = resolve })) // the undo's own write

    const { result } = renderHarness({ autoAdvance: false, onSetKey })

    // Seed history: select (0,0), then pick a keycode to push an undo entry.
    act(() => result.current.handleKeyClick(SELECTABLE_KEYS[0], false))
    await act(async () => { await result.current.handleKeycodeSelect(BASIC_KC) })

    // Start the undo — its device write is controlled and left pending.
    let undoPending!: Promise<void>
    act(() => { undoPending = result.current.handleUndo() })

    // While the undo's write is in flight, the user opens a different key's
    // popover — this must survive the undo completing later.
    act(() => result.current.handleKeyDoubleClick(SELECTABLE_KEYS[2], OPEN_RECT, false))
    expect(result.current.popoverState).toMatchObject({ kind: 'key', row: 0, col: 2 })

    // Let the undo's write resolve.
    await act(async () => { resolveUndoWrite?.(); await undoPending })

    // The undo completing must not close the popover the user opened in
    // the meantime — only a still-current epoch may close it.
    expect(result.current.popoverState).toMatchObject({ kind: 'key', row: 0, col: 2 })
  })
})
