// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { Settings, Database, ChevronRight } from 'lucide-react'
import { SYNC_STATUS_CLASS } from './sync-ui'
import type { DeviceInfo } from '../../shared/types/protocol'
import type { SyncStatusType } from '../../shared/types/sync'

const DEVICE_ENTRY_CLASS =
  'flex w-full items-center gap-3.5 rounded-lg border border-edge p-3.5 text-left transition-colors hover:border-accent hover:bg-accent/10 disabled:opacity-50'

const HEADER_BTN =
  'flex items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1.5 text-[13px] font-medium text-content-muted transition-colors hover:border-edge hover:bg-surface-dim hover:text-content-secondary disabled:opacity-50'

interface Props {
  devices: DeviceInfo[]
  connecting: boolean
  error: string | null
  onConnect: (device: DeviceInfo) => void
  onLoadDummy: () => void
  onOpenSettings?: () => void
  onOpenData?: () => void
  syncStatus?: SyncStatusType
}

export function DeviceSelector({
  devices,
  connecting,
  error,
  onConnect,
  onLoadDummy,
  onOpenSettings,
  onOpenData,
  syncStatus,
}: Props) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface">
      <div className="w-full max-w-sm rounded-2xl bg-surface-alt px-8 pb-7 pt-9 shadow-lg">
        <div className="mb-7 flex items-center justify-between">
          <h1 className="text-xl font-bold text-content">
            {t('app.title')}
          </h1>
          <div className="flex items-center gap-1">
            {onOpenData && (
              <button
                type="button"
                onClick={onOpenData}
                disabled={connecting}
                data-testid="data-button"
                className={HEADER_BTN}
              >
                <Database size={14} aria-hidden="true" />
                {t('dataModal.title')}
              </button>
            )}
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                disabled={connecting}
                data-testid="settings-button"
                className={HEADER_BTN}
              >
                <Settings size={14} aria-hidden="true" />
                {t('settings.title')}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="mb-5">
          <p className="mb-2.5 pl-0.5 text-[10px] font-semibold uppercase tracking-widest text-content-muted">
            {t('app.selectDevices')}
          </p>

          <div className="space-y-2" data-testid="device-list">
            {devices.map((device) => (
              <button
                key={`${device.vendorId}:${device.productId}`}
                type="button"
                data-testid="device-button"
                className={`group ${DEVICE_ENTRY_CLASS}`}
                onClick={() => onConnect(device)}
                disabled={connecting}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-content">
                    {device.productName || 'Unknown Device'}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] tracking-wide text-content-muted" data-testid="device-id">
                    {device.vendorId.toString(16).padStart(4, '0')}:
                    {device.productId.toString(16).padStart(4, '0')}
                    {device.type !== 'vial' && ` (${device.type})`}
                  </div>
                </div>
                {connecting ? (
                  <span className="text-sm text-accent">
                    {t('app.connecting', { dots: '...' })}
                  </span>
                ) : (
                  <ChevronRight size={16} aria-hidden="true" className="text-content-muted opacity-20 transition-opacity group-hover:opacity-60" />
                )}
              </button>
            ))}

            {devices.length === 0 && (
              <div className="py-4 text-center text-sm text-content-muted" data-testid="no-device-message">
                {t('app.deviceNotConnected')}
              </div>
            )}
          </div>
        </div>

        <div className="mb-4 border-t border-edge-subtle" />

        <button
          type="button"
          data-testid="dummy-button"
          className="flex w-full items-center gap-3 rounded-lg border border-dashed border-edge p-3 text-sm text-content-muted transition-colors hover:border-edge-strong hover:bg-surface-dim hover:text-content-secondary disabled:opacity-50"
          onClick={onLoadDummy}
          disabled={connecting}
        >
          {t('app.loadDummy')}
        </button>

        {syncStatus && syncStatus !== 'none' && (
          <div className="mt-3 text-center text-xs" data-testid="device-sync-status">
            <span className={SYNC_STATUS_CLASS[syncStatus]}>
              {t(`statusBar.sync.${syncStatus}`)}
            </span>
          </div>
        )}

        {devices.length === 0 && (
          <div className="mt-4 text-xs text-content-muted">
            {t('app.udevHelp')}
          </div>
        )}
      </div>
    </div>
  )
}
