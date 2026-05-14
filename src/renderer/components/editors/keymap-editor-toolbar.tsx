// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef } from 'react'
import { MIN_SCALE, MAX_SCALE } from './keymap-editor-types'
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_INACTIVE } from '../../constants/ui-tokens'

export function ScaleInput({ scale, onScaleChange }: { scale: number; onScaleChange: (delta: number) => void }) {
  const display = `${Math.round(scale * 100)}`
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(display)
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = useCallback(() => {
    setEditing(false)
    const parsed = parseInt(draft, 10)
    if (Number.isNaN(parsed)) return
    const newScale = Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, parsed / 100)) * 10) / 10
    const delta = newScale - scale
    if (delta !== 0) onScaleChange(delta)
  }, [draft, scale, onScaleChange])

  if (!editing) {
    return (
      <button
        type="button"
        data-testid="scale-display"
        className="size-scale-btn rounded-md border border-edge text-xs leading-none tabular-nums text-content-secondary hover:text-content transition-colors flex items-center justify-center"
        onClick={() => { setDraft(String(Math.round(scale * 100))); setEditing(true) }}
      >
        {display}
      </button>
    )
  }

  return (
    <input
      ref={inputRef}
      data-testid="scale-input"
      className="size-scale-btn rounded-md border border-accent bg-transparent text-xs leading-none tabular-nums text-content text-center outline-none"
      value={draft}
      autoFocus
      onFocus={() => inputRef.current?.select()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
      onBlur={commit}
    />
  )
}

export function toggleButtonClass(active: boolean): string {
  return active ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_INACTIVE
}
