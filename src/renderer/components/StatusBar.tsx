// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SYNC_STATUS_CLASS } from './sync-ui'
import { QuickSettingsSelects, type QuickSettingsSelectsProps } from './QuickSettingsSelects'
import { TypingRecordModal } from './TypingRecordModal'
import type { SyncStatusType } from '../../shared/types/sync'

const TYPING_TEST_BASE = 'flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded border px-2.5 py-1 text-xs leading-none transition-colors'
const TYPING_TEST_ACTIVE = `${TYPING_TEST_BASE} border-accent bg-accent/10 text-accent`
const TYPING_TEST_INACTIVE = `${TYPING_TEST_BASE} border-edge text-content-secondary hover:text-content`

interface Props {
  deviceName: string
  loadedLabel?: string
  autoAdvance: boolean
  unlocked: boolean
  syncStatus: SyncStatusType
  hubConnected?: boolean
  matrixMode: boolean
  typingTestMode?: boolean
  hasMatrixTester?: boolean
  comboActive?: boolean
  altRepeatKeyActive?: boolean
  keyOverrideActive?: boolean
  viewOnly?: boolean
  onViewOnlyChange?: () => void
  onTypingTestModeChange?: () => void
  /** Opens the Analyze view straight from the editor footer (independent of
   *  Typing View / Typing Test). Hidden while Typing Test is active — the
   *  in-run "View Analytics" button below covers that case instead. */
  onOpenAnalyze?: () => void
  /** Disables the Analyze button while a Key Label "apply to keymap" rewrite
   *  is mid-flight — opening AnalyzePage would unmount KeymapEditor out from
   *  under the in-flight sequential device writes. */
  analyzeDisabled?: boolean
  /** Opens the Analyze view from the typing test. Shown only in typing-test
   *  mode, beside "Exit Typing Test"; disabled mid-run so the user can't
   *  navigate away from an in-progress test. */
  onViewAnalytics?: () => void
  viewAnalyticsDisabled?: boolean
  onDisconnect?: () => void
  /** REC toggle state, shown as the footer "Record" button/modal and the
   *  left-side "Recording" indicator (Task-typing-record-footer). */
  typingRecordEnabled?: boolean
  onTypingRecordEnabledChange?: (enabled: boolean) => void
  quickSettings?: QuickSettingsSelectsProps
}

export function StatusBar({
  deviceName,
  loadedLabel,
  autoAdvance,
  unlocked,
  syncStatus,
  hubConnected,
  matrixMode,
  typingTestMode,
  hasMatrixTester,
  comboActive,
  altRepeatKeyActive,
  keyOverrideActive,
  viewOnly,
  onViewOnlyChange,
  onTypingTestModeChange,
  onOpenAnalyze,
  analyzeDisabled,
  onViewAnalytics,
  viewAnalyticsDisabled,
  onDisconnect,
  typingRecordEnabled,
  onTypingRecordEnabledChange,
  quickSettings,
}: Props) {
  const { t } = useTranslation()
  const [recordModalOpen, setRecordModalOpen] = useState(false)

  const showAnalyzeButton = !!onOpenAnalyze && !typingTestMode
  const showViewAnalyticsButton = !!typingTestMode && !!onViewAnalytics
  const showViewOnlyButton = !!onViewOnlyChange && !!hasMatrixTester && !typingTestMode
  const showTypingTestButton = !!onTypingTestModeChange && !!hasMatrixTester
  const showRecordButton = !!onTypingRecordEnabledChange && !!hasMatrixTester
  const hasTypingGroup = showViewOnlyButton || showTypingTestButton || showRecordButton
  // Exactly one of the two Analyze entry points renders per mode (editor
  // vs typing test); both sit BEFORE the Typing group separator so the
  // footer keeps the same `| Analyze | Typing: …` order in both modes.
  const hasAnalyzeSlot = showAnalyzeButton || showViewAnalyticsButton
  const hasLeadingButtons = hasAnalyzeSlot || hasTypingGroup

  return (
    <>
    <div className="flex flex-nowrap items-center justify-between gap-3 border-t border-edge bg-surface-alt px-4 py-1.5 text-xs leading-none text-content-secondary" data-testid="status-bar">
      <div className="flex min-w-0 flex-nowrap items-center gap-3">
        <span className="min-w-10 flex-1 truncate" data-testid="status-device-name">{deviceName}</span>
        {loadedLabel && (
          <>
            <span className="shrink-0 text-edge">|</span>
            <span className="shrink-0 whitespace-nowrap" data-testid="loaded-label">{loadedLabel}</span>
          </>
        )}
        <span className="shrink-0 text-edge">|</span>
        {autoAdvance && (
          <>
            <span className="shrink-0 whitespace-nowrap" data-testid="auto-advance-status">{t('statusBar.autoAdvance')}</span>
            <span className="shrink-0 text-edge">|</span>
          </>
        )}
        {comboActive && (
          <>
            <span className="shrink-0 whitespace-nowrap" data-testid="combo-status">{t('editor.combo.title')}</span>
            <span className="shrink-0 text-edge">|</span>
          </>
        )}
        {altRepeatKeyActive && (
          <>
            <span className="shrink-0 whitespace-nowrap" data-testid="alt-repeat-key-status">{t('editor.altRepeatKey.title')}</span>
            <span className="shrink-0 text-edge">|</span>
          </>
        )}
        {keyOverrideActive && (
          <>
            <span className="shrink-0 whitespace-nowrap" data-testid="key-override-status">{t('editor.keyOverride.title')}</span>
            <span className="shrink-0 text-edge">|</span>
          </>
        )}
        {matrixMode && !typingTestMode && (
          <>
            <span className="shrink-0 whitespace-nowrap" data-testid="matrix-status">{t('editor.keyTester.title')}</span>
            <span className="shrink-0 text-edge">|</span>
          </>
        )}
        {typingTestMode && (
          <>
            <span className="shrink-0 whitespace-nowrap" data-testid="typing-test-status">{t('editor.typingTest.title')}</span>
            <span className="shrink-0 text-edge">|</span>
          </>
        )}
        <span className={`shrink-0 whitespace-nowrap ${unlocked ? 'text-warning' : 'text-accent'}`} data-testid="lock-status">{unlocked ? t('statusBar.unlocked') : t('statusBar.locked')}</span>
        {syncStatus !== 'none' && (
          <>
            <span className="shrink-0 text-edge">|</span>
            <span className={`shrink-0 whitespace-nowrap ${SYNC_STATUS_CLASS[syncStatus]}`} data-testid="sync-status">
              {t(`statusBar.sync.${syncStatus}`)}
            </span>
          </>
        )}
        {hubConnected !== undefined && (
          <>
            <span className="shrink-0 text-edge">|</span>
            <span className={`shrink-0 whitespace-nowrap ${hubConnected ? 'text-accent' : 'text-content-muted'}`} data-testid="hub-status">
              {hubConnected ? t('hub.hubConnected') : t('hub.hubDisconnected')}
            </span>
          </>
        )}
        {typingRecordEnabled && (
          <>
            <span className="shrink-0 text-edge">|</span>
            <span className="shrink-0 whitespace-nowrap text-accent" data-testid="recording-status">
              {t('editor.typingTest.recordingIndicator')}
            </span>
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-nowrap items-center gap-3">
        {quickSettings && <QuickSettingsSelects {...quickSettings} />}
        {quickSettings && hasLeadingButtons && (
          <span className="shrink-0 text-edge">|</span>
        )}
        {showAnalyzeButton && (
          <button
            type="button"
            data-testid="status-analyze-button"
            className={`${TYPING_TEST_INACTIVE} disabled:cursor-not-allowed disabled:opacity-40`}
            disabled={analyzeDisabled}
            onClick={onOpenAnalyze}
          >
            {t('app.analyzeTab')}
          </button>
        )}
        {showViewAnalyticsButton && (
          <button
            type="button"
            data-testid="status-view-analytics"
            className={`${TYPING_TEST_INACTIVE} disabled:cursor-not-allowed disabled:opacity-40`}
            disabled={viewAnalyticsDisabled}
            onClick={onViewAnalytics}
          >
            {t('app.analyzeTab')}
          </button>
        )}
        {hasAnalyzeSlot && hasTypingGroup && (
          <span className="shrink-0 text-edge">|</span>
        )}
        {hasTypingGroup && (
          <span className="shrink-0 whitespace-nowrap text-content-muted">{t('statusBar.typingGroup')}</span>
        )}
        {showViewOnlyButton && (
          <button
            type="button"
            data-testid="view-only-button"
            aria-label={t('editor.typingTest.viewOnly')}
            className={viewOnly ? TYPING_TEST_ACTIVE : TYPING_TEST_INACTIVE}
            onClick={onViewOnlyChange}
          >
            {t('statusBar.typingViewShort')}
          </button>
        )}
        {showTypingTestButton && (
          <button
            type="button"
            data-testid="typing-test-button"
            data-active={typingTestMode || undefined}
            aria-label={typingTestMode ? t('editor.typingTest.exitTypingMode') : t('editor.typingTest.switchToTypingMode')}
            className={typingTestMode ? TYPING_TEST_ACTIVE : TYPING_TEST_INACTIVE}
            onClick={onTypingTestModeChange}
          >
            {typingTestMode ? t('statusBar.typingTestExitShort') : t('statusBar.typingTestShort')}
          </button>
        )}
        {showRecordButton && (
          <button
            type="button"
            data-testid="typing-record-button"
            aria-haspopup="dialog"
            className={typingRecordEnabled ? TYPING_TEST_ACTIVE : TYPING_TEST_INACTIVE}
            onClick={() => setRecordModalOpen(true)}
          >
            {t('statusBar.typingRecordShort')}
          </button>
        )}
        {onDisconnect && hasLeadingButtons && (
          <span className="shrink-0 text-edge">|</span>
        )}
        {onDisconnect && (
          <button
            type="button"
            data-testid="disconnect-button"
            className="flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded border border-edge px-2.5 py-1 text-xs leading-none text-danger transition-colors hover:text-danger/80"
            onClick={onDisconnect}
          >
            {t('common.disconnect')}
          </button>
        )}
      </div>
    </div>
    {recordModalOpen && onTypingRecordEnabledChange && (
      <TypingRecordModal
        onClose={() => setRecordModalOpen(false)}
        typingRecordEnabled={typingRecordEnabled ?? false}
        onTypingRecordEnabledChange={onTypingRecordEnabledChange}
      />
    )}
    </>
  )
}
