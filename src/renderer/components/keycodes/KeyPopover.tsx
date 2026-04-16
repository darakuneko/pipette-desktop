// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
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
  serialize,
  buildModMaskKeycode,
  buildModTapKeycode,
  buildLTKeycode,
  buildSHTKeycode,
  buildLMKeycode,
} from '../../../shared/keycodes/keycodes'
import { PopoverTabKey } from './PopoverTabKey'
import { PopoverTabCode } from './PopoverTabCode'
import { ModifierCheckboxStrip } from './ModifierCheckboxStrip'
import { LayerSelector } from './LayerSelector'

type Tab = 'key' | 'code'
type WrapperMode = 'none' | 'modMask' | 'modTap' | 'lt' | 'shT' | 'lm'

type PendingAction = { kind: 'kc'; kc: Keycode } | { kind: 'raw'; code: number }

interface KeyPopoverProps {
  anchorRect: DOMRect
  currentKeycode: number
  emptyInitial?: boolean   // When true, start with empty search (no current keycode)
  maskOnly?: boolean
  layers?: number
  onKeycodeSelect: (kc: Keycode) => void
  onRawKeycodeSelect: (code: number) => void
  onModMaskChange?: (newMask: number) => void
  onClose: () => void
  onConfirm?: () => void // Enter / click-to-close: confirm and close the picker
  quickSelect?: boolean  // true: click applies + closes; false: buffer until Enter
  previousKeycode?: number // Previous keycode for undo (undefined = no undo available)
  onUndo?: () => void      // Revert to previousKeycode and close
  nextKeycode?: number     // Next keycode for redo (undefined = no redo available)
  onRedo?: () => void      // Re-apply nextKeycode and close
}

const POPOVER_WIDTH = 320
const POPOVER_GAP = 6

export function KeyPopover({
  anchorRect,
  currentKeycode,
  emptyInitial,
  maskOnly,
  layers = 16,
  onKeycodeSelect,
  onRawKeycodeSelect,
  onModMaskChange,
  onClose,
  onConfirm,
  quickSelect,
  previousKeycode,
  onUndo,
  nextKeycode,
  onRedo,
}: KeyPopoverProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('key')
  // Incremented when leaving LM mode to force PopoverTabKey remount (clears search)
  const [searchResetKey, setSearchResetKey] = useState(0)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  // When quickSelect is OFF, buffer search-result clicks until Enter confirms
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)

  // Wrapper mode: determines how modifier + basic key are combined
  const [wrapperMode, setWrapperMode] = useState<WrapperMode>(() => {
    if (maskOnly) return 'none'
    if (isLTKeycode(currentKeycode)) return 'lt'
    if (isSHTKeycode(currentKeycode)) return 'shT'
    if (isLMKeycode(currentKeycode)) return 'lm'
    if (isModTapKeycode(currentKeycode)) return 'modTap'
    if (isModMaskKeycode(currentKeycode)) return 'modMask'
    return 'none'
  })

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

  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!el) return

    const popH = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight

    // Vertical: prefer below the key, flip above if not enough space
    let top = anchorRect.bottom + POPOVER_GAP
    if (top + popH > vh && anchorRect.top - POPOVER_GAP - popH > 0) {
      top = anchorRect.top - POPOVER_GAP - popH
    }
    top = Math.max(4, Math.min(top, vh - popH - 4))

    // Horizontal: center on the key, clamp to viewport
    let left = anchorRect.left + anchorRect.width / 2 - POPOVER_WIDTH / 2
    left = Math.max(4, Math.min(left, vw - POPOVER_WIDTH - 4))

    setPosition({ top, left })
  }, [anchorRect, activeTab, wrapperMode])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (popoverRef.current && target && !popoverRef.current.contains(target)) {
        onClose()
      }
    }
    // Delay to prevent the opening double-click from immediately closing
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', handler, true)
    }, 0)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousedown', handler, true)
    }
  }, [onClose])

  useEffect(() => {
    window.addEventListener('resize', onClose)
    return () => window.removeEventListener('resize', onClose)
  }, [onClose])

  // Handle modifier strip changes — immediate keymap update
  const handleModStripChange = useCallback(
    (newMask: number) => {
      const basicKey = extractBasicKey(currentKeycode)
      if (wrapperMode === 'lm') {
        onRawKeycodeSelect(buildLMKeycode(selectedLayer, newMask))
      } else if (wrapperMode === 'modTap') {
        onRawKeycodeSelect(buildModTapKeycode(newMask, basicKey))
      } else if (onModMaskChange) {
        onModMaskChange(newMask)
      } else {
        onRawKeycodeSelect(buildModMaskKeycode(newMask, basicKey))
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

  // Apply a PendingAction to the keymap
  const applyAction = useCallback(
    (action: PendingAction) => {
      if (action.kind === 'kc') onKeycodeSelect(action.kc)
      else onRawKeycodeSelect(action.code)
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
        // Auto-close after immediate apply when quickSelect is on
        ;(onConfirm ?? onClose)()
      }
    },
    [quickSelect, wrapKeycode, applyAction, onConfirm, onClose],
  )

  // Apply any buffered pending action then close the popover
  const confirmAndClose = useCallback(() => {
    if (pendingAction) applyAction(pendingAction)
    ;(onConfirm ?? onClose)()
  }, [pendingAction, applyAction, onConfirm, onClose])

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

  // Handle layer selector changes — immediate keycode rebuild
  const handleLayerChange = useCallback(
    (layer: number) => {
      setSelectedLayer(layer)
      const basicKey = extractBasicKey(currentKeycode)
      if (wrapperMode === 'lt') {
        onRawKeycodeSelect(buildLTKeycode(layer, basicKey))
      } else if (wrapperMode === 'lm') {
        onRawKeycodeSelect(buildLMKeycode(layer, currentModMask))
      }
    },
    [wrapperMode, currentKeycode, currentModMask, onRawKeycodeSelect],
  )

  // Switching modes converts the keycode format (preserving basic key)
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
          onRawKeycodeSelect(basicKey)
        }
      } else {
        // Switching to a new mode: rebuild keycode
        switch (target) {
          case 'lt':
            onRawKeycodeSelect(buildLTKeycode(selectedLayer, basicKey))
            break
          case 'shT':
            onRawKeycodeSelect(buildSHTKeycode(basicKey))
            break
          case 'lm':
            onRawKeycodeSelect(buildLMKeycode(selectedLayer, 0))
            break
          case 'modTap': {
            // Only preserve mod mask when switching from another mod-based mode
            const mask = (wrapperMode === 'modMask' || wrapperMode === 'modTap') ? extractModMask(currentKeycode) : 0
            onRawKeycodeSelect(buildModTapKeycode(mask, basicKey))
            break
          }
          case 'modMask': {
            const mask = (wrapperMode === 'modMask' || wrapperMode === 'modTap') ? extractModMask(currentKeycode) : 0
            onRawKeycodeSelect(buildModMaskKeycode(mask, basicKey))
            break
          }
        }
      }

      // Force PopoverTabKey remount to clear search when leaving LM mode
      if (wrapperMode === 'lm' && target !== 'lm') {
        setSearchResetKey((k) => k + 1)
      }
      setWrapperMode(target)
    },
    [wrapperMode, currentKeycode, selectedLayer, onRawKeycodeSelect],
  )

  const tabClass = (tab: Tab) => {
    const base = 'px-3 py-1.5 text-xs border-b-2 transition-colors whitespace-nowrap'
    if (activeTab === tab) return `${base} border-b-accent text-accent font-semibold`
    return `${base} border-b-transparent text-content-secondary hover:text-content`
  }

  const modeButtonClass = (mode: WrapperMode) => {
    const base = 'rounded px-2 py-0.5 text-xs font-medium transition-colors'
    if (wrapperMode === mode) return `${base} bg-blue-600 text-white`
    return `${base} bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600`
  }

  return (
    <div
      ref={popoverRef}
      data-popover="key"
      className="fixed z-50 rounded-lg border border-edge bg-surface-alt shadow-xl"
      style={{
        top: position.top,
        left: position.left,
        width: POPOVER_WIDTH,
      }}
      data-testid="key-popover"
    >
      <div className="flex border-b border-edge-subtle px-2 pt-1">
        <button type="button" className={tabClass('key')} onClick={() => setActiveTab('key')} data-testid="popover-tab-key">
          {t('editor.keymap.keyPopover.keyTab')}
        </button>
        <button type="button" className={tabClass('code')} onClick={() => setActiveTab('code')} data-testid="popover-tab-code">
          {t('editor.keymap.keyPopover.codeTab')}
        </button>
        <div className="ml-auto flex items-center">
          <button
            type="button"
            className="rounded p-1 text-content-secondary hover:bg-surface-dim hover:text-content"
            onClick={onClose}
            data-testid="popover-close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
      </div>

      {activeTab === 'key' && showModeButtons && (
        <div className="flex gap-1 border-b border-edge-subtle px-3 py-1.5">
          <button
            type="button"
            className={modeButtonClass('modMask')}
            onClick={() => handleModeSwitch('modMask')}
            data-testid="popover-mode-mod-mask"
          >
            {t('editor.keymap.keyPopover.modMask')}
          </button>
          <button
            type="button"
            className={modeButtonClass('modTap')}
            onClick={() => handleModeSwitch('modTap')}
            data-testid="popover-mode-mod-tap"
          >
            {t('editor.keymap.keyPopover.modTap')}
          </button>
          <button
            type="button"
            className={modeButtonClass('lt')}
            onClick={() => handleModeSwitch('lt')}
            data-testid="popover-mode-lt"
          >
            {t('editor.keymap.keyPopover.lt')}
          </button>
          <button
            type="button"
            className={modeButtonClass('shT')}
            onClick={() => handleModeSwitch('shT')}
            data-testid="popover-mode-sh-t"
          >
            {t('editor.keymap.keyPopover.shT')}
          </button>
          <button
            type="button"
            className={modeButtonClass('lm')}
            onClick={() => handleModeSwitch('lm')}
            data-testid="popover-mode-lm"
          >
            {t('editor.keymap.keyPopover.lm')}
          </button>
        </div>
      )}

      {activeTab === 'key' && showLayerSelector && (
        <div className="border-b border-edge-subtle px-3 py-2">
          <LayerSelector
            layers={layers}
            selectedLayer={selectedLayer}
            onChange={handleLayerChange}
          />
        </div>
      )}

      {activeTab === 'key' && showModStrip && (
        <div className="border-b border-edge-subtle px-3 py-2">
          <ModifierCheckboxStrip
            modMask={currentModMask}
            onChange={handleModStripChange}
          />
        </div>
      )}

      <div className="p-3">
        {activeTab === 'key' && wrapperMode !== 'lm' && (
          <PopoverTabKey
            key={searchResetKey}
            // LM keycodes store modifier bits where the basic key normally lives (see line 209).
            // After a mode switch away from LM, currentKeycode may still hold the stale LM value
            // for one render frame before the parent propagates the rebuilt keycode.
            currentKeycode={isLMKeycode(currentKeycode) ? 0 : currentKeycode}
            emptyInitial={emptyInitial}
            maskOnly={maskOnly}
            modMask={currentModMask}
            basicKeyOnly={wrapperMode === 'lt' || wrapperMode === 'shT'}
            onKeycodeSelect={handleKeycodeSelect}
            onClose={confirmAndClose}
          />
        )}
        {activeTab === 'code' && (
          <PopoverTabCode
            currentKeycode={currentKeycode}
            maskOnly={maskOnly}
            onRawKeycodeSelect={onRawKeycodeSelect}
          />
        )}
      </div>

      {((previousKeycode != null && onUndo) || (nextKeycode != null && onRedo)) && (
        <div className="border-t border-edge-subtle px-3 py-1.5 space-y-0.5">
          {previousKeycode != null && onUndo && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs text-content-secondary hover:bg-surface-dim hover:text-content"
              onClick={onUndo}
              data-testid="popover-undo"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0">
                <path fillRule="evenodd" d="M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z" clipRule="evenodd" />
              </svg>
              <span>{t('editor.keymap.keyPopover.undo')}</span>
              <span className="ml-auto font-mono text-content-muted">{serialize(previousKeycode)}</span>
            </button>
          )}
          {nextKeycode != null && onRedo && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs text-content-secondary hover:bg-surface-dim hover:text-content"
              onClick={onRedo}
              data-testid="popover-redo"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0">
                <path fillRule="evenodd" d="M12.207 2.232a.75.75 0 0 0 .025 1.06l4.146 3.958H6.375a5.375 5.375 0 0 0 0 10.75H9.25a.75.75 0 0 0 0-1.5H6.375a3.875 3.875 0 0 1 0-7.75h10.003l-4.146 3.957a.75.75 0 0 0 1.036 1.085l5.5-5.25a.75.75 0 0 0 0-1.085l-5.5-5.25a.75.75 0 0 0-1.06.025Z" clipRule="evenodd" />
              </svg>
              <span>{t('editor.keymap.keyPopover.redo')}</span>
              <span className="ml-auto font-mono text-content-muted">{serialize(nextKeycode)}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
