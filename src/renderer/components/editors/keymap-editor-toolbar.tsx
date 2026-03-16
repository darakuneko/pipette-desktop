// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef } from 'react'
import { MIN_SCALE, MAX_SCALE } from './keymap-editor-types'

const TOOLTIP_STYLE = 'pointer-events-none absolute z-50 rounded-md border border-edge bg-surface-alt px-2.5 py-1.5 shadow-lg text-xs font-medium text-content whitespace-nowrap opacity-0 transition-opacity delay-300'

export function IconTooltip({ label, side = 'right', children }: {
  label: string
  side?: 'right' | 'top-end'
  children: React.ReactNode
}) {
  const posClass = side === 'right'
    ? 'left-full top-1/2 -translate-y-1/2 ml-2'
    : 'bottom-full right-0 mb-2'
  return (
    <div className="group/tip relative">
      {children}
      <div className={`${TOOLTIP_STYLE} ${posClass} group-hover/tip:opacity-100`}>
        {label}
      </div>
    </div>
  )
}

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
        className="size-[34px] rounded-md border border-edge text-[11px] leading-none tabular-nums text-content-secondary hover:text-content transition-colors flex items-center justify-center"
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
      className="size-[34px] rounded-md border border-accent bg-transparent text-[11px] leading-none tabular-nums text-content text-center outline-none"
      value={draft}
      autoFocus
      onFocus={() => inputRef.current?.select()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
      onBlur={commit}
    />
  )
}

export const CONTROL_BASE = 'rounded-md border p-2'

export function toggleButtonClass(active: boolean): string {
  const base = `${CONTROL_BASE} transition-colors`
  if (active) return `${base} border-accent bg-accent/10 text-accent`
  return `${base} border-edge text-content-secondary hover:text-content`
}
