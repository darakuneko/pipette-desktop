// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import type { KleKey } from '../../../shared/kle/types'
import { serialize, deserialize, isMask, isTapDanceKeycode, getTapDanceIndex, isMacroKeycode, getMacroIndex, isLMKeycode, resolve, extractBasicKey, buildModMaskKeycode } from '../../../shared/keycodes/keycodes'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import type { BulkKeyEntry } from '../../hooks/useKeyboard'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import { hasModifierKey } from './KeyboardPane'
import type { PopoverState } from './keymap-editor-types'
import type { UseKeymapMultiSelectReturn } from './useKeymapMultiSelect'

export interface UseKeymapSelectionOptions {
  // Core data
  layout: { keys: KleKey[] } | null
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  encoderCount: number
  currentLayer: number
  // Pane state
  splitEdit?: boolean
  activePane: 'primary' | 'secondary'
  effectivePrimaryLayer: number
  effectiveSecondaryLayer: number
  inactivePaneLayer: number | undefined
  selectableKeys: KleKey[]
  // Key operations
  autoAdvance: boolean
  onSetKey: (layer: number, row: number, col: number, keycode: number) => Promise<void>
  onSetKeysBulk: (entries: BulkKeyEntry[]) => Promise<void>
  onSetEncoder: (layer: number, idx: number, dir: number, keycode: number) => Promise<void>
  // Auth
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  // Multi-select
  multiSelect: UseKeymapMultiSelectReturn
  // TD/Macro
  tapDanceEntries?: TapDanceEntry[]
  onSetTapDanceEntry?: (index: number, entry: TapDanceEntry) => Promise<void>
  macroCount?: number
  macroBufferSize?: number
  macroBuffer?: number[]
  onSaveMacros?: (buffer: number[], parsedMacros?: unknown) => Promise<void>
}

export function useKeymapSelectionHandlers({
  layout,
  keymap,
  encoderLayout,
  encoderCount,
  currentLayer,
  splitEdit,
  activePane,
  effectivePrimaryLayer,
  effectiveSecondaryLayer,
  inactivePaneLayer,
  selectableKeys,
  autoAdvance,
  onSetKey,
  onSetKeysBulk,
  onSetEncoder,
  unlocked,
  onUnlock,
  multiSelect,
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
    selectionSourcePane, setSelectionSourcePane,
    selectionMode, setSelectionMode,
    pickerSelected,
    clearMultiSelection,
    clearPickerSelection,
  } = multiSelect

  // --- Single selection state ---
  const [selectedKey, setSelectedKey] = useState<{ row: number; col: number } | null>(null)
  const [selectedEncoder, setSelectedEncoder] = useState<{ idx: number; dir: number } | null>(null)
  const [selectedMaskPart, setSelectedMaskPart] = useState(false)
  const [popoverState, setPopoverState] = useState<PopoverState | null>(null)

  const clearSingleSelection = useCallback((): void => {
    setSelectedKey(null)
    setSelectedEncoder(null)
    setSelectedMaskPart(false)
    setPopoverState(null)
  }, [])

  // --- Undo map ---
  const [undoMap, setUndoMap] = useState<Map<string, number>>(() => new Map())
  useEffect(() => {
    if (keymap.size === 0) setUndoMap(new Map())
  }, [keymap])

  const recordUndo = useCallback((mapKey: string, currentCode: number) => {
    setUndoMap((prev) => { if (prev.get(mapKey) === currentCode) return prev; const next = new Map(prev); next.set(mapKey, currentCode); return next })
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

  // --- Copy layer ---
  const [isCopying, setIsCopying] = useState(false)
  const isCopyingRef = useRef(false)
  const [copyLayerPending, setCopyLayerPending] = useState(false)

  // --- Escape deselect ---
  useEffect(() => {
    if (!selectedKey && !selectedEncoder) return
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') clearSingleSelection() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedKey, selectedEncoder, clearSingleSelection])

  // --- Layer/pane change effects ---
  const prevLayerRef = useRef(currentLayer)
  const prevActivePaneRef = useRef(activePane)

  useEffect(() => {
    const layerChanged = prevLayerRef.current !== currentLayer
    const paneChanged = prevActivePaneRef.current !== activePane
    prevLayerRef.current = currentLayer
    prevActivePaneRef.current = activePane
    setPopoverState(null)
    if (layerChanged && !paneChanged) { clearMultiSelection(); clearPickerSelection() }
    setCopyLayerPending(false)
  }, [currentLayer, activePane, clearMultiSelection, clearPickerSelection])

  useEffect(() => { clearSingleSelection() }, [activePane])

  useEffect(() => {
    if (!splitEdit) { clearMultiSelection(); setCopyLayerPending(false) }
  }, [splitEdit, clearMultiSelection])

  // --- Selected keycode derivations ---
  const selectedKeycode = useMemo(() => {
    if (selectedKey) return serialize(keymap.get(`${currentLayer},${selectedKey.row},${selectedKey.col}`) ?? 0)
    if (selectedEncoder) return serialize(encoderLayout.get(`${currentLayer},${selectedEncoder.idx},${selectedEncoder.dir}`) ?? 0)
    return null
  }, [selectedKey, selectedEncoder, keymap, encoderLayout, currentLayer])

  const isMaskKey = selectedKeycode != null && isMask(selectedKeycode) && selectedMaskPart

  const isLMMask = useMemo(() => {
    if (!isMaskKey || !selectedKey) return false
    const code = keymap.get(`${currentLayer},${selectedKey.row},${selectedKey.col}`) ?? 0
    return isLMKeycode(code)
  }, [isMaskKey, selectedKey, keymap, currentLayer])

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
    return layout.keys.filter((k) => !k.decal && k.encoderIdx < 0)
  }, [layout])

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

  const handleClickToPaste = useCallback(async (targetKey: KleKey) => {
    if (effectivePrimaryLayer === effectiveSecondaryLayer) return
    const srcLayer = selectionSourcePane === 'primary' ? effectivePrimaryLayer : effectiveSecondaryLayer
    const tgtLayer = currentLayer
    let orderedSourceKeys: string[]
    if (selectionMode === 'shift') {
      orderedSourceKeys = selectableKeys.filter((k) => multiSelectedKeys.has(`${k.row},${k.col}`)).map((k) => `${k.row},${k.col}`)
    } else {
      orderedSourceKeys = [...multiSelectedKeys]
    }
    const targetIdx = selectableKeys.findIndex((k) => k.row === targetKey.row && k.col === targetKey.col)
    if (targetIdx < 0) return
    const targetPositions = selectableKeys.slice(targetIdx, targetIdx + orderedSourceKeys.length)
    await runCopy(async () => {
      const entries: BulkKeyEntry[] = []
      for (let i = 0; i < targetPositions.length; i++) {
        const [srcR, srcC] = orderedSourceKeys[i].split(',').map(Number)
        const code = keymap.get(`${srcLayer},${srcR},${srcC}`)
        if (code !== undefined) entries.push({ layer: tgtLayer, row: targetPositions[i].row, col: targetPositions[i].col, keycode: code })
      }
      await onSetKeysBulk(entries)
    })
    clearMultiSelection()
  }, [effectivePrimaryLayer, effectiveSecondaryLayer, selectionSourcePane, selectionMode, selectableKeys, multiSelectedKeys, currentLayer, keymap, onSetKeysBulk, runCopy, clearMultiSelection])

  const handlePickerPaste = useCallback(async (targetKey: KleKey) => {
    const targetIdx = selectableKeys.findIndex((k) => k.row === targetKey.row && k.col === targetKey.col)
    if (targetIdx < 0) return
    // Get keycodes ordered by index (Map iteration order = insertion order, but sort to be safe)
    const sortedEntries = [...pickerSelected.entries()].sort((a, b) => a[0] - b[0])
    const targetPositions = selectableKeys.slice(targetIdx, targetIdx + sortedEntries.length)
    await runCopy(async () => {
      const entries: BulkKeyEntry[] = []
      for (let i = 0; i < targetPositions.length; i++) {
        entries.push({ layer: currentLayer, row: targetPositions[i].row, col: targetPositions[i].col, keycode: sortedEntries[i][1] })
      }
      await onSetKeysBulk(entries)
    })
    clearPickerSelection()
    setSelectedKey(null); setSelectedMaskPart(false); setSelectedEncoder(null)
  }, [pickerSelected, selectableKeys, currentLayer, onSetKeysBulk, runCopy, clearPickerSelection])

  // --- Click handlers ---
  const handleKeyClick = useCallback(
    (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => {
      const posKey = `${key.row},${key.col}`
      if (pickerSelected.size > 0 && !event?.ctrlKey && !event?.shiftKey) { handlePickerPaste(key); return }
      if (event?.ctrlKey && !selectedKey) {
        clearPickerSelection()
        setMultiSelectedKeys((prev) => { const next = new Set(prev); if (next.has(posKey)) next.delete(posKey); else next.add(posKey); return next })
        setSelectionAnchor({ row: key.row, col: key.col }); setSelectionSourcePane(activePane); setSelectionMode('ctrl'); return
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
        setSelectionSourcePane(activePane); setSelectionMode('shift'); return
      }
      const hasSelectionFromOtherPane = selectionSourcePane != null && selectionSourcePane !== activePane && multiSelectedKeys.size > 0 && effectivePrimaryLayer !== effectiveSecondaryLayer
      if (splitEdit && hasSelectionFromOtherPane) { handleClickToPaste(key); return }
      setMultiSelectedKeys(new Set()); setSelectionAnchor({ row: key.row, col: key.col }); setSelectionSourcePane(null)
      setPopoverState((prev) => { if (!prev) return null; if (prev.kind !== 'key' || prev.row !== key.row || prev.col !== key.col) return null; return { ...prev, maskClicked } })
      setSelectedKey({ row: key.row, col: key.col }); setSelectedMaskPart(maskClicked); setSelectedEncoder(null)
    },
    [splitEdit, activePane, selectedKey, selectionAnchor, selectableKeys, multiSelectedKeys, selectionSourcePane, effectivePrimaryLayer, effectiveSecondaryLayer, handleClickToPaste, pickerSelected, handlePickerPaste, clearPickerSelection, setMultiSelectedKeys, setSelectionAnchor, setSelectionSourcePane, setSelectionMode],
  )

  const handleEncoderClick = useCallback((_key: KleKey, dir: number) => {
    setSelectedEncoder({ idx: _key.encoderIdx, dir }); setSelectedKey(null); setSelectedMaskPart(false); setPopoverState(null)
  }, [])

  const handleKeyDoubleClick = useCallback((key: KleKey, rect: DOMRect, maskClicked: boolean) => {
    setSelectedKey({ row: key.row, col: key.col }); setSelectedMaskPart(maskClicked); setSelectedEncoder(null)
    setPopoverState({ anchorRect: rect, kind: 'key', row: key.row, col: key.col, maskClicked })
  }, [])

  const handleEncoderDoubleClick = useCallback((_key: KleKey, dir: number, rect: DOMRect) => {
    setSelectedEncoder({ idx: _key.encoderIdx, dir }); setSelectedKey(null)
    setPopoverState({ anchorRect: rect, kind: 'encoder', idx: _key.encoderIdx, dir })
  }, [])

  // --- Deselect ---
  const handleDeselect = useCallback(() => {
    clearSingleSelection(); clearMultiSelection(); clearPickerSelection(); setCopyLayerPending(false)
  }, [clearSingleSelection, clearMultiSelection, clearPickerSelection])

  const handleDeselectClick = useCallback((e: React.MouseEvent) => {
    if (!hasModifierKey(e)) handleDeselect()
  }, [handleDeselect])

  // --- Keycode handlers ---
  const handleKeycodeSelect = useCallback(async (kc: Keycode) => {
    clearPickerSelection(); clearPending()
    const code = deserialize(kc.qmkId)
    if (selectedKey) {
      await guard([code], async () => {
        const currentCode = keymap.get(`${currentLayer},${selectedKey.row},${selectedKey.col}`) ?? 0
        const finalCode = resolveKeycode(currentCode, code, isMaskKey)
        await onSetKey(currentLayer, selectedKey.row, selectedKey.col, finalCode)
        if (!isMaskKey && isMask(kc.qmkId) && autoAdvance) setSelectedMaskPart(true)
        else advanceToNextKey()
      })
    } else if (selectedEncoder) {
      await guard([code], async () => { await onSetEncoder(currentLayer, selectedEncoder.idx, selectedEncoder.dir, code) })
    } else {
      openTdModal(code); openMacroModal(code)
    }
  }, [selectedKey, selectedEncoder, currentLayer, keymap, isMaskKey, autoAdvance, onSetKey, onSetEncoder, advanceToNextKey, openTdModal, openMacroModal, guard, clearPending, clearPickerSelection])

  const handlePopoverKeycodeSelect = useCallback(async (kc: Keycode) => {
    clearPending()
    if (!popoverState) return
    const code = deserialize(kc.qmkId)
    if (popoverState.kind === 'key') {
      const mapKey = `${currentLayer},${popoverState.row},${popoverState.col}`
      const currentCode = keymap.get(mapKey) ?? 0
      const popoverMask = popoverState.maskClicked && isMask(serialize(currentCode))
      recordUndo(mapKey, currentCode)
      await guard([code], async () => { await onSetKey(currentLayer, popoverState.row, popoverState.col, resolveKeycode(currentCode, code, popoverMask)) })
    } else {
      const mapKey = `${currentLayer},${popoverState.idx},${popoverState.dir}`
      const currentCode = encoderLayout.get(mapKey) ?? 0
      recordUndo(mapKey, currentCode)
      await guard([code], async () => { await onSetEncoder(currentLayer, popoverState.idx, popoverState.dir, code) })
    }
  }, [popoverState, currentLayer, keymap, encoderLayout, onSetKey, onSetEncoder, guard, clearPending, recordUndo])

  const handlePopoverRawKeycodeSelect = useCallback(async (code: number) => {
    clearPending()
    if (!popoverState) return
    if (popoverState.kind === 'key') {
      const mapKey = `${currentLayer},${popoverState.row},${popoverState.col}`
      const currentCode = keymap.get(mapKey) ?? 0
      recordUndo(mapKey, currentCode)
      await guard([code], async () => { await onSetKey(currentLayer, popoverState.row, popoverState.col, code) })
    } else {
      const mapKey = `${currentLayer},${popoverState.idx},${popoverState.dir}`
      const currentCode = encoderLayout.get(mapKey) ?? 0
      recordUndo(mapKey, currentCode)
      await guard([code], async () => { await onSetEncoder(currentLayer, popoverState.idx, popoverState.dir, code) })
    }
  }, [popoverState, currentLayer, keymap, encoderLayout, onSetKey, onSetEncoder, guard, clearPending, recordUndo])

  const handlePopoverModMaskChange = useCallback(async (newMask: number) => {
    if (!popoverState || popoverState.kind !== 'key') return
    const currentCode = keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
    const basicKey = extractBasicKey(currentCode)
    const newCode = buildModMaskKeycode(newMask, basicKey)
    await guard([newCode], async () => { await onSetKey(currentLayer, popoverState.row, popoverState.col, newCode) })
  }, [popoverState, currentLayer, keymap, onSetKey, guard])

  const popoverUndoKeycode = useMemo(() => {
    if (!popoverState) return undefined
    const mapKey = popoverState.kind === 'key'
      ? `${currentLayer},${popoverState.row},${popoverState.col}`
      : `${currentLayer},${popoverState.idx},${popoverState.dir}`
    return undoMap.get(mapKey)
  }, [popoverState, currentLayer, undoMap])

  const handlePopoverUndo = useCallback(() => {
    if (popoverUndoKeycode == null) return
    handlePopoverRawKeycodeSelect(popoverUndoKeycode)
    setPopoverState(null)
  }, [popoverUndoKeycode, handlePopoverRawKeycodeSelect])

  // --- TD/Macro modal handlers ---
  const handleTdModalSave = useCallback(async (idx: number, entry: TapDanceEntry) => {
    const codes = [entry.onTap, entry.onHold, entry.onDoubleTap, entry.onTapHold]
    await guard(codes, async () => { await onSetTapDanceEntry?.(idx, entry); setTdModalIndex(null) })
  }, [onSetTapDanceEntry, guard])

  const handleTdModalClose = useCallback(() => { clearPending(); setTdModalIndex(null) }, [clearPending])
  const handleMacroModalClose = useCallback(() => { setMacroModalIndex(null) }, [])

  // --- Copy layer ---
  const handleCopyLayerClick = useCallback(async () => {
    if (!copyLayerPending) { setCopyLayerPending(true); return }
    setCopyLayerPending(false)
    if (inactivePaneLayer == null) return
    const src = currentLayer; const tgt = inactivePaneLayer
    await runCopy(async () => {
      const entries: BulkKeyEntry[] = []
      for (const [key, code] of keymap) {
        const [l, r, c] = key.split(',').map(Number)
        if (l === src) entries.push({ layer: tgt, row: r, col: c, keycode: code })
      }
      await onSetKeysBulk(entries)
      for (let i = 0; i < encoderCount; i++) {
        for (let dir = 0; dir < 2; dir++) {
          const code = encoderLayout.get(`${src},${i},${dir}`) ?? 0
          await onSetEncoder(tgt, i, dir, code)
        }
      }
    })
  }, [copyLayerPending, currentLayer, inactivePaneLayer, keymap, onSetKeysBulk, encoderLayout, encoderCount, onSetEncoder, runCopy])

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
    // Deselect
    handleDeselect,
    handleDeselectClick,
    // Copy
    isCopying,
    copyLayerPending,
    setCopyLayerPending,
    handleCopyLayerClick,
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
