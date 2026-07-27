// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useRef, useEffect, useCallback } from 'react'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import {
  isModMaskKeycode,
  isModTapKeycode,
  isLTKeycode,
  isSHTKeycode,
  isLMKeycode,
  extractModMask,
  extractBasicKey,
  extractLTLayer,
  extractLMLayer,
  extractLMMod,
  resolve,
  buildModMaskKeycode,
  buildModTapKeycode,
  buildLTKeycode,
  buildSHTKeycode,
  buildLMKeycode,
} from '../../../shared/keycodes/keycodes'

export type WrapperMode = 'none' | 'modMask' | 'modTap' | 'lt' | 'shT' | 'lm'

type PendingAction = { kind: 'kc'; kc: Keycode } | { kind: 'raw'; code: number }

function detectWrapperMode(keycode: number, maskOnly?: boolean): WrapperMode {
  if (maskOnly) return 'none'
  if (isLTKeycode(keycode)) return 'lt'
  if (isSHTKeycode(keycode)) return 'shT'
  if (isLMKeycode(keycode)) return 'lm'
  if (isModTapKeycode(keycode)) return 'modTap'
  if (isModMaskKeycode(keycode)) return 'modMask'
  return 'none'
}

export interface UsePopoverKeycodeWorkflowOptions {
  currentKeycode: number
  maskOnly?: boolean
  currentLayer?: number
  onKeycodeSelect: (kc: Keycode) => void
  /** `advance` distinguishes a genuine keycode confirm (Code tab Apply,
   *  or a Key tab pick while a wrapper mode like LT/SH_T/LM/Mod-Tap/Mod-
   *  Mask is active) from a raw call that merely reconfigures the
   *  wrapper itself (mode-button switch, LT/LM layer change, modifier-
   *  checkbox-strip change) — see the call sites below. Callers that
   *  don't care (MacroEditor, KeycodeEntryModalShell) can ignore it. */
  onRawKeycodeSelect: (code: number, advance: boolean) => void
  onModMaskChange?: (newMask: number) => void
  onClose: () => void
  onConfirm?: () => void // Enter / click-to-close: confirm and close the picker
  quickSelect?: boolean  // true: click applies + closes; false: buffer until Enter
  /** When false, a confirmed keycode selection (quickSelect-immediate
   *  apply, or Enter/close-hint confirming a buffered pick) does not call
   *  onClose/onConfirm itself — the caller decides whether to close or
   *  move the popover elsewhere instead (the keymap editor's Auto Move
   *  follow-along). Matches every other caller's existing "confirm
   *  closes" contract when true. Does not affect Escape/outside-click/
   *  resize/the close button, which always close regardless. */
  closeOnSelect: boolean
  /** Clears the Key tab's search box — see `resetSearch`'s definition and
   *  rendering-concern rationale in `KeyPopover.tsx`. Called from the call
   *  sites below whenever this hook's own state changes in a way that
   *  should clear it. */
  resetSearch: () => void
}

export interface UsePopoverKeycodeWorkflowReturn {
  wrapperMode: WrapperMode
  selectedLayer: number
  showModeButtons: boolean
  showModStrip: boolean
  showLayerSelector: boolean
  currentModMask: number
  handleModStripChange: (newMask: number) => void
  handleLayerChange: (layer: number) => void
  handleModeSwitch: (newMode: WrapperMode) => void
  handleKeycodeSelect: (kc: Keycode) => void
  confirmAndClose: () => void
}

export function usePopoverKeycodeWorkflow({
  currentKeycode,
  maskOnly,
  currentLayer,
  onKeycodeSelect,
  onRawKeycodeSelect,
  onModMaskChange,
  onClose,
  onConfirm,
  quickSelect,
  closeOnSelect,
  resetSearch,
}: UsePopoverKeycodeWorkflowOptions): UsePopoverKeycodeWorkflowReturn {
  // When quickSelect is OFF, buffer search-result clicks until Enter confirms
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)

  // Wrapper mode: determines how modifier + basic key are combined
  const [wrapperMode, setWrapperMode] = useState<WrapperMode>(() => detectWrapperMode(currentKeycode, maskOnly))

  // Layer selection for LT / LM modes
  const [selectedLayer, setSelectedLayer] = useState<number>(() => {
    if (isLTKeycode(currentKeycode)) return extractLTLayer(currentKeycode)
    if (isLMKeycode(currentKeycode)) return extractLMLayer(currentKeycode)
    return 0
  })

  const showModeButtons = !maskOnly
  const showModStrip = wrapperMode === 'modMask' || wrapperMode === 'modTap' || wrapperMode === 'lm'
  const showLayerSelector = wrapperMode === 'lt' || wrapperMode === 'lm'
  const currentModMask = (() => {
    if (wrapperMode === 'lm') return extractLMMod(currentKeycode)
    if (wrapperMode === 'modMask' || wrapperMode === 'modTap') return extractModMask(currentKeycode)
    return 0
  })()

  const prevCurrentLayerRef = useRef(currentLayer)
  useEffect(() => {
    if (currentLayer == null || currentLayer === prevCurrentLayerRef.current) return
    prevCurrentLayerRef.current = currentLayer
    setWrapperMode(detectWrapperMode(currentKeycode, maskOnly))
    if (isLTKeycode(currentKeycode)) setSelectedLayer(extractLTLayer(currentKeycode))
    else if (isLMKeycode(currentKeycode)) setSelectedLayer(extractLMLayer(currentKeycode))
    else setSelectedLayer(0)
    resetSearch()
    setPendingAction(null)
  }, [currentLayer, currentKeycode, maskOnly, resetSearch])

  // Handle modifier strip changes — immediate keymap update, not a confirm (see the prop doc on `onRawKeycodeSelect`).
  const handleModStripChange = useCallback(
    (newMask: number) => {
      const basicKey = extractBasicKey(currentKeycode)
      if (wrapperMode === 'lm') {
        onRawKeycodeSelect(buildLMKeycode(selectedLayer, newMask), false)
      } else if (wrapperMode === 'modTap') {
        onRawKeycodeSelect(buildModTapKeycode(newMask, basicKey), false)
      } else if (onModMaskChange) {
        onModMaskChange(newMask)
      } else {
        onRawKeycodeSelect(buildModMaskKeycode(newMask, basicKey), false)
      }
    },
    [wrapperMode, currentKeycode, selectedLayer, onRawKeycodeSelect, onModMaskChange],
  )

  // Wrap a keycode selection into a PendingAction (shared by buffer + commit paths)
  const wrapKeycode = useCallback(
    (kc: Keycode): PendingAction => {
      const code = resolve(kc.qmkId)
      switch (wrapperMode) {
        case 'lt':   return { kind: 'raw', code: buildLTKeycode(selectedLayer, code) }
        case 'shT':  return { kind: 'raw', code: buildSHTKeycode(code) }
        case 'lm':   return { kind: 'raw', code: buildLMKeycode(selectedLayer, code) }
        case 'modTap':  return { kind: 'raw', code: buildModTapKeycode(currentModMask, code) }
        case 'modMask': return { kind: 'raw', code: buildModMaskKeycode(currentModMask, code) }
        default:     return { kind: 'kc', kc }
      }
    },
    [currentModMask, selectedLayer, wrapperMode],
  )

  // Apply a PendingAction to the keymap. Both branches represent a
  // genuine keycode confirm (a plain pick, or a wrapper-mode pick whose
  // inner key `wrapKeycode` folded into a raw build) — see the prop doc
  // on `onRawKeycodeSelect` for the contrast with the non-confirm raw
  // calls elsewhere in this file.
  const applyAction = useCallback(
    (action: PendingAction) => {
      if (action.kind === 'kc') onKeycodeSelect(action.kc)
      else onRawKeycodeSelect(action.code, true)
    },
    [onKeycodeSelect, onRawKeycodeSelect],
  )

  const handleKeycodeSelect = useCallback(
    (kc: Keycode) => {
      const action = wrapKeycode(kc)
      if (quickSelect === false) {
        setPendingAction(action)
      } else {
        applyAction(action)
        // Auto-close after immediate apply when quickSelect is on — unless
        // the caller wants to decide for itself (see `closeOnSelect`).
        if (closeOnSelect) (onConfirm ?? onClose)()
      }
    },
    [quickSelect, wrapKeycode, applyAction, onConfirm, onClose, closeOnSelect],
  )

  // Apply any buffered pending action then close the popover (unless
  // `closeOnSelect` is false — see its prop doc).
  const confirmAndClose = useCallback(() => {
    if (pendingAction) applyAction(pendingAction)
    if (closeOnSelect) (onConfirm ?? onClose)()
  }, [pendingAction, applyAction, onConfirm, onClose, closeOnSelect])

  // Refs so the keydown handler always sees latest values without re-subscribing
  const pendingRef = useRef(pendingAction)
  pendingRef.current = pendingAction
  const confirmAndCloseRef = useRef(confirmAndClose)
  confirmAndCloseRef.current = confirmAndClose

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Enter') {
        const el = e.target as HTMLElement | null
        // Allow Enter in inputs unless there's a buffered selection waiting to be confirmed
        if (!pendingRef.current && (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'BUTTON' || el?.isContentEditable)) return
        e.preventDefault()
        e.stopPropagation()
        confirmAndCloseRef.current()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  // Handle layer selector changes — immediate keycode rebuild, not a confirm (see the prop doc on `onRawKeycodeSelect`).
  const handleLayerChange = useCallback(
    (layer: number) => {
      setSelectedLayer(layer)
      const basicKey = extractBasicKey(currentKeycode)
      if (wrapperMode === 'lt') {
        onRawKeycodeSelect(buildLTKeycode(layer, basicKey), false)
      } else if (wrapperMode === 'lm') {
        onRawKeycodeSelect(buildLMKeycode(layer, currentModMask), false)
      }
    },
    [wrapperMode, currentKeycode, currentModMask, onRawKeycodeSelect],
  )

  // Switching modes converts the keycode format (preserving basic key) — reconfigures the wrapper only, not a confirm (see the prop doc on `onRawKeycodeSelect`).
  const handleModeSwitch = useCallback(
    (newMode: WrapperMode) => {
      // Toggle off if clicking the active mode
      const target = newMode === wrapperMode ? 'none' : newMode
      // LM keycodes store modifiers (not a basic key) in the lower bits,
      // so extractBasicKey would return the modifier value (e.g. MOD_LGUI=0x08=KC_E).
      const basicKey = wrapperMode === 'lm' ? 0 : extractBasicKey(currentKeycode)

      if (target === 'none') {
        // Turning off: revert to basic key
        if (basicKey !== currentKeycode) {
          onRawKeycodeSelect(basicKey, false)
        }
      } else {
        // Switching to a new mode: rebuild keycode
        switch (target) {
          case 'lt':
            onRawKeycodeSelect(buildLTKeycode(selectedLayer, basicKey), false)
            break
          case 'shT':
            onRawKeycodeSelect(buildSHTKeycode(basicKey), false)
            break
          case 'lm':
            onRawKeycodeSelect(buildLMKeycode(selectedLayer, 0), false)
            break
          case 'modTap': {
            // Only preserve mod mask when switching from another mod-based mode
            const mask = (wrapperMode === 'modMask' || wrapperMode === 'modTap') ? extractModMask(currentKeycode) : 0
            onRawKeycodeSelect(buildModTapKeycode(mask, basicKey), false)
            break
          }
          case 'modMask': {
            const mask = (wrapperMode === 'modMask' || wrapperMode === 'modTap') ? extractModMask(currentKeycode) : 0
            onRawKeycodeSelect(buildModMaskKeycode(mask, basicKey), false)
            break
          }
        }
      }

      // Force PopoverTabKey remount to clear search when leaving LM mode
      if (wrapperMode === 'lm' && target !== 'lm') {
        resetSearch()
      }
      setWrapperMode(target)
    },
    [wrapperMode, currentKeycode, selectedLayer, onRawKeycodeSelect, resetSearch],
  )

  return {
    wrapperMode,
    selectedLayer,
    showModeButtons,
    showModStrip,
    showLayerSelector,
    currentModMask,
    handleModStripChange,
    handleLayerChange,
    handleModeSwitch,
    handleKeycodeSelect,
    confirmAndClose,
  }
}
