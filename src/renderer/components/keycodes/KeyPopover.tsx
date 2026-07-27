// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { serialize, isLMKeycode } from '../../../shared/keycodes/keycodes'
import { PopoverTabKey } from './PopoverTabKey'
import { PopoverTabCode } from './PopoverTabCode'
import { ModifierCheckboxStrip } from './ModifierCheckboxStrip'
import { LayerSelector } from './LayerSelector'
import { usePopoverKeycodeWorkflow, type WrapperMode } from './use-popover-keycode-workflow'

type Tab = 'key' | 'code'

interface KeyPopoverProps {
  anchorRect: DOMRect
  currentKeycode: number
  emptyInitial?: boolean   // When true, start with empty search (no current keycode)
  maskOnly?: boolean
  layers?: number
  currentLayer?: number
  onLayerChange?: (layer: number) => void
  layerNames?: string[]
  onKeycodeSelect: (kc: Keycode) => void
  /** `advance` distinguishes a genuine keycode confirm from a raw call
   *  that merely reconfigures the wrapper itself — see the full contract
   *  and call sites (mode-button switch, LT/LM layer change, modifier-
   *  checkbox-strip change) on `onRawKeycodeSelect` in
   *  `use-popover-keycode-workflow.ts`'s `UsePopoverKeycodeWorkflowOptions`.
   *  This file's own call site (Code tab Apply, below) always passes
   *  `true`. Callers that don't care (MacroEditor, KeycodeEntryModalShell)
   *  can ignore it. */
  onRawKeycodeSelect: (code: number, advance: boolean) => void
  onModMaskChange?: (newMask: number) => void
  onClose: () => void
  onConfirm?: () => void // Enter / click-to-close: confirm and close the picker
  quickSelect?: boolean  // true: click applies + closes; false: buffer until Enter
  /** Gates whether a confirmed keycode selection closes the popover itself
   *  or leaves that decision to the caller (the keymap editor's Auto Move
   *  follow-along) — see the full contract on `closeOnSelect` in
   *  `use-popover-keycode-workflow.ts`'s `UsePopoverKeycodeWorkflowOptions`.
   *  Defaults to true here, matching every other caller's existing
   *  "confirm closes" expectation. */
  closeOnSelect?: boolean
  previousKeycode?: number // Previous keycode for undo (undefined = no undo available)
  onUndo?: () => void      // Revert to previousKeycode and close
  nextKeycode?: number     // Next keycode for redo (undefined = no redo available)
  onRedo?: () => void      // Re-apply nextKeycode and close
  /** Active Key Label pack's per-key legend override — same source
   *  `KeycodeGrid`/`BasicKeyboardView` already receive, threaded here
   *  so the Key tab's search index and result rows agree with what
   *  the keymap grid shows (issue #294). */
  remapLabel?: (qmkId: string) => string
}

const POPOVER_WIDTH = 320
const LAYER_SIDEBAR_WIDTH = 56
const POPOVER_GAP = 6

export function KeyPopover({
  anchorRect,
  currentKeycode,
  emptyInitial,
  maskOnly,
  layers = 16,
  currentLayer,
  onLayerChange,
  layerNames,
  onKeycodeSelect,
  onRawKeycodeSelect,
  onModMaskChange,
  onClose,
  onConfirm,
  quickSelect,
  closeOnSelect = true,
  previousKeycode,
  onUndo,
  nextKeycode,
  onRedo,
  remapLabel,
}: KeyPopoverProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('key')
  // Incremented when leaving LM mode to force PopoverTabKey remount (clears search)
  const [searchResetKey, setSearchResetKey] = useState(0)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  // Bumps `searchResetKey` above (owned here — purely a rendering concern,
  // forces `PopoverTabKey` to remount and clear its search box) whenever
  // the keycode workflow hook's wrapper-mode state changes in a way that
  // should clear the search: leaving LM mode via a mode switch, or a
  // cross-layer reset of the wrapper.
  const resetSearch = useCallback(() => setSearchResetKey((k) => k + 1), [])

  const {
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
  } = usePopoverKeycodeWorkflow({
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
  })

  const showLayerSidebar = currentLayer != null && onLayerChange != null && layers > 1
  const popoverWidth = showLayerSidebar ? POPOVER_WIDTH + LAYER_SIDEBAR_WIDTH : POPOVER_WIDTH

  const handleLayerSidebarClick = useCallback(
    (layer: number) => {
      if (!onLayerChange || layer === currentLayer) return
      onLayerChange(layer)
    },
    [onLayerChange, currentLayer],
  )

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
    let left = anchorRect.left + anchorRect.width / 2 - popoverWidth / 2
    left = Math.max(4, Math.min(left, vw - popoverWidth - 4))

    setPosition({ top, left })
  }, [anchorRect, activeTab, wrapperMode, popoverWidth])

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

  const tabClass = (tab: Tab) => {
    const base = 'px-3 py-1.5 text-xs border-b-2 transition-colors whitespace-nowrap'
    if (activeTab === tab) return `${base} border-b-accent text-accent font-semibold`
    return `${base} border-b-transparent text-content-secondary hover:text-content`
  }

  const modeButtonClass = (mode: WrapperMode) => {
    const base = 'rounded px-2 py-0.5 text-xs font-medium transition-colors'
    if (wrapperMode === mode) return `${base} bg-accent text-content-inverse`
    return `${base} bg-surface-dim text-content-secondary hover:bg-edge`
  }

  return (
    <div
      ref={popoverRef}
      data-popover="key"
      className="fixed z-50 flex flex-col rounded-lg border border-edge bg-surface-alt shadow-xl"
      style={{
        top: position.top,
        left: position.left,
        width: popoverWidth,
        height: showLayerSidebar ? 500 : undefined,
        paddingLeft: showLayerSidebar ? LAYER_SIDEBAR_WIDTH : undefined,
      }}
      data-testid="key-popover"
    >
      {showLayerSidebar && (
        <div
          className="absolute bottom-0 left-0 top-0 flex flex-col gap-1 overflow-y-auto border-r border-edge-subtle p-2"
          style={{ width: LAYER_SIDEBAR_WIDTH, scrollbarWidth: 'thin', scrollbarGutter: 'stable' }}
          data-testid="popover-layer-sidebar"
        >
          {Array.from({ length: layers }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => handleLayerSidebarClick(i)}
              className={`w-8 shrink-0 rounded-md border flex items-center justify-center py-1.5 text-xs font-semibold tabular-nums transition-colors ${
                currentLayer === i
                  ? 'border-accent bg-accent text-content-inverse'
                  : 'border-edge bg-surface/20 text-content-muted hover:bg-surface-dim'
              }`}
              title={layerNames?.[i] || undefined}
              data-testid={`popover-layer-${i}`}
            >
              {i}
            </button>
          ))}
        </div>
      )}
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

      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
        {activeTab === 'key' && wrapperMode !== 'lm' && (
          <PopoverTabKey
            key={searchResetKey}
            // LM keycodes store modifier bits where the basic key normally lives (see `use-popover-keycode-workflow.ts`'s `handleModStripChange`).
            // After a mode switch away from LM, currentKeycode may still hold the stale LM value
            // for one render frame before the parent propagates the rebuilt keycode.
            currentKeycode={isLMKeycode(currentKeycode) ? 0 : currentKeycode}
            emptyInitial={emptyInitial}
            maskOnly={maskOnly}
            modMask={currentModMask}
            basicKeyOnly={wrapperMode === 'lt' || wrapperMode === 'shT'}
            onKeycodeSelect={handleKeycodeSelect}
            onClose={confirmAndClose}
            remapLabel={remapLabel}
          />
        )}
        {activeTab === 'code' && (
          <PopoverTabCode
            currentKeycode={currentKeycode}
            maskOnly={maskOnly}
            // Code tab Apply is a genuine confirm, same as a Key tab pick.
            onRawKeycodeSelect={(code) => onRawKeycodeSelect(code, true)}
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
