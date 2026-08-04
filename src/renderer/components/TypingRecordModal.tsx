// SPDX-License-Identifier: GPL-2.0-or-later
// Footer "Record" modal — moved out of the Typing View popover's REC tab
// into the keymap-editor status bar (Task-typing-record-footer). Content
// is the former REC tab verbatim minus its own Analyze button (the footer
// already has one): the Start/Stop toggle (with the same first-time
// consent flow), Monitor App, the tray toggles, and the HeatMap window
// select. Chrome copied from TypingRecordingConsentModal / store-modal-
// shared; StatusBar owns the open/close boolean and only mounts this as
// a sibling while open, same idiom as TypingTestPane's old consent modal.

import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { ModalCloseButton } from './editors/ModalCloseButton'
import { TypingRecordingConsentModal } from '../typing-test/TypingRecordingConsentModal'
import { useAppConfig } from '../hooks/useAppConfig'
import { BTN_TOGGLE_ACTIVE, BTN_TOGGLE_INACTIVE } from '../constants/ui-tokens'
import { TYPING_HEATMAP_WINDOW_OPTIONS } from '../../shared/types/app-config'

const TOGGLE_ROW = 'w-full whitespace-nowrap'
const TOGGLE_ROW_DISABLED = 'w-full whitespace-nowrap rounded border border-edge px-2 py-1 text-content-muted opacity-60 cursor-not-allowed'

/** Shared className for one toggle row — active/inactive when enabled,
 *  a fixed muted/disabled look when `disabled` (Monitor App while REC is
 *  off, Start Hidden in Tray while Stay in System Tray is off). */
function toggleRowClass(active: boolean, disabled: boolean): string {
  if (disabled) return TOGGLE_ROW_DISABLED
  return `${TOGGLE_ROW} ${active ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`
}

interface Props {
  onClose: () => void
  typingRecordEnabled: boolean
  onTypingRecordEnabledChange: (enabled: boolean) => void
}

export function TypingRecordModal({ onClose, typingRecordEnabled, onTypingRecordEnabledChange }: Props) {
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const { set: setAppConfig } = appConfig
  const [showConsentModal, setShowConsentModal] = useState(false)
  const backdropRef = useRef<HTMLDivElement>(null)

  useEscapeClose(onClose)

  const trayResident = appConfig.config.trayResident ?? false
  const startInTray = appConfig.config.startInTray ?? false
  const monitorAppEnabled = appConfig.config.typingMonitorAppEnabled ?? true
  const heatmapWindowMin = appConfig.config.typingHeatmapWindowMin ?? 5

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose()
  }, [onClose])

  const handleRecordToggle = useCallback(() => {
    // Stopping is always allowed without re-prompting; only the first
    // transition from "off → on" needs the disclosure.
    if (typingRecordEnabled) {
      onTypingRecordEnabledChange(false)
      return
    }
    if (!appConfig.config.typingRecordingConsentAccepted) {
      setShowConsentModal(true)
      return
    }
    onTypingRecordEnabledChange(true)
  }, [typingRecordEnabled, onTypingRecordEnabledChange, appConfig.config.typingRecordingConsentAccepted])

  const handleConsentAccept = useCallback(() => {
    setAppConfig('typingRecordingConsentAccepted', true)
    setShowConsentModal(false)
    onTypingRecordEnabledChange(true)
  }, [setAppConfig, onTypingRecordEnabledChange])

  const handleConsentCancel = useCallback(() => {
    setShowConsentModal(false)
  }, [])

  const handleTrayResidentToggle = useCallback(() => {
    const next = !trayResident
    setAppConfig('trayResident', next)
    // Mirrors SettingsToolsTab: a hidden window with no tray icon to
    // reopen it would be unreachable, so turning tray residency off
    // also clears startInTray when it was on.
    if (!next && startInTray) {
      setAppConfig('startInTray', false)
    }
  }, [setAppConfig, trayResident, startInTray])

  return (
    <>
      <div
        ref={backdropRef}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        role="dialog"
        aria-labelledby="typing-record-title"
        data-testid="typing-record-modal"
        onClick={handleBackdropClick}
      >
        <div className="flex w-modal-typing max-w-modal-vw flex-col rounded-2xl border border-edge bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-edge px-4 py-3">
            <h2 id="typing-record-title" className="text-lg font-semibold text-content">
              {t('editor.typingTest.recordModalTitle')}
            </h2>
            <ModalCloseButton testid="typing-record-close" onClick={onClose} />
          </div>

          <div className="flex flex-col gap-2 px-5 py-4 text-sm text-content">
            <button
              type="button"
              role="switch"
              aria-checked={typingRecordEnabled}
              data-testid="typing-record-toggle"
              className={toggleRowClass(typingRecordEnabled, false)}
              onClick={handleRecordToggle}
            >
              {typingRecordEnabled ? t('editor.typingTest.recordStop') : t('editor.typingTest.recordStart')}
            </button>

            {/* Monitor App lives directly under the Start/Stop button so the
                recording-related toggles read top to bottom. Greyed out
                while REC is off so app-name capture has exactly one entry
                point. */}
            <button
              type="button"
              role="switch"
              aria-checked={monitorAppEnabled}
              aria-disabled={!typingRecordEnabled}
              data-testid="monitor-app-toggle"
              className={toggleRowClass(monitorAppEnabled, !typingRecordEnabled)}
              onClick={() => {
                if (!typingRecordEnabled) return
                setAppConfig('typingMonitorAppEnabled', !monitorAppEnabled)
              }}
            >
              {t('editor.typingTest.monitorApp.label')}
            </button>

            {/* Tray toggles — same AppConfig fields and linked-clear semantics
                as Settings > Tools, surfaced here too since the Typing View
                window is often the last one open before reaching for the tray. */}
            <button
              type="button"
              role="switch"
              aria-checked={trayResident}
              data-testid="typing-tray-resident-toggle"
              className={toggleRowClass(trayResident, false)}
              onClick={handleTrayResidentToggle}
            >
              {t('settings.trayResident')}
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={startInTray}
              aria-disabled={!trayResident}
              data-testid="typing-start-in-tray-toggle"
              className={toggleRowClass(startInTray, !trayResident)}
              onClick={() => {
                if (!trayResident) return
                setAppConfig('startInTray', !startInTray)
              }}
            >
              {t('settings.startInTray')}
            </button>

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-content-muted">{t('editor.typingTest.heatmapWindow')}</span>
              <select
                data-testid="heatmap-window-select"
                aria-label={t('editor.typingTest.heatmapWindow')}
                value={heatmapWindowMin}
                onChange={(e) => setAppConfig('typingHeatmapWindowMin', Number(e.target.value) as typeof appConfig.config.typingHeatmapWindowMin)}
                className="rounded border border-edge bg-surface-alt px-1.5 py-0.5 text-xs text-content-secondary focus:border-accent focus:outline-none"
              >
                {TYPING_HEATMAP_WINDOW_OPTIONS.map((m) => (
                  <option key={m} value={m}>{t('editor.typingTest.heatmapWindowOption', { minutes: m })}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
      {showConsentModal && (
        <TypingRecordingConsentModal
          onAccept={handleConsentAccept}
          onCancel={handleConsentCancel}
        />
      )}
    </>
  )
}
