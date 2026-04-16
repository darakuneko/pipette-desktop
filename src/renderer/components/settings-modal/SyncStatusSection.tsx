// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { SYNC_STATUS_CLASS } from '../sync-ui'
import { formatDate } from '../editors/store-modal-shared'
import { syncCredentialI18nKey } from '../../../shared/types/sync'
import type { SyncStatusType, LastSyncResult, SyncProgress, SyncCredentialFailureReason } from '../../../shared/types/sync'

export interface SyncStatusSectionProps {
  syncStatus: SyncStatusType
  progress: SyncProgress | null
  lastSyncResult: LastSyncResult | null
  syncReadinessReason?: SyncCredentialFailureReason | null
}

export function SyncStatusSection({ syncStatus, progress, lastSyncResult, syncReadinessReason }: SyncStatusSectionProps) {
  const { t } = useTranslation()

  const noneLabelKey = syncReadinessReason
    ? syncCredentialI18nKey('readiness', syncReadinessReason)
    : 'sync.noSyncYet'

  return (
    <section className="mb-6">
      {syncStatus === 'none' ? (
        <span className="text-sm text-content-muted" data-testid="sync-status-label">
          {t(noneLabelKey)}
        </span>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm ${SYNC_STATUS_CLASS[syncStatus]}`} data-testid="sync-status-label">
              {t(`statusBar.sync.${syncStatus}`)}
            </span>
            {syncStatus === 'syncing' && progress?.current != null && progress?.total != null && (
              <span className="text-xs text-content-muted" data-testid="sync-status-progress">
                {progress.current} / {progress.total}
              </span>
            )}
            {lastSyncResult?.timestamp != null && syncStatus !== 'syncing' && (
              <span className="ml-auto text-xs text-content-muted" data-testid="sync-status-time">
                {formatDate(lastSyncResult.timestamp)}
              </span>
            )}
          </div>
          {syncStatus === 'syncing' && progress?.syncUnit && (
            <div className="text-xs text-content-muted" data-testid="sync-status-unit">
              {progress.syncUnit}
            </div>
          )}
          {syncStatus === 'error' && lastSyncResult?.message && (
            <div
              className="rounded border border-danger/30 bg-danger/10 px-2 py-1 text-xs text-danger"
              data-testid="sync-status-error-message"
            >
              {t(lastSyncResult.message, lastSyncResult.message)}
            </div>
          )}
          {syncStatus === 'partial' && lastSyncResult?.failedUnits && lastSyncResult.failedUnits.length > 0 && (
            <div
              className="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning"
              data-testid="sync-status-partial-details"
            >
              <div>{t(lastSyncResult.message ?? '', lastSyncResult.message ?? '')}</div>
              <ul className="mt-1 list-disc pl-4">
                {lastSyncResult.failedUnits.map((unit) => (
                  <li key={unit}>{unit}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
