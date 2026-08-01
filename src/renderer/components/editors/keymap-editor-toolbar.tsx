// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ZoomIn, ZoomOut, Undo2, Redo2 } from 'lucide-react'
import { MIN_SCALE, MAX_SCALE, PANEL_COLLAPSED_WIDTH } from './keymap-editor-types'
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_INACTIVE, ICON_MD, ICON_SM } from '../../constants/ui-tokens'
import { Tooltip } from '../ui/Tooltip'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../../shared/types/protocol'
import type { MacroAction } from '../../../preload/macro'
import type { EntryJsonEditor, MacroJsonEditor } from './useKeymapJsonEditors'

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

export interface ViewMatrixZoomRowProps {
  scale: number
  onScaleChange?: (delta: number) => void
}

/** View Matrix mode's relocated zoom row — same controls as the normal-mode
 *  toolbar (`KeymapToolbar`'s own `zoomControls`), moved below the keymap
 *  pane — plus the same Ctrl/Shift multi-select hint the keycode picker
 *  shows in normal mode (reused key: the picker is hidden entirely for the
 *  mode's duration, but the Ctrl+click / Shift+click gestures it describes
 *  still drive this mode's own multi-selection). */
export function ViewMatrixZoomRow({ scale, onScaleChange }: ViewMatrixZoomRowProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center gap-1">
      <p className="text-xs text-content-muted">{t('editor.keymap.pickerHint')}</p>
      {/* Same arrangement as the picker Keyboard tab's zoom row: ZoomOut,
          scale, ZoomIn in ghost styling. */}
      {onScaleChange && (
        <div className="flex items-center gap-1">
          <Tooltip content={t('editor.keymap.zoomOut')}>
            <button type="button" data-testid="zoom-out-button" aria-label={t('editor.keymap.zoomOut')}
              className={ghostZoomButtonClass} disabled={scale <= MIN_SCALE} onClick={() => onScaleChange(-0.1)}>
              <ZoomOut size={ICON_SM} aria-hidden="true" />
            </button>
          </Tooltip>
          <ScaleInput scale={scale} onScaleChange={onScaleChange} />
          <Tooltip content={t('editor.keymap.zoomIn')}>
            <button type="button" data-testid="zoom-in-button" aria-label={t('editor.keymap.zoomIn')}
              className={ghostZoomButtonClass} disabled={scale >= MAX_SCALE} onClick={() => onScaleChange(0.1)}>
              <ZoomIn size={ICON_SM} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

export interface UseKeymapTabFooterOptions {
  tapDanceEntries?: TapDanceEntry[]
  comboEntries?: ComboEntry[]
  keyOverrideEntries?: KeyOverrideEntry[]
  altRepeatKeyEntries?: AltRepeatKeyEntry[]
  deserializedMacros?: MacroAction[][] | null
  tapHoldSupported?: boolean
  mouseKeysSupported?: boolean
  magicSupported?: boolean
  graveEscapeSupported?: boolean
  autoShiftSupported?: boolean
  oneShotKeysSupported?: boolean
  comboSettingsSupported?: boolean
  onOpenLighting?: () => void
  openSettings: (key: string) => void
  tdJson: EntryJsonEditor<TapDanceEntry>
  comboJson: EntryJsonEditor<ComboEntry>
  koJson: EntryJsonEditor<KeyOverrideEntry>
  arkJson: EntryJsonEditor<AltRepeatKeyEntry>
  macroJson: MacroJsonEditor
}

/** Per-tab footer buttons (Edit JSON / settings shortcuts) shown under the
 *  keycode picker's tab strip — grouped by which tab each button belongs to
 *  so `TabbedKeycodes` can render only the group matching its active tab. */
export function useKeymapTabFooter({
  tapDanceEntries, comboEntries, keyOverrideEntries, altRepeatKeyEntries, deserializedMacros,
  tapHoldSupported, mouseKeysSupported, magicSupported, graveEscapeSupported, autoShiftSupported, oneShotKeysSupported, comboSettingsSupported,
  onOpenLighting, openSettings, tdJson, comboJson, koJson, arkJson, macroJson,
}: UseKeymapTabFooterOptions): Record<string, React.ReactNode> {
  const { t } = useTranslation()
  return useMemo(() => {
    const btnClass = 'rounded border border-edge px-3 py-1 text-xs text-content-secondary hover:text-content hover:bg-surface-dim'
    const buttonDefs = [
      { tab: 'tapDance', key: 'tdJsonEditor', label: t('editor.tapDance.editJson'), onClick: tdJson.open, testId: 'tap-dance-json-editor-btn', enabled: !!tapDanceEntries && tapDanceEntries.length > 0 },
      { tab: 'tapDance', key: 'tapHold', label: t('editor.keymap.tapHoldLabel'), onClick: () => openSettings('tapHold'), testId: 'tap-hold-settings-btn', enabled: tapHoldSupported },
      { tab: 'system', key: 'mouseKeys', label: t('editor.keymap.mouseKeysLabel'), onClick: () => openSettings('mouseKeys'), testId: 'mouse-keys-settings-btn', enabled: mouseKeysSupported },
      { tab: 'modifiers', key: 'graveEscape', label: t('editor.keymap.graveEscapeLabel'), onClick: () => openSettings('graveEscape'), testId: 'grave-escape-settings-btn', enabled: graveEscapeSupported },
      { tab: 'modifiers', key: 'oneShotKeys', label: t('editor.keymap.oneShotKeysLabel'), onClick: () => openSettings('oneShotKeys'), testId: 'one-shot-keys-settings-btn', enabled: oneShotKeysSupported },
      { tab: 'behavior', key: 'magic', label: t('editor.keymap.magicLabel'), onClick: () => openSettings('magic'), testId: 'magic-settings-btn', enabled: magicSupported },
      { tab: 'behavior', key: 'autoshift', label: t('editor.keymap.autoShiftLabel'), onClick: () => openSettings('autoShift'), testId: 'auto-shift-settings-btn', enabled: autoShiftSupported },
      { tab: 'macro', key: 'macroJsonEditor', label: t('editor.tapDance.editJson'), onClick: macroJson.openGated, testId: 'macro-json-editor-btn', enabled: !!deserializedMacros && deserializedMacros.length > 0 },
      { tab: 'combo', key: 'comboJsonEditor', label: t('editor.tapDance.editJson'), onClick: comboJson.open, testId: 'combo-json-editor-btn', enabled: !!comboEntries && comboEntries.length > 0 },
      { tab: 'combo', key: 'combo', label: t('common.configuration'), onClick: () => openSettings('combo'), testId: 'combo-settings-btn', enabled: comboSettingsSupported },
      { tab: 'keyOverride', key: 'koJsonEditor', label: t('editor.tapDance.editJson'), onClick: koJson.open, testId: 'ko-json-editor-btn', enabled: !!keyOverrideEntries && keyOverrideEntries.length > 0 },
      { tab: 'altRepeatKey', key: 'arkJsonEditor', label: t('editor.tapDance.editJson'), onClick: arkJson.open, testId: 'ark-json-editor-btn', enabled: !!altRepeatKeyEntries && altRepeatKeyEntries.length > 0 },
      { tab: 'lighting', key: 'lighting', label: t('common.configuration'), onClick: onOpenLighting, testId: 'lighting-settings-btn', enabled: !!onOpenLighting },
    ]
    const content: Record<string, React.ReactNode> = {}
    const grouped = new Map<string, typeof buttonDefs>()
    for (const def of buttonDefs) { if (!def.enabled) continue; const existing = grouped.get(def.tab); if (existing) existing.push(def); else grouped.set(def.tab, [def]) }
    for (const [tab, defs] of grouped) {
      content[tab] = (
        <div className="flex items-center gap-2">
          <span className="text-xs text-content-secondary/70">{t('common.settingsLabel')}</span>
          {defs.map((d) => (<button key={d.key} type="button" className={btnClass} onClick={d.onClick} data-testid={d.testId}>{d.label}</button>))}
        </div>
      )
    }
    return content
  }, [tapDanceEntries, comboEntries, keyOverrideEntries, altRepeatKeyEntries, deserializedMacros, tapHoldSupported, mouseKeysSupported, magicSupported, autoShiftSupported, graveEscapeSupported, oneShotKeysSupported, comboSettingsSupported, onOpenLighting, t, openSettings, tdJson.open, comboJson.open, koJson.open, arkJson.open, macroJson.openGated])
}
