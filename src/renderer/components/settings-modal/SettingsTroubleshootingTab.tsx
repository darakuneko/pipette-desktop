// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { BTN_SECONDARY, toggleSetItem } from './settings-modal-shared'
import { SyncDataResetSection } from './SyncDataResetSection'
import { LocalDataResetGroup } from './LocalDataResetGroup'
import type { UseSyncReturn } from '../../hooks/useSync'
import type { LocalResetTargets, StoredKeyboardInfo } from '../../../shared/types/sync'

export interface SettingsTroubleshootingTabProps {
  sync: UseSyncReturn
  storedKeyboards: StoredKeyboardInfo[]
  syncDisabled: boolean
  busy: boolean
  isSyncing: boolean
  importResult: 'success' | 'error' | null
  selectedKeyboardUids: Set<string>
  setSelectedKeyboardUids: React.Dispatch<React.SetStateAction<Set<string>>>
  localTargets: LocalResetTargets
  setLocalTargets: React.Dispatch<React.SetStateAction<LocalResetTargets>>
  confirmingLocalReset: boolean
  setConfirmingLocalReset: (v: boolean) => void
  handleResetLocalTargets: () => void
  handleExport: () => void
  handleImport: () => void
  onResetStart?: () => void
  onResetEnd?: () => void
}

export function SettingsTroubleshootingTab({
  sync,
  storedKeyboards,
  syncDisabled,
  busy,
  isSyncing,
  importResult,
  selectedKeyboardUids,
  setSelectedKeyboardUids,
  localTargets,
  setLocalTargets,
  confirmingLocalReset,
  setConfirmingLocalReset,
  handleResetLocalTargets,
  handleExport,
  handleImport,
  onResetStart,
  onResetEnd,
}: SettingsTroubleshootingTabProps) {
  const { t } = useTranslation()

  return (
    <div className="pt-4 space-y-6" data-testid="troubleshooting-tab-content">
      {/* Sync Data (unified scan + reset) */}
      <SyncDataResetSection
        sync={sync}
        storedKeyboards={storedKeyboards}
        disabled={syncDisabled}
        onResetStart={onResetStart}
        onResetEnd={onResetEnd}
      />

      {/* Local Data */}
      <section>
        <h4 className="mb-2 text-sm font-medium text-content-secondary">
          {t('sync.localData')}
        </h4>
        <div className="flex items-center justify-between mb-3">
          {importResult ? (
            <span
              className={`text-sm ${importResult === 'success' ? 'text-accent' : 'text-danger'}`}
              data-testid="local-data-import-result"
            >
              {importResult === 'success' ? t('sync.importComplete') : t('sync.importFailed')}
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={handleImport}
              disabled={busy}
              data-testid="local-data-import"
            >
              {t('sync.import')}
            </button>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={handleExport}
              disabled={busy}
              data-testid="local-data-export"
            >
              {t('sync.export')}
            </button>
          </div>
        </div>
        <LocalDataResetGroup
          storedKeyboards={storedKeyboards}
          selectedKeyboardUids={selectedKeyboardUids}
          onToggleKeyboard={(uid, checked) => {
            setSelectedKeyboardUids((prev) => toggleSetItem(prev, uid, checked))
          }}
          localTargets={localTargets}
          onToggleTarget={(key, checked) => setLocalTargets((prev) => ({ ...prev, [key]: checked }))}
          disabled={busy || isSyncing}
          confirming={confirmingLocalReset}
          onRequestConfirm={() => setConfirmingLocalReset(true)}
          onCancelConfirm={() => setConfirmingLocalReset(false)}
          onConfirm={handleResetLocalTargets}
          busy={busy}
          confirmDisabled={busy || isSyncing}
        />
      </section>
    </div>
  )
}
