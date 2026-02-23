// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { PanelSide } from '../../hooks/useDevicePrefs'
import type { SyncStatusType } from '../../../shared/types/sync'
import { LayoutStoreContent, type LayoutStoreContentProps } from './LayoutStoreModal'
import { ModalCloseButton } from './ModalCloseButton'

const CANCEL_BTN = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim'
const DANGER_BTN = 'rounded bg-danger px-3 py-1 text-sm font-medium text-white hover:bg-danger/90'

export interface ResetKeyboardDataSectionProps {
  confirming: boolean
  busy: boolean
  disabled?: boolean
  disabledTitle?: string
  deviceName: string
  onStartConfirm: () => void
  onCancel: () => void
  onConfirm: () => void
}

export function ResetKeyboardDataSection({
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
    <div className="shrink-0 border-t border-edge pt-3 mt-3" data-testid="reset-keyboard-data-section">
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
        <div className="flex items-center justify-between">
          <span className="text-xs text-content-muted">{t('sync.resetKeyboardData')}</span>
          <button
            type="button"
            className="rounded border border-danger/50 px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-50"
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
  panelSide?: PanelSide
  syncStatus?: SyncStatusType
  onResetKeyboardData?: () => Promise<void>
  deviceName?: string
}

export function EditorSettingsModal({
  onClose,
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
        <div className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
          <h2 id="editor-settings-title" className="text-lg font-bold text-content">{t('editorSettings.tabData')}</h2>
          <ModalCloseButton testid="editor-settings-close" onClick={onClose} />
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5">
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
        </div>
      </div>
    </div>
  )
}
