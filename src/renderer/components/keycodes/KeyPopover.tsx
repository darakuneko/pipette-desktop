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

interface KeyPopoverProps {
  anchorRect: DOMRect
  currentKeycode: number
  maskOnly?: boolean
  layers?: number
  onKeycodeSelect: (kc: Keycode) => void
  onRawKeycodeSelect: (code: number) => void
  onModMaskChange?: (newMask: number) => void
  onClose: () => void
}

const POPOVER_WIDTH = 320
const POPOVER_GAP = 6

export function KeyPopover({
  anchorRect,
  currentKeycode,
  maskOnly,
  layers = 16,
  onKeycodeSelect,
  onRawKeycodeSelect,
  onModMaskChange,
  onClose,
}: KeyPopoverProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('key')
  // Incremented when leaving LM mode to force PopoverTabKey remount (clears search)
  const [searchResetKey, setSearchResetKey] = useState(0)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

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
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

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

  const handleKeycodeSelect = useCallback(
    (kc: Keycode) => {
      const code = resolve(kc.qmkId)
      switch (wrapperMode) {
        case 'lt':
          onRawKeycodeSelect(buildLTKeycode(selectedLayer, code))
          break
        case 'shT':
          onRawKeycodeSelect(buildSHTKeycode(code))
          break
        case 'lm':
          onRawKeycodeSelect(buildLMKeycode(selectedLayer, code))
          break
        case 'modTap':
          onRawKeycodeSelect(buildModTapKeycode(currentModMask, code))
          break
        case 'modMask':
          onRawKeycodeSelect(buildModMaskKeycode(currentModMask, code))
          break
        default:
          onKeycodeSelect(kc)
      }
    },
    [currentModMask, selectedLayer, wrapperMode, onKeycodeSelect, onRawKeycodeSelect],
  )

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
            className={modeButtonClass('lm')}
            onClick={() => handleModeSwitch('lm')}
            data-testid="popover-mode-lm"
          >
            {t('editor.keymap.keyPopover.lm')}
          </button>
          <button
            type="button"
            className={modeButtonClass('shT')}
            onClick={() => handleModeSwitch('shT')}
            data-testid="popover-mode-sh-t"
          >
            {t('editor.keymap.keyPopover.shT')}
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
            maskOnly={maskOnly}
            modMask={currentModMask}
            basicKeyOnly={wrapperMode === 'lt' || wrapperMode === 'shT'}
            onKeycodeSelect={handleKeycodeSelect}
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
    </div>
  )
}
