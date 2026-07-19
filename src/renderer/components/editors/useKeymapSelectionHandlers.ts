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
import { sortKeysByViewMatrix } from './view-matrix'

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
  layout: { keys: KleKey[] } | null
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
  // Auth
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  // Multi-select
  multiSelect: UseKeymapMultiSelectReturn
  // History
  history: UseKeymapHistoryReturn
  /** Persists `PipetteSettings.appliedKeymapLayout` (Plan-key-label-keymap-apply,
   *  追加要求 2026-07-18). Called only when undoing/redoing a rewrite batch
   *  (one carrying `appliedLayoutBefore`/`appliedLayoutAfter`) — every other
   *  batch/single entry has neither field, so this never fires for them. */
  onAppliedKeymapLayoutChange?: (id: string) => void
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
  layout,
  keymap,
  encoderLayout,
  currentLayer,
  selectableKeys,
  autoAdvance,
  viewMatrix,
  onSetKey,
  onSetKeysBulk,
  onSetEncoder,
  unlocked,
  onUnlock,
  multiSelect,
  history,
  onAppliedKeymapLayoutChange,
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

  const clearSingleSelection = useCallback((): void => {
    setSelectedKey(null)
    setSelectedEncoder(null)
    setSelectedMaskPart(false)
    setPopoverState(null)
  }, [])

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
  const advancableKeys = useMemo(() => {
    if (!layout) return []
    const filtered = layout.keys.filter((k) => !k.decal && k.encoderIdx < 0)
    return sortKeysByViewMatrix(filtered, viewMatrix)
  }, [layout, viewMatrix])

  const advanceToNextKey = useCallback(() => {
    if (!autoAdvance || !selectedKey || advancableKeys.length === 0) return
    const currentIdx = advancableKeys.findIndex((k) => k.row === selectedKey.row && k.col === selectedKey.col)
    if (currentIdx >= 0 && currentIdx < advancableKeys.length - 1) {
      const next = advancableKeys[currentIdx + 1]
      setSelectedKey({ row: next.row, col: next.col })
      setSelectedMaskPart(false)
    }
  }, [autoAdvance, advancableKeys, selectedKey])

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
      setPopoverState((prev) => { if (!prev) return null; if (prev.kind !== 'key' || prev.row !== key.row || prev.col !== key.col) return null; return { ...prev, maskClicked } })
      setSelectedKey({ row: key.row, col: key.col }); setSelectedMaskPart(maskClicked); setSelectedEncoder(null)
    },
    [selectedKey, selectionAnchor, selectableKeys, multiSelectedKeys, pickerSelected, handlePickerPaste, clearPickerSelection, setMultiSelectedKeys, setSelectionAnchor, setSelectionSourcePane, setSelectionMode],
  )

  const handleEncoderClick = useCallback((_key: KleKey, dir: number, maskClicked: boolean) => {
    setSelectedEncoder({ idx: _key.encoderIdx, dir: dir as 0 | 1 }); setSelectedKey(null); setSelectedMaskPart(maskClicked); setPopoverState(null)
  }, [])

  const handleKeyDoubleClick = useCallback((key: KleKey, rect: DOMRect, maskClicked: boolean) => {
    setSelectedKey({ row: key.row, col: key.col }); setSelectedMaskPart(maskClicked); setSelectedEncoder(null)
    setPopoverState({ anchorRect: rect, kind: 'key', row: key.row, col: key.col, maskClicked })
  }, [])

  const handleEncoderDoubleClick = useCallback((_key: KleKey, dir: number, rect: DOMRect, maskClicked: boolean) => {
    setSelectedEncoder({ idx: _key.encoderIdx, dir: dir as 0 | 1 }); setSelectedKey(null); setSelectedMaskPart(maskClicked)
    setPopoverState({ anchorRect: rect, kind: 'encoder', idx: _key.encoderIdx, dir: dir as 0 | 1, maskClicked })
  }, [])

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

  const handlePopoverKeycodeSelect = useCallback(async (kc: Keycode) => {
    clearPending()
    if (!popoverState) return
    const code = deserialize(kc.qmkId)
    if (popoverState.kind === 'key') {
      const currentCode = keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
      const popoverMask = popoverState.maskClicked && isMask(serialize(currentCode))
      const newCode = resolveKeycode(currentCode, code, popoverMask)
      await onSetKey(currentLayer, popoverState.row, popoverState.col, newCode)
      history.push({ kind: 'key', layer: currentLayer, row: popoverState.row, col: popoverState.col, oldKeycode: currentCode, newKeycode: newCode, maskPart: popoverMask ? 'inner' : undefined })
    } else {
      const currentCode = encoderLayout.get(`${currentLayer},${popoverState.idx},${popoverState.dir}`) ?? 0
      const popoverMask = popoverState.maskClicked && isMask(serialize(currentCode))
      const newCode = resolveKeycode(currentCode, code, popoverMask)
      await onSetEncoder(currentLayer, popoverState.idx, popoverState.dir, newCode)
      history.push({ kind: 'encoder', layer: currentLayer, idx: popoverState.idx, dir: popoverState.dir, oldKeycode: currentCode, newKeycode: newCode, maskPart: popoverMask ? 'inner' : undefined })
    }
  }, [popoverState, currentLayer, keymap, encoderLayout, onSetKey, onSetEncoder, clearPending, history])

  const handlePopoverRawKeycodeSelect = useCallback(async (code: number) => {
    clearPending()
    if (!popoverState) return
    if (popoverState.kind === 'key') {
      const currentCode = keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
      await onSetKey(currentLayer, popoverState.row, popoverState.col, code)
      history.push({ kind: 'key', layer: currentLayer, row: popoverState.row, col: popoverState.col, oldKeycode: currentCode, newKeycode: code })
    } else {
      const currentCode = encoderLayout.get(`${currentLayer},${popoverState.idx},${popoverState.dir}`) ?? 0
      await onSetEncoder(currentLayer, popoverState.idx, popoverState.dir, code)
      history.push({ kind: 'encoder', layer: currentLayer, idx: popoverState.idx, dir: popoverState.dir, oldKeycode: currentCode, newKeycode: code })
    }
  }, [popoverState, currentLayer, keymap, encoderLayout, onSetKey, onSetEncoder, clearPending, history])

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
      // Rewrite batch bookkeeping (Plan-key-label-keymap-apply, 追加要求
      // 2026-07-18): only a Key Label "apply to keymap" batch carries these
      // fields (always both together), so this is a no-op for every other
      // batch (e.g. picker paste). Checking `appliedLayoutAfter` alone is
      // enough — the producer (KeymapEditor.applyKeymapRewrite) never sets
      // one without the other.
      const { appliedLayoutBefore, appliedLayoutAfter } = entry
      if (appliedLayoutAfter !== undefined) {
        onAppliedKeymapLayoutChange?.(isUndo ? appliedLayoutBefore! : appliedLayoutAfter)
      }
    } else {
      const code = isUndo ? entry.oldKeycode : entry.newKeycode
      if (entry.kind === 'key') await onSetKey(entry.layer, entry.row, entry.col, code)
      else await onSetEncoder(entry.layer, entry.idx, entry.dir, code)
    }
  }, [onSetKey, onSetKeysBulk, onSetEncoder, onAppliedKeymapLayoutChange])

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
    let applied = false
    try {
      await applyHistoryEntry(entry, isUndo)
      // Commit only after successful apply.
      if (isUndo) history.undo()
      else history.redo()
      applied = true
    } finally { undoRedoInFlightRef.current = false }
    setPopoverState(null)
    // Fire outside the try/finally above: `onHistoryApplied` only runs once
    // the apply + commit are already done, so a throw from it can no
    // longer un-commit the undo/redo or leave the in-flight guard stuck.
    if (applied) onHistoryApplied?.(entry.kind === 'batch' ? entry.entries : [entry])
  }, [history, applyHistoryEntry, onHistoryApplied])

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
    setPopoverState,
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
