// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ZoomIn, ZoomOut, Undo2, Redo2 } from 'lucide-react'
import { MIN_SCALE, MAX_SCALE, PANEL_COLLAPSED_WIDTH } from './keymap-editor-types'
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_INACTIVE, ICON_MD } from '../../constants/ui-tokens'
import { Tooltip } from '../ui/Tooltip'

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
      className="size-scale-btn rounded-md border border-accent bg-transparent text-xs leading-none tabular-nums text-content text-center focus:border-accent focus:outline-none"
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

// Ghost-style zoom button shared by the picker Keyboard tab and the
// View Matrix zoom row (kept identical so the two arrangements match).
export const ghostZoomButtonClass = 'rounded-md p-1 text-content-muted transition-colors hover:bg-surface-dim hover:text-content disabled:opacity-30 disabled:pointer-events-none'

export interface KeymapToolbarProps {
  typingTestMode?: boolean
  viewMatrixActive: boolean
  canUndo: boolean
  canRedo: boolean
  onUndo: () => Promise<void>
  onRedo: () => Promise<void>
  scale: number
  onScaleChange?: (delta: number) => void
}

/** The editor's left side rail: undo/redo on top, zoom controls centered.
 *  Undo/redo act on keymap edits, which View Matrix mode disables for its
 *  duration — hide them while the mode is active rather than leave dead
 *  disabled buttons in the toolbar. */
export function KeymapToolbar({
  typingTestMode, viewMatrixActive, canUndo, canRedo, onUndo, onRedo, scale, onScaleChange,
}: KeymapToolbarProps) {
  const { t } = useTranslation()
  const zoomButtonClass = `${toggleButtonClass(false)} disabled:opacity-30 disabled:pointer-events-none`

  // Zoom controls are shared between two placements: the side toolbar in
  // normal editing, and a row under the keymap pane while View Matrix mode
  // is active (see the mode's layout in KeymapEditor). Same
  // elements/props/testids either way — only the wrapping layout differs.
  const zoomControls = !typingTestMode && onScaleChange && (
    <>
      <Tooltip content={t('editor.keymap.zoomIn')} side="right">
        <button type="button" data-testid="zoom-in-button" aria-label={t('editor.keymap.zoomIn')} className={zoomButtonClass} disabled={scale >= MAX_SCALE} onClick={() => onScaleChange(0.1)}>
          <ZoomIn size={ICON_MD} aria-hidden="true" />
        </button>
      </Tooltip>
      <ScaleInput scale={scale} onScaleChange={onScaleChange} />
      <Tooltip content={t('editor.keymap.zoomOut')} side="right">
        <button type="button" data-testid="zoom-out-button" aria-label={t('editor.keymap.zoomOut')} className={zoomButtonClass} disabled={scale <= MIN_SCALE} onClick={() => onScaleChange(-0.1)}>
          <ZoomOut size={ICON_MD} aria-hidden="true" />
        </button>
      </Tooltip>
    </>
  )

  return (
    <div className="flex shrink-0 flex-col items-center gap-3 self-stretch" style={{ width: PANEL_COLLAPSED_WIDTH }}>
      {!typingTestMode && !viewMatrixActive && (
        <>
          <Tooltip content={t('editor.keymap.undo')} side="right">
            <button type="button" data-testid="undo-button" aria-label={t('editor.keymap.undo')} className={zoomButtonClass} disabled={!canUndo} onClick={() => void onUndo()}>
              <Undo2 size={ICON_MD} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={t('editor.keymap.redo')} side="right">
            <button type="button" data-testid="redo-button" aria-label={t('editor.keymap.redo')} className={zoomButtonClass} disabled={!canRedo} onClick={() => void onRedo()}>
              <Redo2 size={ICON_MD} aria-hidden="true" />
            </button>
          </Tooltip>
        </>
      )}
      <div className="flex-1" />
      {!viewMatrixActive && zoomControls}
      <div className="flex-1" />
    </div>
  )
}
