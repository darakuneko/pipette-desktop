// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import type { SyncProgress } from '../../shared/types/sync'

interface Props {
  progress: SyncProgress | null
  onSkip?: () => void
}

export function SyncOverlay({ progress, onSkip }: Props) {
  const { t } = useTranslation()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface"
      data-testid="sync-overlay"
    >
      <div className="w-full max-w-sm rounded-lg bg-surface-alt p-8 text-center shadow-lg">
        <div className="mb-4 text-lg font-semibold text-content">
          {t('sync.syncing')}
        </div>

        {progress && (
          <div className="mb-4 space-y-2">
            {progress.syncUnit && (
              <div className="text-sm text-content-secondary">
                {progress.syncUnit}
              </div>
            )}
            {progress.total != null && progress.current != null && (
              <div className="text-xs text-content-muted">
                {progress.current} / {progress.total}
              </div>
            )}
            {(progress.status === 'error' || progress.status === 'partial') && progress.message && (
              <div className={`text-sm ${progress.status === 'error' ? 'text-danger' : 'text-warning'}`}>
                {progress.message}
              </div>
            )}
          </div>
        )}

        <div className="h-1 w-full overflow-hidden rounded bg-surface-dim">
          <div className="h-full w-3/5 animate-pulse rounded bg-accent" />
        </div>

        {onSkip && (
          <button
            type="button"
            className="mt-6 rounded border border-edge px-4 py-2 text-sm text-content-secondary hover:bg-surface-dim"
            onClick={onSkip}
            data-testid="sync-overlay-skip"
          >
            {t('sync.continueOffline')}
          </button>
        )}
      </div>
    </div>
  )
}
