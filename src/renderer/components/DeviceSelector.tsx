// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings, Database, ChevronRight, ChevronLeft } from 'lucide-react'
import { SYNC_STATUS_CLASS } from './sync-ui'
import type { DeviceInfo } from '../../shared/types/protocol'
import type { SyncStatusType } from '../../shared/types/sync'
import type { PipetteFileKeyboard, PipetteFileEntry } from '../app-types'
import { AnalyzePage } from './analyze/AnalyzePage'

const DEVICE_ENTRY_CLASS =
  'flex w-full items-center gap-3.5 rounded-lg border border-edge p-3.5 text-left transition-colors hover:border-accent hover:bg-accent/10 disabled:opacity-50'

const HEADER_BTN =
  'flex items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1.5 text-[13px] font-medium text-content-muted transition-colors hover:border-edge hover:bg-surface-dim hover:text-content-secondary disabled:opacity-50'

const TAB_CLASS =
  'flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors'

const TAB_ACTIVE =
  'bg-surface text-content shadow-sm'

const TAB_INACTIVE =
  'text-content-muted hover:text-content-secondary'

const LIST_CLASS =
  'min-h-[340px] max-h-[340px] space-y-2 overflow-y-auto pb-2 pr-1'

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

interface Props {
  devices: DeviceInfo[]
  connecting: boolean
  error: string | null
  onConnect: (device: DeviceInfo) => void
  onLoadDummy: () => void
  onLoadPipetteFile: () => void
  pipetteFileKeyboards?: PipetteFileKeyboard[]
  pipetteFileEntries?: PipetteFileEntry[]
  onOpenPipetteFileEntry?: (entry: PipetteFileEntry) => void
  onRefreshPipetteFileEntries?: () => void
  connectedDeviceNames?: string[]
  onOpenSettings?: () => void
  onOpenData?: () => void
  syncStatus?: SyncStatusType
  deviceWarning?: string | null
  onClearError?: () => void
}

export function DeviceSelector({
  devices,
  connecting,
  error,
  onConnect,
  onLoadDummy,
  onLoadPipetteFile,
  pipetteFileKeyboards,
  pipetteFileEntries,
  onOpenPipetteFileEntry,
  onRefreshPipetteFileEntries,
  connectedDeviceNames,
  onOpenSettings,
  onOpenData,
  syncStatus,
  deviceWarning,
  onClearError,
}: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'keyboard' | 'file' | 'analyze'>('keyboard')
  // null = keyboard list, string = selected keyboard UID showing entries
  const [selectedFileUid, setSelectedFileUid] = useState<string | null>(null)

  // Refresh saved file entries whenever the File tab becomes active
  useEffect(() => {
    if (tab === 'file') {
      setSelectedFileUid(null)
      onRefreshPipetteFileEntries?.()
    }
  }, [tab, onRefreshPipetteFileEntries])

  // Exclude keyboards that are currently connected via USB
  const filteredKeyboards = useMemo(() => {
    if (!pipetteFileKeyboards) return []
    if (!connectedDeviceNames || connectedDeviceNames.length === 0) return pipetteFileKeyboards
    const names = new Set(connectedDeviceNames)
    return pipetteFileKeyboards.filter((kb) => !names.has(kb.name))
  }, [pipetteFileKeyboards, connectedDeviceNames])

  // Entries filtered for the selected keyboard
  const selectedEntries = useMemo(() => {
    if (!selectedFileUid || !pipetteFileEntries) return []
    return pipetteFileEntries.filter((e) => e.uid === selectedFileUid)
  }, [selectedFileUid, pipetteFileEntries])

  const selectedKeyboardName = useMemo(() => {
    if (!selectedFileUid || !pipetteFileKeyboards) return ''
    return pipetteFileKeyboards.find((k) => k.uid === selectedFileUid)?.name ?? ''
  }, [selectedFileUid, pipetteFileKeyboards])

  if (tab === 'analyze') {
    return <AnalyzePage onBack={() => setTab('keyboard')} />
  }

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

        {/* Tab selector */}
        <div className="mb-4 flex gap-1 rounded-lg bg-surface-dim p-1" data-testid="device-tabs">
          <button
            type="button"
            className={`${TAB_CLASS} ${tab === 'keyboard' ? TAB_ACTIVE : TAB_INACTIVE}`}
            onClick={() => { setTab('keyboard'); onClearError?.() }}
            data-testid="tab-keyboard"
          >
            {t('app.keyboardTab')}
          </button>
          <button
            type="button"
            className={`${TAB_CLASS} ${tab === 'file' ? TAB_ACTIVE : TAB_INACTIVE}`}
            onClick={() => { setTab('file'); onClearError?.() }}
            data-testid="tab-file"
          >
            {t('app.fileTab')}
          </button>
          <button
            type="button"
            className={`${TAB_CLASS} ${tab === 'analyze' ? TAB_ACTIVE : TAB_INACTIVE}`}
            onClick={() => { setTab('analyze'); onClearError?.() }}
            data-testid="tab-analyze"
          >
            {t('app.analyzeTab')}
          </button>
        </div>

        {tab === 'keyboard' && (
          <>
            <div className="mb-5">
              <p className="mb-2.5 pl-0.5 text-[10px] font-semibold uppercase tracking-widest text-content-muted">
                {t('app.selectDevices')}
              </p>

              <div className={LIST_CLASS} data-testid="device-list">
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
                    <ChevronRight size={16} aria-hidden="true" className="text-content-muted opacity-20 transition-opacity group-hover:opacity-60" />
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
          </>
        )}

        {tab === 'file' && !selectedFileUid && (
          <div data-testid="file-tab-content">
            <div className="mb-5">
              <p className="mb-2.5 pl-0.5 text-[10px] font-semibold uppercase tracking-widest text-content-muted">
                {t('app.selectKeyboard')}
              </p>

              <div className={LIST_CLASS} data-testid="pipette-keyboard-list">
                {filteredKeyboards.map((kb) => (
                  <button
                    key={kb.uid}
                    type="button"
                    data-testid="pipette-keyboard-entry"
                    className={`group ${DEVICE_ENTRY_CLASS}`}
                    onClick={() => setSelectedFileUid(kb.uid)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-content">
                        {kb.name}
                      </div>
                      <div className="mt-0.5 text-[11px] text-content-muted">
                        {t('app.fileCount', { count: kb.entryCount })}
                      </div>
                    </div>
                    <ChevronRight size={16} aria-hidden="true" className="text-content-muted opacity-20 transition-opacity group-hover:opacity-60" />
                  </button>
                ))}

                {filteredKeyboards.length === 0 && (
                  <div className="py-4 text-center text-sm text-content-muted" data-testid="no-file-message">
                    {t('app.noSavedFiles')}
                  </div>
                )}
              </div>
            </div>

            <div className="mb-4 border-t border-edge-subtle" />

            <button
              type="button"
              data-testid="pipette-file-button"
              className="flex w-full items-center gap-3 rounded-lg border border-dashed border-edge p-3 text-sm text-content-muted transition-colors hover:border-edge-strong hover:bg-surface-dim hover:text-content-secondary disabled:opacity-50"
              onClick={onLoadPipetteFile}
              disabled={connecting}
            >
              {t('app.loadPipetteFile')}
            </button>
          </div>
        )}

        {tab === 'file' && selectedFileUid && (
          <div data-testid="file-entries-content">
            <div className="mb-5">
              <div className="mb-2.5 flex items-center justify-between pl-0.5">
                <button
                  type="button"
                  data-testid="file-back-button"
                  className="flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-widest text-content-muted transition-colors hover:text-content-secondary"
                  onClick={() => { setSelectedFileUid(null); onClearError?.() }}
                >
                  <ChevronLeft size={12} aria-hidden="true" />
                  {t('common.back')}
                </button>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-content-muted">
                  {selectedKeyboardName}
                </span>
              </div>

              <div className={LIST_CLASS} data-testid="pipette-file-list">
                {selectedEntries.map((entry) => (
                  <button
                    key={entry.entryId}
                    type="button"
                    data-testid="pipette-file-entry"
                    className={`group ${DEVICE_ENTRY_CLASS}`}
                    onClick={() => onOpenPipetteFileEntry?.(entry)}
                    disabled={connecting}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-content">
                        {entry.label || entry.keyboardName}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] tracking-wide text-content-muted">
                        {formatDate(entry.savedAt)}
                      </div>
                    </div>
                    <ChevronRight size={16} aria-hidden="true" className="text-content-muted opacity-20 transition-opacity group-hover:opacity-60" />
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-4 border-t border-edge-subtle" />

            <button
              type="button"
              data-testid="pipette-file-button-entry"
              className="flex w-full items-center gap-3 rounded-lg border border-dashed border-edge p-3 text-sm text-content-muted transition-colors hover:border-edge-strong hover:bg-surface-dim hover:text-content-secondary disabled:opacity-50"
              onClick={onLoadPipetteFile}
              disabled={connecting}
            >
              {t('app.loadPipetteFile')}
            </button>
          </div>
        )}

        {deviceWarning && (
          <div className="mt-3 text-center text-xs text-warning" data-testid="device-warning">
            {deviceWarning}
          </div>
        )}

        {syncStatus && syncStatus !== 'none' && (
          <div className="mt-3 text-center text-xs" data-testid="device-sync-status">
            <span className={SYNC_STATUS_CLASS[syncStatus]}>
              {t(`statusBar.sync.${syncStatus}`)}
            </span>
          </div>
        )}

        {tab === 'keyboard' && devices.length === 0 && (
          <div className="mt-4 text-xs text-content-muted">
            {t('app.udevHelp')}
          </div>
        )}
      </div>
    </div>
  )
}
