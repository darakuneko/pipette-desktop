// SPDX-License-Identifier: GPL-2.0-or-later
// Popover used by the Finger Assignment modal. Shows the 10 finger
// options grouped by hand plus a "reset to estimate" row. Click-to-apply
// (quickSelect) — selecting closes the popover. Escape / outside click
// cancels without changing the value.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme'
import { fingerColor } from './finger-colors'

interface Props {
  anchorRect: DOMRect
  currentFinger: FingerType | undefined
  isOverride: boolean
  onSelect: (finger: FingerType) => void
  onReset: () => void
  onClose: () => void
}

const LEFT_ORDER: FingerType[] = [
  'left-pinky',
  'left-ring',
  'left-middle',
  'left-index',
  'left-thumb',
]
const RIGHT_ORDER: FingerType[] = [
  'right-thumb',
  'right-index',
  'right-middle',
  'right-ring',
  'right-pinky',
]

const POPOVER_WIDTH = 180
const POPOVER_GAP = 6

export function FingerSelectPopover({
  anchorRect,
  currentFinger,
  isOverride,
  onSelect,
  onReset,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const theme = useEffectiveTheme()
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!el) return
    const popH = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight

    let top = anchorRect.bottom + POPOVER_GAP
    if (top + popH > vh && anchorRect.top - POPOVER_GAP - popH > 0) {
      top = anchorRect.top - POPOVER_GAP - popH
    }
    let left = anchorRect.left + anchorRect.width / 2 - POPOVER_WIDTH / 2
    left = Math.max(4, Math.min(left, vw - POPOVER_WIDTH - 4))
    setPosition({ top, left })
  }, [anchorRect])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const handleOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleEscape)
    window.addEventListener('mousedown', handleOutside)
    return () => {
      window.removeEventListener('keydown', handleEscape)
      window.removeEventListener('mousedown', handleOutside)
    }
  }, [onClose])

  const renderOption = (finger: FingerType) => {
    const isCurrent = finger === currentFinger
    return (
      <button
        key={finger}
        type="button"
        className={`flex w-full items-center justify-between px-3 py-1 text-left text-[12px] transition-colors ${
          isCurrent
            ? 'bg-accent/15 font-semibold text-content'
            : 'text-content-secondary hover:bg-surface-dim'
        }`}
        onClick={() => onSelect(finger)}
        data-testid={`finger-select-${finger}`}
      >
        <span className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rounded-full border border-edge"
            style={{ backgroundColor: fingerColor(finger, theme) }}
            aria-hidden="true"
          />
          <span>{t(`analyze.ergonomics.finger.${finger}`)}</span>
        </span>
        {isCurrent && <span aria-hidden="true">✓</span>}
      </button>
    )
  }

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 rounded-md border border-edge bg-surface shadow-lg"
      style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
      role="dialog"
      aria-label={t('analyze.fingerAssignment.popoverLabel')}
      data-testid="finger-select-popover"
      // The popover renders in the backdrop layer (outside the modal panel)
      // so click events would bubble to the backdrop's onClose handler and
      // dismiss the modal. Stop propagation so finger picks only affect
      // the draft, not the modal lifecycle.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-content-muted">
        {t('analyze.fingerAssignment.leftHand')}
      </div>
      {LEFT_ORDER.map(renderOption)}
      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-content-muted">
        {t('analyze.fingerAssignment.rightHand')}
      </div>
      {RIGHT_ORDER.map(renderOption)}
      <div className="border-t border-edge">
        <button
          type="button"
          className="w-full px-3 py-1.5 text-left text-[12px] text-content-muted transition-colors hover:bg-surface-dim hover:text-content disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-content-muted"
          onClick={onReset}
          disabled={!isOverride}
          data-testid="finger-select-reset"
        >
          {t('analyze.fingerAssignment.reset')}
        </button>
      </div>
    </div>
  )
}
