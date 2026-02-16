// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { PopoverTabKey } from './PopoverTabKey'
import { PopoverTabCode } from './PopoverTabCode'

type Tab = 'key' | 'code'

interface KeyPopoverProps {
  anchorRect: DOMRect
  currentKeycode: number
  maskOnly?: boolean
  onKeycodeSelect: (kc: Keycode) => void
  onRawKeycodeSelect: (code: number) => void
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
  onClose,
}: KeyPopoverProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('key')
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

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
  }, [anchorRect, activeTab])

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

  const handleKeycodeSelect = useCallback(
    (kc: Keycode) => {
      onKeycodeSelect(kc)
      onClose()
    },
    [onKeycodeSelect, onClose],
  )

  const handleRawKeycodeSelect = useCallback(
    (code: number) => {
      onRawKeycodeSelect(code)
      onClose()
    },
    [onRawKeycodeSelect, onClose],
  )

  const tabClass = (tab: Tab) => {
    const base = 'px-3 py-1.5 text-xs border-b-2 transition-colors whitespace-nowrap'
    if (activeTab === tab) return `${base} border-b-accent text-accent font-semibold`
    return `${base} border-b-transparent text-content-secondary hover:text-content`
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
      </div>

      <div className="p-3">
        {activeTab === 'key' && (
          <PopoverTabKey
            currentKeycode={currentKeycode}
            maskOnly={maskOnly}
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
