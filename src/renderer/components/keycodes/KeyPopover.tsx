// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import {
  isModMaskKeycode,
  isModTapKeycode,
  extractModMask,
  extractBasicKey,
  resolve,
  buildModMaskKeycode,
  buildModTapKeycode,
} from '../../../shared/keycodes/keycodes'
import { PopoverTabKey } from './PopoverTabKey'
import { PopoverTabCode } from './PopoverTabCode'
import { ModifierCheckboxStrip } from './ModifierCheckboxStrip'

type Tab = 'key' | 'code'
type WrapperMode = 'none' | 'modMask' | 'modTap'

interface KeyPopoverProps {
  anchorRect: DOMRect
  currentKeycode: number
  maskOnly?: boolean
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
  onKeycodeSelect,
  onRawKeycodeSelect,
  onModMaskChange,
  onClose,
}: KeyPopoverProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('key')
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  // Wrapper mode: determines how modifier + basic key are combined
  const [wrapperMode, setWrapperMode] = useState<WrapperMode>(() => {
    if (maskOnly) return 'none'
    if (isModTapKeycode(currentKeycode)) return 'modTap'
    if (isModMaskKeycode(currentKeycode)) return 'modMask'
    return 'none'
  })

  const showModeButtons = !maskOnly
  const showModStrip = wrapperMode !== 'none'
  // extractModMask works for both modifier-mask and mod-tap keycodes (bits 8-12)
  const currentModMask = showModStrip ? extractModMask(currentKeycode) : 0

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

  // Handle modifier strip changes — immediate keymap update for both modes
  const handleModStripChange = useCallback(
    (newMask: number) => {
      const basicKey = extractBasicKey(currentKeycode)
      if (wrapperMode === 'modTap') {
        onRawKeycodeSelect(buildModTapKeycode(newMask, basicKey))
      } else if (onModMaskChange) {
        onModMaskChange(newMask)
      } else {
        onRawKeycodeSelect(buildModMaskKeycode(newMask, basicKey))
      }
    },
    [wrapperMode, currentKeycode, onRawKeycodeSelect, onModMaskChange],
  )

  const handleKeycodeSelect = useCallback(
    (kc: Keycode) => {
      const basicCode = resolve(kc.qmkId)
      if (wrapperMode !== 'none') {
        if (wrapperMode === 'modTap') {
          onRawKeycodeSelect(buildModTapKeycode(currentModMask, basicCode))
        } else {
          onRawKeycodeSelect(buildModMaskKeycode(currentModMask, basicCode))
        }
      } else {
        onKeycodeSelect(kc)
      }
    },
    [currentModMask, wrapperMode, onKeycodeSelect, onRawKeycodeSelect],
  )

  const handleRawKeycodeSelect = useCallback(
    (code: number) => {
      onRawKeycodeSelect(code)
    },
    [onRawKeycodeSelect],
  )

  // Switching modes converts the keycode format (preserving modifier + basic key)
  const handleModeSwitch = useCallback(
    (newMode: WrapperMode) => {
      // Toggle off if clicking the active mode
      const target = newMode === wrapperMode ? 'none' : newMode

      // Convert keycode when switching between modMask/modTap with modifiers set
      const mask = extractModMask(currentKeycode)
      const basicKey = extractBasicKey(currentKeycode)
      if (mask > 0 && target !== 'none' && target !== wrapperMode) {
        if (target === 'modTap') {
          onRawKeycodeSelect(buildModTapKeycode(mask, basicKey))
        } else {
          onRawKeycodeSelect(buildModMaskKeycode(mask, basicKey))
        }
      }

      setWrapperMode(target)
    },
    [wrapperMode, currentKeycode, onRawKeycodeSelect],
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
        {activeTab === 'key' && (
          <PopoverTabKey
            currentKeycode={currentKeycode}
            maskOnly={maskOnly}
            modMask={currentModMask}
            onKeycodeSelect={handleKeycodeSelect}
          />
        )}
        {activeTab === 'code' && (
          <PopoverTabCode
            currentKeycode={currentKeycode}
            maskOnly={maskOnly}
            onRawKeycodeSelect={handleRawKeycodeSelect}
          />
        )}
      </div>
    </div>
  )
}
