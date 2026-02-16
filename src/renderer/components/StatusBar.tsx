// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import type { SyncStatusType } from '../../shared/types/sync'

interface Props {
  deviceName: string
  autoAdvance: boolean
  unlocked: boolean
  syncStatus: SyncStatusType
  matrixMode: boolean
  typingTestMode?: boolean
  onDisconnect: () => void
  onCancelPending?: () => void
}

const SYNC_STATUS_CLASS: Record<Exclude<SyncStatusType, 'none'>, string> = {
  pending: 'text-pending',
  syncing: 'text-warning animate-pulse',
  synced: 'text-accent',
  error: 'text-danger',
}

export function StatusBar({
  deviceName,
  autoAdvance,
  unlocked,
  syncStatus,
  matrixMode,
  typingTestMode,
  onDisconnect,
  onCancelPending,
}: Props) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center justify-between border-t border-edge bg-surface-alt px-4 py-1.5 text-xs text-content-secondary" data-testid="status-bar">
      <div className="flex items-center gap-3">
        <span>{deviceName}</span>
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
            {syncStatus === 'pending' && onCancelPending && (
              <button
                type="button"
                className="text-content-muted hover:text-content-secondary"
                onClick={onCancelPending}
                data-testid="sync-cancel-pending"
              >
                {t('sync.cancelPending')}
              </button>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="rounded border border-edge px-1.5 py-0.5 text-xs text-danger transition-colors"
          onClick={onDisconnect}
        >
          {t('common.disconnect')}
        </button>
      </div>
    </div>
  )
}
