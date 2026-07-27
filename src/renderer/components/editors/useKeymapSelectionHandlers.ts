// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import type { KleKey } from '../../../shared/kle/types'
import { posKey } from '../../../shared/kle/pos-key'
import { serialize, deserialize, isMask, isTapDanceKeycode, getTapDanceIndex, isMacroKeycode, getMacroIndex, isLMKeycode, resolve, extractBasicKey, buildModMaskKeycode } from '../../../shared/keycodes/keycodes'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import type { BulkKeyEntry } from '../../hooks/useKeyboard'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import type { ViewMatrixCell } from '../../../shared/types/pipette-settings'
import type { MacroAction } from '../../../preload/macro'
import { hasModifierKey } from './KeyboardPane'
import type { PopoverState } from './keymap-editor-types'
import type { UseKeymapMultiSelectReturn } from './useKeymapMultiSelect'
import type { UseKeymapHistoryReturn, SingleHistoryEntry, HistoryEntry } from './useKeymapHistory'
import { sortKeysByViewMatrix, type ViewMatrixKeyRef } from './view-matrix'

/**
 * Given the Auto Move walk order (already layout-option/decal/encoder
 * filtered and view-matrix sorted — see `advancableKeys` below) and a
 * starting position, returns the next key in the walk, or `null` when
 * `from` isn't in the list at all or is already last. Pure — callers
 * (both the left-panel picker and the popover follow-along) gate
 * `autoAdvance` themselves before calling this.
 */
export function nextAdvanceKey<K extends ViewMatrixKeyRef>(
  advancableKeys: readonly K[],
  from: { row: number; col: number },
): { row: number; col: number } | null {
  const idx = advancableKeys.findIndex((k) => k.row === from.row && k.col === from.col)
  if (idx < 0 || idx >= advancableKeys.length - 1) return null
  const next = advancableKeys[idx + 1]
  return { row: next.row, col: next.col }
}

/**
 * Finds the on-screen rect for the key at physical `(row, col)`, scoped to
 * `container` — never `document`. The Keyboard tab's hidden layout picker
 * renders its own elements with the same `data-key-pos` attribute
 * (`KeyWidget.tsx`), so an unscoped lookup can resolve to the wrong pane's
 * key; `container` must be the primary keymap pane's own content ref.
 *
 * Scrolls the element into view first — `behavior: 'instant'` is required
 * (not the default 'auto') so a key currently scrolled out of view is
 * measured at its final position instead of mid smooth-scroll animation.
 * Returns `null` when no matching element exists (e.g. a key hidden by the
 * current layout option, or the container isn't mounted) — callers must
 * not advance the popover in that case.
 */
function getKeyAnchorRect(container: HTMLElement | null, row: number, col: number): DOMRect | null {
  if (!container) return null
  const el = container.querySelector(`[data-key-pos="${row},${col}"]`)
  if (!el) return null
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  return el.getBoundingClientRect()
}

/** Partial write to the selection-state quartet (`selectedKey` /
 *  `selectedMaskPart` / `selectedEncoder` / `popoverState`) that
 *  `applySelectionChange` below accepts — only the fields present are
 *  updated, the rest are left as-is. `popoverState` accepts a React
 *  updater function too (see `handleKeyClick`). */
interface SelectionPatch {
  selectedKey?: { row: number; col: number } | null
  selectedMaskPart?: boolean
  selectedEncoder?: { idx: number; dir: 0 | 1 } | null
  popoverState?: PopoverState | null | ((prev: PopoverState | null) => PopoverState | null)
}

/** Match a history entry against the current popover position, returning the keycode if matched. */
function matchPopoverEntry(
  popoverState: PopoverState | null,
  entry: HistoryEntry | null,
  currentLayer: number,
  field: 'oldKeycode' | 'newKeycode',
): number | undefined {
  if (!popoverState || !entry || entry.kind === 'batch') return undefined
  if (popoverState.kind === 'key' && entry.kind === 'key' && entry.layer === currentLayer && entry.row === popoverState.row && entry.col === popoverState.col) return entry[field]
  if (popoverState.kind === 'encoder' && entry.kind === 'encoder' && entry.layer === currentLayer && entry.idx === popoverState.idx && entry.dir === popoverState.dir) return entry[field]
  return undefined
}

export interface UseKeymapSelectionOptions {
  // Core data
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  currentLayer: number
  selectableKeys: KleKey[]
  // Key operations
  autoAdvance: boolean
  /** Auto Move order override — see `PipetteSettings.viewMatrix`. Sorts
   *  `advancableKeys` by each key's effective (override ?? physical)
   *  position instead of raw definition order. */
  viewMatrix?: Record<string, ViewMatrixCell>
  onSetKey: (layer: number, row: number, col: number, keycode: number) => Promise<void>
  onSetKeysBulk: (entries: BulkKeyEntry[]) => Promise<void>
  onSetEncoder: (layer: number, idx: number, dir: number, keycode: number) => Promise<void>
  /** Ref to the primary keymap pane's content element (`KeymapEditor`'s
   *  `keyboardContentRef`) — scopes the popover follow-along's next-key
   *  rect lookup so it can never resolve to the Keyboard tab's hidden
   *  layout picker, which renders the same `data-key-pos` attribute. */
  keyboardContentRef?: React.RefObject<HTMLDivElement | null>
  // Auth
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  // Multi-select
  multiSelect: UseKeymapMultiSelectReturn
  // History
  history: UseKeymapHistoryReturn
  /** Fires the "flash" visual (see `useKeyFlash`) for the positions an
   *  undo/redo just touched. Contract: called only after ALL of that
   *  entry's device writes have succeeded AND the history stack has been
   *  committed (`history.undo()` / `history.redo()`) — never on a failed
   *  apply, and never before the commit. An exception thrown by this
   *  callback must not retroactively mark the undo/redo as failed, so it
   *  is invoked after `handleUndo`/`handleRedo`'s own try/finally has
   *  already run to completion. Receives the normalized entry list
   *  (`entry.kind === 'batch' ? entry.entries : [entry]`). */
  onHistoryApplied?: (entries: SingleHistoryEntry[]) => void
  // TD/Macro
  tapDanceEntries?: TapDanceEntry[]
  onSetTapDanceEntry?: (index: number, entry: TapDanceEntry) => Promise<void>
  macroCount?: number
  macroBufferSize?: number
  macroBuffer?: number[]
  onSaveMacros?: (buffer: number[], parsedMacros?: MacroAction[][]) => Promise<void>
}

export function useKeymapSelectionHandlers({
  keymap,
  encoderLayout,
  currentLayer,
  selectableKeys,
  autoAdvance,
  viewMatrix,
  onSetKey,
  onSetKeysBulk,
  onSetEncoder,
  keyboardContentRef,
  unlocked,
  onUnlock,
  multiSelect,
  history,
  onHistoryApplied,
  tapDanceEntries,
  onSetTapDanceEntry,
  macroCount,
  macroBufferSize,
  macroBuffer,
  onSaveMacros,
}: UseKeymapSelectionOptions) {
  const { guard, clearPending } = useUnlockGate({ unlocked, onUnlock })
  const {
    multiSelectedKeys, setMultiSelectedKeys,
    selectionAnchor, setSelectionAnchor,
    selectionSourcePane: _selectionSourcePane, setSelectionSourcePane,
    selectionMode: _selectionMode, setSelectionMode,
    pickerSelected,
    clearMultiSelection,
    clearPickerSelection,
  } = multiSelect

  // --- Single selection state ---
  const [selectedKey, setSelectedKey] = useState<{ row: number; col: number } | null>(null)
  const [selectedEncoder, setSelectedEncoder] = useState<{ idx: number; dir: 0 | 1 } | null>(null)
  const [selectedMaskPart, setSelectedMaskPart] = useState(false)
  const [popoverState, setPopoverState] = useState<PopoverState | null>(null)

  // Generation counter guarding the popover follow-along's UI updates
  // (selectedKey/selectedMaskPart/selectedEncoder/popoverState) against a
  // stale async write resolving after something newer already took over
  // — an explicit close, Escape, opening a different key, or a second
  // popover-driven write starting. Every write to that state quartet
  // bumps this ref; the popover write handlers snapshot its value at
  // entry and re-check before touching any of that state (never before
  // the device write/history push themselves, which always stand
  // regardless).
  const popoverAdvanceEpochRef = useRef(0)

  const bumpPopoverEpoch = useCallback((): number => ++popoverAdvanceEpochRef.current, [])

  /**
   * Single entry point for writing any of the selection-state quartet.
   * Bumps `popoverAdvanceEpochRef` first, unconditionally — every caller
   * below goes through here instead of hand-rolling its own `++` next to
   * a handful of setters, so a future confirm path can't add an 8th call
   * site and forget the bump, letting the stale-write race this guards
   * against creep back in. Returns the new epoch for callers that need
   * to gate an async continuation on it (the popover confirm handlers).
   */
  const applySelectionChange = useCallback((patch: SelectionPatch): number => {
    const epoch = bumpPopoverEpoch()
    if ('selectedKey' in patch) setSelectedKey(patch.selectedKey ?? null)
    if ('selectedMaskPart' in patch) setSelectedMaskPart(patch.selectedMaskPart ?? false)
    if ('selectedEncoder' in patch) setSelectedEncoder(patch.selectedEncoder ?? null)
    if ('popoverState' in patch) setPopoverState(patch.popoverState ?? null)
    return epoch
  }, [bumpPopoverEpoch])

  const clearSingleSelection = useCallback((): void => {
    applySelectionChange({ selectedKey: null, selectedEncoder: null, selectedMaskPart: false, popoverState: null })
  }, [applySelectionChange])

  /** Closes the popover from an explicit user action (close button,
   *  outside click, resize, Escape) — bumps the epoch so a write that's
   *  still in flight for the position being closed can't resurrect the
   *  popover once it resolves. */
  const closePopover = useCallback(() => {
    applySelectionChange({ popoverState: null })
  }, [applySelectionChange])

  // --- TD/Macro modal state ---
  const [tdModalIndex, setTdModalIndex] = useState<number | null>(null)
  const [macroModalIndex, setMacroModalIndex] = useState<number | null>(null)

  useEffect(() => {
    if (tdModalIndex !== null && (!tapDanceEntries || tdModalIndex >= tapDanceEntries.length)) setTdModalIndex(null)
  }, [tdModalIndex, tapDanceEntries])

  useEffect(() => {
    if (macroModalIndex !== null && (macroCount == null || macroModalIndex >= macroCount)) setMacroModalIndex(null)
  }, [macroModalIndex, macroCount])

  // --- Copy state ---
  const [isCopying, setIsCopying] = useState(false)
  const isCopyingRef = useRef(false)

  // --- Escape deselect ---
  useEffect(() => {
    if (!selectedKey && !selectedEncoder) return
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') clearSingleSelection() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedKey, selectedEncoder, clearSingleSelection])

  // --- Layer change effects ---
  const prevLayerRef = useRef(currentLayer)

  useEffect(() => {
    const layerChanged = prevLayerRef.current !== currentLayer
    prevLayerRef.current = currentLayer
    if (layerChanged) { clearMultiSelection(); clearPickerSelection() }
  }, [currentLayer, clearMultiSelection, clearPickerSelection])

  // --- Selected keycode derivations ---
  const selectedKeycode = useMemo(() => {
    if (selectedKey) return serialize(keymap.get(`${currentLayer},${selectedKey.row},${selectedKey.col}`) ?? 0)
    if (selectedEncoder) return serialize(encoderLayout.get(`${currentLayer},${selectedEncoder.idx},${selectedEncoder.dir}`) ?? 0)
    return null
  }, [selectedKey, selectedEncoder, keymap, encoderLayout, currentLayer])

  const isMaskKey = selectedKeycode != null && isMask(selectedKeycode) && selectedMaskPart

  const isLMMask = useMemo(() => {
    if (!isMaskKey) return false
    if (selectedKey) {
      const code = keymap.get(`${currentLayer},${selectedKey.row},${selectedKey.col}`) ?? 0
      return isLMKeycode(code)
    }
    if (selectedEncoder) {
      const code = encoderLayout.get(`${currentLayer},${selectedEncoder.idx},${selectedEncoder.dir}`) ?? 0
      return isLMKeycode(code)
    }
    return false
  }, [isMaskKey, selectedKey, selectedEncoder, keymap, encoderLayout, currentLayer])

  function resolveKeycode(currentCode: number, newCode: number, maskMode: boolean): number {
    if (maskMode) {
      if (isLMKeycode(currentCode)) {
        const modMask = resolve('QMK_LM_MASK')
        return (currentCode & ~modMask) | (newCode & modMask)
      }
      return (currentCode & 0xff00) | (newCode & 0x00ff)
    }
    return newCode
  }

  // --- Auto-advance ---
  // Walk `selectableKeys` (already layout-option/decal/encoder filtered),
  // not raw `layout.keys` — otherwise Auto Move can land on a key hidden by
  // the current layout option (e.g. the unselected ISO/ANSI or split
  // spacebar variant), leaving the selection highlight invisible.
  const advancableKeys = useMemo(
    () => sortKeysByViewMatrix(selectableKeys, viewMatrix),
    [selectableKeys, viewMatrix],
  )

  const advanceToNextKey = useCallback(() => {
    if (!autoAdvance || !selectedKey) return
    const next = nextAdvanceKey(advancableKeys, selectedKey)
    if (!next) return
    setSelectedKey(next)
    setSelectedMaskPart(false)
  }, [autoAdvance, advancableKeys, selectedKey])

  /** Moves the popover AND the shared single-selection state to `next`
   *  together (wall 5) — a next key that happens to be a mask key must
   *  never inherit a stale `selectedMaskPart`/`selectedEncoder` from
   *  whatever was selected before. */
  const advancePopoverAndSelection = useCallback((next: { row: number; col: number }, rect: DOMRect) => {
    applySelectionChange({
      selectedKey: next,
      selectedMaskPart: false,
      selectedEncoder: null,
      popoverState: { anchorRect: rect, kind: 'key', row: next.row, col: next.col, maskClicked: false },
    })
  }, [applySelectionChange])

  /**
   * Follows the popover from `from` to the next key in the Auto Move
   * walk. Checks `epoch` twice: once up front, before calling
   * `getKeyAnchorRect` — which has the side effect of scrolling the next
   * key into view — so a write that's already stale can't yank the
   * viewport toward a key the user no longer cares about; and again
   * right before touching any state (a stale write resolving after
   * something newer took over must not clobber it — in that case this
   * does nothing at all, scroll included). Otherwise it always resolves
   * the confirm one way or another: advances to the next key when the
   * walk has one and its on-screen element can be found, or closes the
   * popover exactly like a confirm with no follow-along would (already
   * on the last key, or the next key has no rect because it's hidden by
   * the current layout option) — callers only reach here once they've
   * decided this is a genuine confirm that must not leave the popover
   * stranded open.
   */
  const tryAdvancePopover = useCallback((from: { row: number; col: number }, epoch: number) => {
    if (popoverAdvanceEpochRef.current !== epoch) return
    const next = nextAdvanceKey(advancableKeys, from)
    const rect = next ? getKeyAnchorRect(keyboardContentRef?.current ?? null, next.row, next.col) : null
    if (popoverAdvanceEpochRef.current !== epoch) return
    if (next && rect) advancePopoverAndSelection(next, rect)
    else applySelectionChange({ popoverState: null })
  }, [advancableKeys, keyboardContentRef, advancePopoverAndSelection, applySelectionChange])

  // --- TD/Macro modal openers ---
  const openTdModal = useCallback((rawCode: number) => {
    if (!tapDanceEntries || !onSetTapDanceEntry) return
    if (!isTapDanceKeycode(rawCode)) return
    const idx = getTapDanceIndex(rawCode)
    if (idx >= tapDanceEntries.length) return
    setTdModalIndex(idx)
  }, [tapDanceEntries, onSetTapDanceEntry])

  const openMacroModal = useCallback((rawCode: number) => {
    if (macroCount == null || macroCount === 0 || !onSaveMacros || !macroBuffer || !macroBufferSize) return
    if (!isMacroKeycode(rawCode)) return
    const idx = getMacroIndex(rawCode)
    if (idx >= macroCount) return
    if (unlocked === false) { onUnlock?.({ macroWarning: true }); return }
    setMacroModalIndex(idx)
  }, [macroCount, macroBuffer, macroBufferSize, onSaveMacros, unlocked, onUnlock])

  // --- Copy helpers ---
  const runCopy = useCallback(async (fn: () => Promise<void>) => {
    if (isCopyingRef.current) return
    isCopyingRef.current = true
    setIsCopying(true)
    try { await fn() } finally { isCopyingRef.current = false; setIsCopying(false) }
  }, [])

  const handlePickerPaste = useCallback(async (targetKey: KleKey) => {
    const targetIdx = selectableKeys.findIndex((k) => k.row === targetKey.row && k.col === targetKey.col)
    if (targetIdx < 0) return
    const sortedEntries = [...pickerSelected.entries()].sort((a, b) => a[0] - b[0])
    const targetPositions = selectableKeys.slice(targetIdx, targetIdx + sortedEntries.length)
    await runCopy(async () => {
      const entries: BulkKeyEntry[] = []
      const histEntries: SingleHistoryEntry[] = []
      for (let i = 0; i < targetPositions.length; i++) {
        const { row, col } = targetPositions[i]
        const newCode = sortedEntries[i][1]
        const oldCode = keymap.get(`${currentLayer},${row},${col}`) ?? 0
        entries.push({ layer: currentLayer, row, col, keycode: newCode })
        histEntries.push({ kind: 'key', layer: currentLayer, row, col, oldKeycode: oldCode, newKeycode: newCode })
      }
      await onSetKeysBulk(entries)
      if (histEntries.length > 0) history.push({ kind: 'batch', entries: histEntries })
    })
    clearPickerSelection()
    setSelectedKey(null); setSelectedMaskPart(false); setSelectedEncoder(null)
  }, [pickerSelected, selectableKeys, currentLayer, keymap, onSetKeysBulk, runCopy, clearPickerSelection, history])

  // --- Click handlers ---
  const handleKeyClick = useCallback(
    (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => {
      const pos = posKey(key.row, key.col)
      if (pickerSelected.size > 0 && !event?.ctrlKey && !event?.shiftKey) { handlePickerPaste(key); return }
      if (event?.ctrlKey && !selectedKey) {
        clearPickerSelection()
        setMultiSelectedKeys((prev) => { const next = new Set(prev); if (next.has(pos)) next.delete(pos); else next.add(pos); return next })
        setSelectionAnchor({ row: key.row, col: key.col }); setSelectionSourcePane('primary'); setSelectionMode('ctrl'); return
      }
      if (event?.shiftKey && !selectedKey && selectionAnchor) {
        clearPickerSelection()
        const anchorIdx = selectableKeys.findIndex((k) => k.row === selectionAnchor.row && k.col === selectionAnchor.col)
        const currentIdx = selectableKeys.findIndex((k) => k.row === key.row && k.col === key.col)
        if (anchorIdx >= 0 && currentIdx >= 0) {
          const start = Math.min(anchorIdx, currentIdx); const end = Math.max(anchorIdx, currentIdx)
          const next = new Set(multiSelectedKeys)
          for (let i = start; i <= end; i++) next.add(`${selectableKeys[i].row},${selectableKeys[i].col}`)
          setMultiSelectedKeys(next)
        }
        setSelectionSourcePane('primary'); setSelectionMode('shift'); return
      }
      setMultiSelectedKeys(new Set()); setSelectionAnchor({ row: key.row, col: key.col }); setSelectionSourcePane(null)
      // A different key's popover may be closing here (the updater below
      // nulls it unless it's the same position) — routing through
      // applySelectionChange bumps the epoch so an in-flight popover
      // write for that other position can't resurrect it later.
      applySelectionChange({
        popoverState: (prev) => { if (!prev) return null; if (prev.kind !== 'key' || prev.row !== key.row || prev.col !== key.col) return null; return { ...prev, maskClicked } },
        selectedKey: { row: key.row, col: key.col },
        selectedMaskPart: maskClicked,
        selectedEncoder: null,
      })
    },
    [selectedKey, selectionAnchor, selectableKeys, multiSelectedKeys, pickerSelected, handlePickerPaste, clearPickerSelection, setMultiSelectedKeys, setSelectionAnchor, setSelectionSourcePane, setSelectionMode, applySelectionChange],
  )

  const handleEncoderClick = useCallback((_key: KleKey, dir: number, maskClicked: boolean) => {
    applySelectionChange({ selectedEncoder: { idx: _key.encoderIdx, dir: dir as 0 | 1 }, selectedKey: null, selectedMaskPart: maskClicked, popoverState: null })
  }, [applySelectionChange])

  const handleKeyDoubleClick = useCallback((key: KleKey, rect: DOMRect, maskClicked: boolean) => {
    applySelectionChange({
      selectedKey: { row: key.row, col: key.col },
      selectedMaskPart: maskClicked,
      selectedEncoder: null,
      popoverState: { anchorRect: rect, kind: 'key', row: key.row, col: key.col, maskClicked },
    })
  }, [applySelectionChange])

  const handleEncoderDoubleClick = useCallback((_key: KleKey, dir: number, rect: DOMRect, maskClicked: boolean) => {
    applySelectionChange({
      selectedEncoder: { idx: _key.encoderIdx, dir: dir as 0 | 1 },
      selectedKey: null,
      selectedMaskPart: maskClicked,
      popoverState: { anchorRect: rect, kind: 'encoder', idx: _key.encoderIdx, dir: dir as 0 | 1, maskClicked },
    })
  }, [applySelectionChange])

  // --- Deselect ---
  const handleDeselect = useCallback(() => {
    clearSingleSelection(); clearMultiSelection(); clearPickerSelection()
  }, [clearSingleSelection, clearMultiSelection, clearPickerSelection])

  const handleDeselectClick = useCallback((e: React.MouseEvent) => {
    if (!hasModifierKey(e)) handleDeselect()
  }, [handleDeselect])

  // --- Keycode handlers ---
  // Only `.qmkId` is read below, so accept the picker's ad-hoc fallback
  // shape too (findKeycode(qmkId) ?? { qmkId, label, keycode } in
  // useLayoutPicker.tsx) — that fallback deliberately isn't a real
  // `Keycode` instance since constructing one would register it in the
  // class's global qmkId lookup maps for what may be a one-off/custom code.
  const handleKeycodeSelect = useCallback(async (kc: Pick<Keycode, 'qmkId'>) => {
    clearPickerSelection(); clearPending()
    const code = deserialize(kc.qmkId)
    if (selectedKey) {
      const currentCode = keymap.get(`${currentLayer},${selectedKey.row},${selectedKey.col}`) ?? 0
      const finalCode = resolveKeycode(currentCode, code, isMaskKey)
      await onSetKey(currentLayer, selectedKey.row, selectedKey.col, finalCode)
      history.push({ kind: 'key', layer: currentLayer, row: selectedKey.row, col: selectedKey.col, oldKeycode: currentCode, newKeycode: finalCode, maskPart: isMaskKey ? 'inner' : undefined })
      if (!isMaskKey && isMask(kc.qmkId) && autoAdvance) setSelectedMaskPart(true)
      else advanceToNextKey()
    } else if (selectedEncoder) {
      const currentCode = encoderLayout.get(`${currentLayer},${selectedEncoder.idx},${selectedEncoder.dir}`) ?? 0
      const finalCode = resolveKeycode(currentCode, code, isMaskKey)
      await onSetEncoder(currentLayer, selectedEncoder.idx, selectedEncoder.dir, finalCode)
      history.push({ kind: 'encoder', layer: currentLayer, idx: selectedEncoder.idx, dir: selectedEncoder.dir, oldKeycode: currentCode, newKeycode: finalCode, maskPart: isMaskKey ? 'inner' : undefined })
    } else {
      openTdModal(code); openMacroModal(code)
    }
  }, [selectedKey, selectedEncoder, currentLayer, keymap, encoderLayout, isMaskKey, autoAdvance, onSetKey, onSetEncoder, advanceToNextKey, openTdModal, openMacroModal, clearPending, clearPickerSelection, history])

  /**
   * Resolves what the popover does after a confirm's device write has
   * landed — shared by the Key tab pick path (`handlePopoverKeycodeSelect`)
   * and the raw/Code-tab path (`handlePopoverRawKeycodeSelect`), which
   * otherwise differ only in how `stayOpen` is decided (picking a
   * mask-type keycode vs. `advance === false`). Re-checks `epoch` first
   * — a stale write resolving after something newer took over must
   * leave the UI alone entirely (the write + history push already stood
   * regardless, from the caller). Otherwise: `stayOpen` leaves the
   * popover exactly as it was (a wrapper-mode pick awaiting its inner
   * key, or a raw call that only reconfigured the wrapper itself);
   * `kind === 'key'` with Auto Move on follows the walk to the next key;
   * anything else — encoders never advance (no walk order over them),
   * or Auto Move is off — closes exactly like every popover confirm did
   * before this feature.
   */
  const resolvePopoverConfirm = useCallback((
    kind: 'key' | 'encoder',
    fromPos: { row: number; col: number } | null,
    epoch: number,
    stayOpen: boolean,
  ): void => {
    if (popoverAdvanceEpochRef.current !== epoch) return
    if (stayOpen) return
    if (kind === 'key' && autoAdvance && fromPos) {
      tryAdvancePopover(fromPos, epoch)
      return
    }
    applySelectionChange({ popoverState: null })
  }, [autoAdvance, tryAdvancePopover, applySelectionChange])

  const handlePopoverKeycodeSelect = useCallback(async (kc: Keycode) => {
    clearPending()
    if (!popoverState) return
    // A new popover-driven write always supersedes whatever the previous
    // one was still waiting on — bump first so that older completion (if
    // still in flight) is recognized as stale once it resolves.
    const epoch = bumpPopoverEpoch()
    const code = deserialize(kc.qmkId)
    if (popoverState.kind === 'key') {
      const fromPos = { row: popoverState.row, col: popoverState.col }
      const currentCode = keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
      const popoverMask = popoverState.maskClicked && isMask(serialize(currentCode))
      const newCode = resolveKeycode(currentCode, code, popoverMask)
      await onSetKey(currentLayer, popoverState.row, popoverState.col, newCode)
      history.push({ kind: 'key', layer: currentLayer, row: popoverState.row, col: popoverState.col, oldKeycode: currentCode, newKeycode: newCode, maskPart: popoverMask ? 'inner' : undefined })
      // Picking a mask-type keycode (unless already editing an existing
      // mask's inner part) is the "stay open" case — mirrors the left
      // panel's handleKeycodeSelect above.
      resolvePopoverConfirm('key', fromPos, epoch, !popoverMask && isMask(kc.qmkId))
    } else {
      const currentCode = encoderLayout.get(`${currentLayer},${popoverState.idx},${popoverState.dir}`) ?? 0
      const popoverMask = popoverState.maskClicked && isMask(serialize(currentCode))
      const newCode = resolveKeycode(currentCode, code, popoverMask)
      await onSetEncoder(currentLayer, popoverState.idx, popoverState.dir, newCode)
      history.push({ kind: 'encoder', layer: currentLayer, idx: popoverState.idx, dir: popoverState.dir, oldKeycode: currentCode, newKeycode: newCode, maskPart: popoverMask ? 'inner' : undefined })
      resolvePopoverConfirm('encoder', null, epoch, false)
    }
  }, [popoverState, currentLayer, keymap, encoderLayout, onSetKey, onSetEncoder, clearPending, history, bumpPopoverEpoch, resolvePopoverConfirm])

  const handlePopoverRawKeycodeSelect = useCallback(async (code: number, advance: boolean) => {
    clearPending()
    if (!popoverState) return
    const epoch = bumpPopoverEpoch()
    if (popoverState.kind === 'key') {
      const fromPos = { row: popoverState.row, col: popoverState.col }
      const currentCode = keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
      await onSetKey(currentLayer, popoverState.row, popoverState.col, code)
      history.push({ kind: 'key', layer: currentLayer, row: popoverState.row, col: popoverState.col, oldKeycode: currentCode, newKeycode: code })
      // `advance` is false for LT/LM layer changes, mode-button switches,
      // and modifier-checkbox-strip changes (KeyPopover.tsx) — none of
      // those are a "confirm", so `resolvePopoverConfirm` leaves the
      // popover put.
      resolvePopoverConfirm('key', fromPos, epoch, !advance)
    } else {
      const currentCode = encoderLayout.get(`${currentLayer},${popoverState.idx},${popoverState.dir}`) ?? 0
      await onSetEncoder(currentLayer, popoverState.idx, popoverState.dir, code)
      history.push({ kind: 'encoder', layer: currentLayer, idx: popoverState.idx, dir: popoverState.dir, oldKeycode: currentCode, newKeycode: code })
      // Same "no advance for encoders" rule as the kc path above.
      resolvePopoverConfirm('encoder', null, epoch, !advance)
    }
  }, [popoverState, currentLayer, keymap, encoderLayout, onSetKey, onSetEncoder, clearPending, history, bumpPopoverEpoch, resolvePopoverConfirm])

  const handlePopoverModMaskChange = useCallback(async (newMask: number) => {
    if (!popoverState) return
    if (popoverState.kind === 'key') {
      const currentCode = keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
      const basicKey = extractBasicKey(currentCode)
      const newCode = buildModMaskKeycode(newMask, basicKey)
      await onSetKey(currentLayer, popoverState.row, popoverState.col, newCode)
      history.push({ kind: 'key', layer: currentLayer, row: popoverState.row, col: popoverState.col, oldKeycode: currentCode, newKeycode: newCode, maskPart: 'outer' })
    } else {
      const currentCode = encoderLayout.get(`${currentLayer},${popoverState.idx},${popoverState.dir}`) ?? 0
      const basicKey = extractBasicKey(currentCode)
      const newCode = buildModMaskKeycode(newMask, basicKey)
      await onSetEncoder(currentLayer, popoverState.idx, popoverState.dir, newCode)
      history.push({ kind: 'encoder', layer: currentLayer, idx: popoverState.idx, dir: popoverState.dir, oldKeycode: currentCode, newKeycode: newCode, maskPart: 'outer' })
    }
  }, [popoverState, currentLayer, keymap, encoderLayout, onSetKey, onSetEncoder, history])

  // --- History-derived popover undo ---
  const popoverUndoKeycode = useMemo(
    () => matchPopoverEntry(popoverState, history.peekUndo, currentLayer, 'oldKeycode'),
    [popoverState, currentLayer, history.peekUndo],
  )

  // --- Undo / redo ---
  const applyHistoryEntry = useCallback(async (entry: HistoryEntry, isUndo: boolean) => {
    if (entry.kind === 'batch') {
      const items = isUndo ? [...entry.entries].reverse() : entry.entries
      const keyEntries: BulkKeyEntry[] = []
      const encoderOps: { layer: number; idx: number; dir: number; code: number }[] = []
      for (const e of items) {
        const code = isUndo ? e.oldKeycode : e.newKeycode
        if (e.kind === 'key') keyEntries.push({ layer: e.layer, row: e.row, col: e.col, keycode: code })
        else encoderOps.push({ layer: e.layer, idx: e.idx, dir: e.dir, code })
      }
      if (keyEntries.length > 0) await onSetKeysBulk(keyEntries)
      for (const op of encoderOps) await onSetEncoder(op.layer, op.idx, op.dir, op.code)
    } else {
      const code = isUndo ? entry.oldKeycode : entry.newKeycode
      if (entry.kind === 'key') await onSetKey(entry.layer, entry.row, entry.col, code)
      else await onSetEncoder(entry.layer, entry.idx, entry.dir, code)
    }
  }, [onSetKey, onSetKeysBulk, onSetEncoder])

  // In-flight guard to prevent concurrent undo/redo
  const undoRedoInFlightRef = useRef(false)

  // Undo and redo differ only in direction (which stack to peek/commit,
  // and which side of the entry `applyHistoryEntry` restores) — shared here
  // instead of duplicating the guard/apply/commit/notify sequence twice.
  const runHistoryStep = useCallback(async (isUndo: boolean) => {
    if (undoRedoInFlightRef.current) return
    const entry = isUndo ? history.peekUndo : history.peekRedo
    if (!entry) return
    undoRedoInFlightRef.current = true
    // Snapshot the epoch before the device writes below — which, for a
    // batch entry, run as a sequence of awaited HID calls and can take
    // long enough for the user to open a different popover in the
    // meantime. `undoRedoInFlightRef` only blocks a second concurrent
    // undo/redo; it does nothing to stop that other popover from opening.
    // Re-checking the epoch here before closing the popover keeps this
    // consistent with every other popover write handler in this file:
    // a stale completion must never clobber something newer.
    const epoch = popoverAdvanceEpochRef.current
    try {
      await applyHistoryEntry(entry, isUndo)
      // Commit only after successful apply.
      if (isUndo) history.undo()
      else history.redo()
    } finally { undoRedoInFlightRef.current = false }
    if (popoverAdvanceEpochRef.current === epoch) applySelectionChange({ popoverState: null })
    // Fire outside the try/finally above: a throw from `applyHistoryEntry`
    // or the commit call propagates out of the `try` (after `finally`
    // resets the in-flight guard) and skips everything below, so reaching
    // this line already guarantees the apply + commit succeeded — no flag
    // needed to gate it. Placement after the commit is what guarantees
    // `onHistoryApplied` can no longer un-commit the undo/redo or leave the
    // in-flight guard stuck. The flash it triggers is purely cosmetic, so a
    // throw from the callback itself is swallowed here rather than
    // rejecting `runHistoryStep`'s promise — the undo/redo already
    // succeeded and must not be reported as failed just because the flash
    // visual couldn't be shown.
    try {
      onHistoryApplied?.(entry.kind === 'batch' ? entry.entries : [entry])
    } catch {
      // Intentionally ignored — see comment above.
    }
  }, [history, applyHistoryEntry, onHistoryApplied, applySelectionChange])

  const handleUndo = useCallback(() => runHistoryStep(true), [runHistoryStep])
  const handleRedo = useCallback(() => runHistoryStep(false), [runHistoryStep])

  const handlePopoverUndo = useCallback(() => {
    if (popoverUndoKeycode == null) return
    void handleUndo()
  }, [popoverUndoKeycode, handleUndo])

  // --- History-derived popover redo (top-only) ---
  const popoverRedoKeycode = useMemo(
    () => matchPopoverEntry(popoverState, history.peekRedo, currentLayer, 'newKeycode'),
    [popoverState, currentLayer, history.peekRedo],
  )

  const handlePopoverRedo = useCallback(() => {
    if (popoverRedoKeycode == null) return
    void handleRedo()
  }, [popoverRedoKeycode, handleRedo])

  // --- Keyboard shortcuts for undo/redo ---
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as Element | null
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (target?.closest?.('[contenteditable]')) return
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); void handleUndo(); return }
      if (key === 'z' && e.shiftKey) { e.preventDefault(); void handleRedo(); return }
      if (key === 'y' && !e.shiftKey) { e.preventDefault(); void handleRedo(); return }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleUndo, handleRedo])

  // --- TD/Macro modal handlers ---
  const handleTdModalSave = useCallback(async (idx: number, entry: TapDanceEntry) => {
    const codes = [entry.onTap, entry.onHold, entry.onDoubleTap, entry.onTapHold]
    await guard(codes, async () => { await onSetTapDanceEntry?.(idx, entry); setTdModalIndex(null) })
  }, [onSetTapDanceEntry, guard])

  const handleTdModalClose = useCallback(() => { clearPending(); setTdModalIndex(null) }, [clearPending])
  const handleMacroModalClose = useCallback(() => { setMacroModalIndex(null) }, [])

  return {
    // Single selection
    selectedKey,
    selectedEncoder,
    selectedMaskPart,
    popoverState,
    closePopover,
    clearSingleSelection,
    // Derived
    selectedKeycode,
    isMaskKey,
    isLMMask,
    // Click handlers
    handleKeyClick,
    handleEncoderClick,
    handleKeyDoubleClick,
    handleEncoderDoubleClick,
    // Keycode handlers
    handleKeycodeSelect,
    handlePopoverKeycodeSelect,
    handlePopoverRawKeycodeSelect,
    handlePopoverModMaskChange,
    popoverUndoKeycode,
    handlePopoverUndo,
    popoverRedoKeycode,
    handlePopoverRedo,
    handleUndo,
    handleRedo,
    // Deselect
    handleDeselect,
    handleDeselectClick,
    // Copy
    isCopying,
    // Modals
    tdModalIndex,
    macroModalIndex,
    handleTdModalSave,
    handleTdModalClose,
    handleMacroModalClose,
    // Auth
    guard,
    clearPending,
  }
}
