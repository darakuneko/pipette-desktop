// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { SYNC_STATUS_CLASS } from './sync-ui'
import type { SyncStatusType } from '../../shared/types/sync'

const TYPING_TEST_BASE = 'flex items-center gap-1 rounded border px-1.5 text-xs transition-colors'
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
  onTypingTestModeChange?: () => void
  onDisconnect?: () => void
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
  onTypingTestModeChange,
  onDisconnect,
}: Props) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center justify-between border-t border-edge bg-surface-alt px-4 py-1.5 text-xs text-content-secondary" data-testid="status-bar">
      <div className="flex items-center gap-3">
        <span>{deviceName}</span>
        {loadedLabel && (
          <>
            <span className="text-edge">|</span>
            <span className="text-content-muted" data-testid="loaded-label">{loadedLabel}</span>
          </>
        )}
        <span className="text-edge">|</span>
        {autoAdvance && (
          <>
            <span data-testid="auto-advance-status">{t('statusBar.autoAdvance')}</span>
            <span className="text-edge">|</span>
          </>
        )}
        {matrixMode && !typingTestMode && (
          <>
            <span data-testid="matrix-status">{t('statusBar.keyTester')}</span>
            <span className="text-edge">|</span>
          </>
        )}
        {typingTestMode && (
          <>
            <span data-testid="typing-test-status">{t('editor.typingTest.title')}</span>
            <span className="text-edge">|</span>
          </>
        )}
        <span className={unlocked ? 'text-warning' : 'text-accent'} data-testid="lock-status">{unlocked ? t('statusBar.unlocked') : t('statusBar.locked')}</span>
        {syncStatus !== 'none' && (
          <>
            <span className="text-edge">|</span>
            <span className={SYNC_STATUS_CLASS[syncStatus]} data-testid="sync-status">
              {t(`statusBar.sync.${syncStatus}`)}
            </span>
          </>
        )}
        {hubConnected !== undefined && (
          <>
            <span className="text-edge">|</span>
            <span className={hubConnected ? 'text-accent' : 'text-content-muted'} data-testid="hub-status">
              {hubConnected ? t('hub.hubConnected') : t('hub.hubDisconnected')}
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        {onTypingTestModeChange && hasMatrixTester && (
          <button
            type="button"
            data-testid="typing-test-button"
            aria-label={typingTestMode ? t('editor.typingTest.exitTypingMode') : t('editor.typingTest.switchToTypingMode')}
            className={typingTestMode ? TYPING_TEST_ACTIVE : TYPING_TEST_INACTIVE}
            onClick={onTypingTestModeChange}
          >
            {typingTestMode ? t('editor.typingTest.exitTypingMode') : t('editor.typingTest.switchToTypingMode')}
          </button>
        )}
        {onDisconnect && (
          <button
            type="button"
            data-testid="disconnect-button"
            className="flex items-center gap-1 rounded border border-edge px-1.5 text-xs text-red-500 transition-colors hover:text-red-600"
            onClick={onDisconnect}
          >
            {t('common.disconnect')}
          </button>
        )}
      </div>
    </div>
  )
}
