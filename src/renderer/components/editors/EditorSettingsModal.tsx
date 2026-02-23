// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { KEYBOARD_LAYOUTS } from '../../data/keyboard-layouts'
import type { KeyboardLayoutId } from '../../hooks/useKeyboardLayout'
import type { PanelSide } from '../../hooks/useDevicePrefs'
import type { SyncStatusType } from '../../../shared/types/sync'
import { LayoutStoreContent, type LayoutStoreContentProps } from './LayoutStoreModal'
import { ModalCloseButton } from './ModalCloseButton'
import { ROW_CLASS, toggleTrackClass, toggleKnobClass } from './modal-controls'
import { ModalTabBar, ModalTabPanel } from './modal-tabs'
import type { ModalTabId } from './modal-tabs'

const ZOOM_BTN = 'rounded border border-edge px-2 py-1 text-xs text-content-secondary hover:text-content hover:bg-surface-dim disabled:opacity-30 disabled:pointer-events-none'

const ALL_TABS = [
  { id: 'tools' as const, labelKey: 'editorSettings.tabTools' },
  { id: 'data' as const, labelKey: 'editorSettings.tabData' },
]

const CANCEL_BTN = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim'
const DANGER_BTN = 'rounded bg-danger px-3 py-1 text-sm font-medium text-white hover:bg-danger/90'
const DANGER_OUTLINE_BTN = 'rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50'

interface ResetKeyboardDataSectionProps {
  confirming: boolean
  busy: boolean
  disabled?: boolean
  disabledTitle?: string
  deviceName: string
  onStartConfirm: () => void
  onCancel: () => void
  onConfirm: () => void
}

function ResetKeyboardDataSection({
  confirming,
  busy,
  disabled,
  disabledTitle,
  deviceName,
  onStartConfirm,
  onCancel,
  onConfirm,
}: ResetKeyboardDataSectionProps) {
  const { t } = useTranslation()

  return (
    <div className="shrink-0 border-t border-edge pt-4 mt-4" data-testid="reset-keyboard-data-section">
      <h4 className="mb-2 text-sm font-medium text-content-secondary">
        {t('sync.resetKeyboardData')}
      </h4>
      {confirming ? (
        <div className="space-y-2">
          <div
            className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger whitespace-pre-line"
            data-testid="reset-keyboard-data-warning"
          >
            {t('sync.resetKeyboardDataConfirm', { name: deviceName })}
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className={CANCEL_BTN}
              onClick={onCancel}
              disabled={busy}
              data-testid="reset-keyboard-data-cancel"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={DANGER_BTN}
              onClick={onConfirm}
              disabled={busy || disabled}
              data-testid="reset-keyboard-data-confirm"
            >
              {t('common.reset')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end">
          <button
            type="button"
            className={DANGER_OUTLINE_BTN}
            onClick={onStartConfirm}
            disabled={disabled}
            title={disabled ? disabledTitle : undefined}
            data-testid="reset-keyboard-data-btn"
          >
            {t('common.reset')}
          </button>
        </div>
      )}
    </div>
  )
}

const PANEL_BASE = 'absolute top-0 h-full w-[440px] max-w-[90vw] flex flex-col border-edge bg-surface-alt shadow-xl transition-transform duration-300 ease-out'

function panelPositionClass(side: PanelSide, open: boolean): string {
  if (side === 'left') return `${PANEL_BASE} left-0 border-r ${open ? 'translate-x-0' : '-translate-x-full'}`
  return `${PANEL_BASE} right-0 border-l ${open ? 'translate-x-0' : 'translate-x-full'}`
}

interface Props extends Omit<LayoutStoreContentProps, 'keyboardName'> {
  onClose: () => void
  activeTab: ModalTabId
  onTabChange: (tab: ModalTabId) => void
  keyboardLayout: KeyboardLayoutId
  onKeyboardLayoutChange: (layout: KeyboardLayoutId) => void
  autoAdvance: boolean
  onAutoAdvanceChange: (enabled: boolean) => void
  unlocked: boolean
  onLock: () => void
  matrixMode?: boolean
  hasMatrixTester?: boolean
  onToggleMatrix?: () => void
  scale?: number
  onScaleChange?: (delta: number) => void
  panelSide?: PanelSide
  syncStatus?: SyncStatusType
  onResetKeyboardData?: () => Promise<void>
  deviceName?: string
}

export function EditorSettingsModal({
  onClose,
  activeTab,
  onTabChange,
  keyboardLayout,
  onKeyboardLayoutChange,
  autoAdvance,
  onAutoAdvanceChange,
  unlocked,
  onLock,
  matrixMode = false,
  hasMatrixTester = false,
  onToggleMatrix,
  scale = 1,
  onScaleChange,
  panelSide = 'left',
  syncStatus,
  onResetKeyboardData,
  deviceName = '',
  isDummy,
  ...dataProps
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const [confirmingResetKeyboard, setConfirmingResetKeyboard] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)

  const handleConfirmReset = useCallback(async () => {
    if (!onResetKeyboardData) return
    setResetBusy(true)
    try {
      await onResetKeyboardData()
    } finally {
      setResetBusy(false)
      setConfirmingResetKeyboard(false)
    }
  }, [onResetKeyboardData])

  useEffect(() => {
    // Trigger slide-in on next frame so the transition plays
    const id = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <div
      className={`fixed inset-0 z-50 transition-colors duration-300 ${open ? 'bg-black/30' : 'bg-transparent'}`}
      data-testid="editor-settings-backdrop"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-settings-title"
        className={panelPositionClass(panelSide, open)}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-0 shrink-0">
          <h2 id="editor-settings-title" className="text-lg font-bold text-content">{t('editorSettings.title')}</h2>
          <ModalCloseButton testid="editor-settings-close" onClick={onClose} />
        </div>

        <ModalTabBar
          tabs={ALL_TABS}
          activeTab={activeTab}
          onTabChange={onTabChange}
          idPrefix="editor-settings"
          testIdPrefix="editor-settings"
        />

        <ModalTabPanel activeTab={activeTab} idPrefix="editor-settings">
          {activeTab === 'data' && (
            <LayoutStoreContent
              {...dataProps}
              isDummy={isDummy}
              keyboardName={deviceName}
              listClassName="overflow-y-auto"
              footer={onResetKeyboardData && (
                <ResetKeyboardDataSection
                  confirming={confirmingResetKeyboard}
                  busy={resetBusy}
                  disabled={syncStatus === 'syncing'}
                  disabledTitle={t('sync.resetDisabledWhileSyncing')}
                  deviceName={deviceName}
                  onStartConfirm={() => setConfirmingResetKeyboard(true)}
                  onCancel={() => setConfirmingResetKeyboard(false)}
                  onConfirm={handleConfirmReset}
                />
              )}
            />
          )}

          {activeTab === 'tools' && (
            <div className="flex flex-col gap-3 pt-4">
              {/* Keyboard layout selector */}
              <div className={ROW_CLASS} data-testid="editor-settings-layout-row">
                <label htmlFor="editor-settings-layout-selector" className="text-[13px] font-medium text-content">
                  {t('layout.keyboardLayout')}
                </label>
                <select
                  id="editor-settings-layout-selector"
                  value={keyboardLayout}
                  onChange={(e) => onKeyboardLayoutChange(e.target.value as KeyboardLayoutId)}
                  className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
                  data-testid="editor-settings-layout-selector"
                >
                  {KEYBOARD_LAYOUTS.map((layoutDef) => (
                    <option key={layoutDef.id} value={layoutDef.id}>
                      {layoutDef.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Zoom controls */}
              <div className={ROW_CLASS} data-testid="editor-settings-zoom-row">
                <span className="text-[13px] font-medium text-content">
                  {t('editor.keymap.zoomLabel')}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="editor-settings-zoom-out"
                    aria-label={t('editor.keymap.zoomOut')}
                    className={ZOOM_BTN}
                    disabled={scale <= 0.3}
                    onClick={() => onScaleChange?.(-0.1)}
                  >
                    &minus;
                  </button>
                  <span className="min-w-[3ch] text-center text-[13px] tabular-nums text-content-secondary" data-testid="editor-settings-zoom-value">
                    {Math.round(scale * 100)}%
                  </span>
                  <button
                    type="button"
                    data-testid="editor-settings-zoom-in"
                    aria-label={t('editor.keymap.zoomIn')}
                    className={ZOOM_BTN}
                    disabled={scale >= 2.0}
                    onClick={() => onScaleChange?.(0.1)}
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Auto-advance toggle */}
              <div className={ROW_CLASS} data-testid="editor-settings-auto-advance-row">
                <span className="text-[13px] font-medium text-content">
                  {t('editor.autoAdvance')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoAdvance}
                  aria-label={t('editor.autoAdvance')}
                  className={toggleTrackClass(autoAdvance)}
                  onClick={() => onAutoAdvanceChange(!autoAdvance)}
                  data-testid="editor-settings-auto-advance-toggle"
                >
                  <span className={toggleKnobClass(autoAdvance)} />
                </button>
              </div>

              {/* Key tester toggle */}
              {(hasMatrixTester || matrixMode) && onToggleMatrix && (
                <div className={ROW_CLASS} data-testid="editor-settings-matrix-row">
                  <span className="text-[13px] font-medium text-content">
                    {t('editor.matrixTester.title')}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={matrixMode}
                    aria-label={t('editor.matrixTester.title')}
                    className={toggleTrackClass(matrixMode)}
                    onClick={onToggleMatrix}
                    data-testid="editor-settings-matrix-toggle"
                  >
                    <span className={toggleKnobClass(matrixMode)} />
                  </button>
                </div>
              )}

              {/* Lock button + status */}
              {!isDummy && (
                <div className={ROW_CLASS} data-testid="editor-settings-lock-row">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-content">
                      {t('settings.security')}
                    </span>
                    <span
                      className={`text-xs ${unlocked ? 'text-warning' : 'text-accent'}`}
                      data-testid="editor-settings-lock-status"
                    >
                      {unlocked ? t('statusBar.unlocked') : t('statusBar.locked')}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={!unlocked}
                    className={`rounded border border-edge px-3 py-1 text-sm ${unlocked ? 'text-content-secondary hover:bg-surface-dim' : 'text-content-muted opacity-50'}`}
                    onClick={onLock}
                    data-testid="editor-settings-lock-button"
                  >
                    {t('security.lock')}
                  </button>
                </div>
              )}

            </div>
          )}
        </ModalTabPanel>
      </div>
    </div>
  )
}
