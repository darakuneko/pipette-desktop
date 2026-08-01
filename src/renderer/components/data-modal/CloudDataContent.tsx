// SPDX-License-Identifier: GPL-2.0-or-later
//
// Data modal > Sync > Cloud Data — global (all-keyboard) remote reset
// targets: favorites, i18n/theme packs, key labels, imported
// typing-test texts, plus a minimal Undecryptable Files recovery list
// (per-file delete only — no bulk select-all; the decrypt sweep that
// builds `scanResult.undecryptable` in the first place stays in
// scanRemoteData). Per-keyboard remote deletion already lives in
// Sync > Keyboards (KeyboardSavesContent's "Delete All"), so this pane
// only covers the targets that aren't tied to a single keyboard uid.
// Reuses useDataNavTree's RAW scan result via the `scanResult`/
// `scanning`/`onRescan` props (threaded through by DataModal, which
// already holds `nav` in scope) instead of running its own
// scanRemote() — a second full download+decrypt pass over every remote
// file was the heaviest waste in the original version of this pane.
// useDataNavTree's own `syncScanResult` is filtered (favorites zeroed
// for the orphan-discovery tree), so the pre-filter result is threaded
// through separately for this pane's actual need: showing/resetting a
// target's remote copy regardless of whether the discovery tree
// filters it out.

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmResetRow } from './ConfirmResetRow'
import type { UseSyncReturn } from '../../hooks/useSync'
import type { SyncDataScanResult, SyncResetTargets } from '../../../shared/types/sync'

type CloudTargetKey = 'favorites' | 'i18nPacks' | 'themePacks' | 'keyLabels' | 'typingTestTexts'

const TARGET_ORDER: { key: CloudTargetKey; labelKey: string }[] = [
  { key: 'favorites', labelKey: 'sync.resetTarget.favorites' },
  { key: 'i18nPacks', labelKey: 'sync.resetTarget.i18nPacks' },
  { key: 'themePacks', labelKey: 'sync.resetTarget.themePacks' },
  { key: 'keyLabels', labelKey: 'sync.resetTarget.keyLabels' },
  { key: 'typingTestTexts', labelKey: 'sync.resetTarget.typingTestTexts' },
]

function targetPresent(result: SyncDataScanResult, key: CloudTargetKey): boolean {
  switch (key) {
    case 'favorites': return result.favorites.length > 0
    // i18n/theme packs: pack-id presence OR'd with the index file's own
    // presence (`hasI18nData`/`hasThemesData`) — the index can outlive
    // every pack id it once listed (all tombstoned and GC'd), so
    // checking pack ids alone misses that 30-day dead zone where the
    // target is still on Drive but no id remains. The OR is applied
    // here (not just trusted from the scan result) so this still works
    // even if a caller constructs a scan result with one field set
    // but not the other.
    case 'i18nPacks': return result.i18nPacks.length > 0 || result.hasI18nData
    case 'themePacks': return result.themePacks.length > 0 || result.hasThemesData
    case 'keyLabels': return result.keyLabels
    case 'typingTestTexts': return result.typingTestTexts
  }
}

/** Confirmation target: either a whole reset-target row (favorites,
 *  packs, …) or a single undecryptable file's own delete row — kept as
 *  one discriminated state so at most one row is ever mid-confirm at a
 *  time across both sections. */
type ConfirmingTarget =
  | { kind: 'target'; key: CloudTargetKey }
  | { kind: 'file'; fileId: string }

export interface CloudDataContentProps {
  sync: UseSyncReturn
  /** Raw (unfiltered) scan result from useDataNavTree — null until the
   *  nav tree's own auto-scan (or a manual rescan) resolves. */
  scanResult: SyncDataScanResult | null
  scanning: boolean
  /** Re-runs useDataNavTree's shared scan — called after a successful
   *  delete so both this pane and the nav tree pick up the change. */
  onRescan: () => Promise<void>
}

export function CloudDataContent({ sync, scanResult, scanning, onRescan }: CloudDataContentProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState<ConfirmingTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDeleteTarget = useCallback(async (key: CloudTargetKey) => {
    setBusy(true)
    setError(null)
    try {
      const targets: SyncResetTargets = { keyboards: false, favorites: false, [key]: true }
      const result = await sync.resetSyncTargets(targets)
      if (!result.success) {
        setError(result.error ?? t('statusBar.sync.error'))
        return
      }
      setConfirming(null)
      await onRescan()
    } catch {
      setError(t('statusBar.sync.error'))
    } finally {
      setBusy(false)
    }
  }, [sync, onRescan, t])

  const handleDeleteFile = useCallback(async (fileId: string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await sync.deleteFiles([fileId])
      if (!result.success) {
        setError(result.error ?? t('statusBar.sync.error'))
        return
      }
      setConfirming(null)
      await onRescan()
    } catch {
      setError(t('statusBar.sync.error'))
    } finally {
      setBusy(false)
    }
  }, [sync, onRescan, t])

  if (scanning && !scanResult) {
    return <div className="py-4 text-center text-sm text-content-muted">{t('sync.scanning')}</div>
  }

  const visibleTargets = scanResult ? TARGET_ORDER.filter(({ key }) => targetPresent(scanResult, key)) : []
  const undecryptable = scanResult?.undecryptable ?? []
  const isEmpty = visibleTargets.length === 0 && undecryptable.length === 0

  return (
    <div className="space-y-4" data-testid="cloud-data-content">
      {error && (
        <div className="text-xs text-danger" data-testid="cloud-data-error">
          {error}
        </div>
      )}
      {isEmpty ? (
        <p className="text-sm text-content-muted" data-testid="cloud-data-empty">
          {t('sync.noRemoteData')}
        </p>
      ) : (
        <>
          {visibleTargets.length > 0 && (
            <div className="space-y-2">
              {visibleTargets.map(({ key, labelKey }) => (
                <ConfirmResetRow
                  key={key}
                  rowClassName="flex items-center justify-between gap-2 rounded border border-edge px-3 py-2"
                  rowTestid={`cloud-data-row-${key}`}
                  labelClassName="text-sm text-content"
                  label={t(labelKey)}
                  triggerLabel={t('common.reset')}
                  confirmLabel={t('common.confirmDelete')}
                  cancelLabel={t('common.cancel')}
                  warning={t('sync.resetTargetsConfirm')}
                  confirming={confirming?.kind === 'target' && confirming.key === key}
                  busy={busy}
                  onTrigger={() => setConfirming({ kind: 'target', key })}
                  onConfirm={() => void handleDeleteTarget(key)}
                  onCancel={() => setConfirming(null)}
                  triggerTestid={`cloud-data-reset-${key}`}
                  confirmTestid={`cloud-data-confirm-${key}`}
                  cancelTestid={`cloud-data-cancel-${key}`}
                />
              ))}
            </div>
          )}
          {undecryptable.length > 0 && (
            <div className="space-y-2" data-testid="cloud-data-undecryptable">
              <div className="text-sm text-content-muted" data-testid="cloud-data-undecryptable-count">
                {t('sync.undecryptableCount', { count: undecryptable.length })}
              </div>
              <div className="space-y-1">
                {undecryptable.map((file) => (
                  <ConfirmResetRow
                    key={file.fileId}
                    rowClassName="flex items-center justify-between gap-2 rounded border border-edge px-3 py-2"
                    rowTestid={`undecryptable-file-${file.fileId}`}
                    labelClassName="text-sm text-content truncate"
                    label={file.syncUnit ?? file.fileName}
                    triggerLabel={t('common.delete')}
                    confirmLabel={t('common.confirmDelete')}
                    cancelLabel={t('common.cancel')}
                    confirming={confirming?.kind === 'file' && confirming.fileId === file.fileId}
                    busy={busy}
                    onTrigger={() => setConfirming({ kind: 'file', fileId: file.fileId })}
                    onConfirm={() => void handleDeleteFile(file.fileId)}
                    onCancel={() => setConfirming(null)}
                    triggerTestid={`undecryptable-delete-${file.fileId}`}
                    confirmTestid={`undecryptable-delete-confirm-${file.fileId}`}
                    cancelTestid={`undecryptable-delete-cancel-${file.fileId}`}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
