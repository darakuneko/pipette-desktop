// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { BTN_SECONDARY, BTN_DANGER_OUTLINE, toggleSetItem } from './settings-modal-shared'
import type { UseSyncReturn } from '../../hooks/useSync'
import type { SyncDataScanResult, StoredKeyboardInfo } from '../../../shared/types/sync'

export interface SyncDataResetSectionProps {
  sync: UseSyncReturn
  storedKeyboards: StoredKeyboardInfo[]
  disabled: boolean
  onResetStart?: () => void
  onResetEnd?: () => void
  /** When true, filter out items that exist locally (show cloud-only orphans) */
  excludeLocalData?: boolean
}

export function SyncDataResetSection({ sync, storedKeyboards, disabled, onResetStart, onResetEnd, excludeLocalData }: SyncDataResetSectionProps) {
  const { t } = useTranslation()
  const localKeyboardUids = useMemo(() => new Set(storedKeyboards.map((kb) => kb.uid)), [storedKeyboards])
  const [rawScanResult, setRawScanResult] = useState<SyncDataScanResult | null>(null)

  // Filter scan result: when excludeLocalData is true, remove items that exist locally
  const scanResult = useMemo(() => {
    if (!rawScanResult || !excludeLocalData) return rawScanResult
    return {
      keyboards: rawScanResult.keyboards.filter((uid) => !localKeyboardUids.has(uid)),
      favorites: [], // All favorites exist locally, so cloud-only = none
      undecryptable: rawScanResult.undecryptable,
    }
  }, [rawScanResult, excludeLocalData, localKeyboardUids])
  const [scanning, setScanning] = useState(false)
  const [selectedKeyboardUids, setSelectedKeyboardUids] = useState<Set<string>>(new Set())
  const [favoritesSelected, setFavoritesSelected] = useState(false)
  const [selectedUndecryptable, setSelectedUndecryptable] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const keyboardNameMap = useMemo(() => new Map(storedKeyboards.map((kb) => [kb.uid, kb.name])), [storedKeyboards])

  const resetSelections = useCallback(() => {
    setConfirming(false)
    setSelectedKeyboardUids(new Set())
    setFavoritesSelected(false)
    setSelectedUndecryptable(new Set())
  }, [])

  const handleScan = useCallback(async () => {
    setScanning(true)
    setRawScanResult(null)
    resetSelections()
    setError(null)
    try {
      const result = await sync.scanRemote()
      setRawScanResult(result)
    } catch {
      setError(t('statusBar.sync.error'))
    } finally {
      setScanning(false)
    }
  }, [sync, resetSelections, t])

  // Auto-scan on mount
  const autoScannedRef = useRef(false)
  useEffect(() => {
    if (autoScannedRef.current || disabled) return
    autoScannedRef.current = true
    void handleScan()
  }, [handleScan, disabled])

  const toggleUndecryptable = useCallback((fileId: string) => {
    setSelectedUndecryptable((prev) => toggleSetItem(prev, fileId, !prev.has(fileId)))
    setConfirming(false)
  }, [])

  const toggleAllUndecryptable = useCallback(() => {
    if (!scanResult) return
    if (selectedUndecryptable.size === scanResult.undecryptable.length) {
      setSelectedUndecryptable(new Set())
    } else {
      setSelectedUndecryptable(new Set(scanResult.undecryptable.map((f) => f.fileId)))
    }
    setConfirming(false)
  }, [scanResult, selectedUndecryptable.size])

  const anySelected = selectedKeyboardUids.size > 0 || favoritesSelected || selectedUndecryptable.size > 0
  const allUndecryptableSelected = scanResult !== null && scanResult.undecryptable.length > 0 && selectedUndecryptable.size === scanResult.undecryptable.length

  const handleDelete = useCallback(async () => {
    if (!anySelected) return
    setDeleting(true)
    setError(null)
    onResetStart?.()
    try {
      if (selectedKeyboardUids.size > 0 || favoritesSelected) {
        const targets = {
          keyboards: selectedKeyboardUids.size > 0 ? [...selectedKeyboardUids] : false as const,
          favorites: favoritesSelected,
        }
        const result = await sync.resetSyncTargets(targets)
        if (!result.success) {
          setError(result.error ?? t('statusBar.sync.error'))
          return
        }
      }
      if (selectedUndecryptable.size > 0) {
        const result = await sync.deleteFiles([...selectedUndecryptable])
        if (!result.success) {
          setError(result.error ?? t('statusBar.sync.error'))
          return
        }
      }
      resetSelections()
      try {
        const result = await sync.scanRemote()
        setRawScanResult(result)
      } catch {
        setRawScanResult(null)
        setError(t('statusBar.sync.error'))
      }
    } catch {
      setError(t('statusBar.sync.error'))
    } finally {
      setDeleting(false)
      onResetEnd?.()
    }
  }, [sync, selectedKeyboardUids, favoritesSelected, selectedUndecryptable, resetSelections, onResetStart, onResetEnd, t])

  const hasNoData = scanResult !== null && scanResult.keyboards.length === 0 && scanResult.favorites.length === 0 && scanResult.undecryptable.length === 0

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-end">
        <button
          type="button"
          className={BTN_SECONDARY}
          onClick={handleScan}
          disabled={disabled || scanning}
          data-testid="sync-data-scan"
        >
          {scanning ? t('sync.scanning') : t('sync.scanRemote')}
        </button>
      </div>
      {error && (
        <div className="mb-2 text-xs text-danger" data-testid="sync-data-error">
          {error}
        </div>
      )}
      {hasNoData && (
        <p className="text-sm text-content-muted" data-testid="sync-data-empty">
          {t('sync.noRemoteData')}
        </p>
      )}
      {scanResult !== null && !hasNoData && (
        <div className="space-y-2">
          {scanResult.keyboards.length > 0 && (
            <div>
              <span className="text-sm text-content-muted">{t('sync.resetTarget.keyboardData')}</span>
              <div className="ml-4 mt-1 space-y-1">
                {scanResult.keyboards.map((uid) => (
                  <label key={uid} className="flex items-center gap-2 text-sm text-content" data-testid={`sync-target-keyboard-${uid}`}>
                    <input
                      type="checkbox"
                      checked={selectedKeyboardUids.has(uid)}
                      onChange={(e) => {
                        setSelectedKeyboardUids((prev) => toggleSetItem(prev, uid, e.target.checked))
                        setConfirming(false)
                      }}
                      disabled={disabled || deleting}
                      className="accent-danger"
                    />
                    {keyboardNameMap.get(uid) ?? uid}
                  </label>
                ))}
              </div>
            </div>
          )}
          {scanResult.favorites.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-content" data-testid="sync-target-favorites">
              <input
                type="checkbox"
                checked={favoritesSelected}
                onChange={(e) => {
                  setFavoritesSelected(e.target.checked)
                  setConfirming(false)
                }}
                disabled={disabled || deleting}
                className="accent-danger"
              />
              {t('sync.resetTarget.favorites')}
            </label>
          )}
          {scanResult.undecryptable.length > 0 && (
            <div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-content-muted" data-testid="sync-data-undecryptable-count">
                  {t('sync.undecryptableCount', { count: scanResult.undecryptable.length })}
                </span>
                <button
                  type="button"
                  className="text-xs text-content-muted hover:text-content"
                  onClick={toggleAllUndecryptable}
                  data-testid="undecryptable-toggle-all"
                >
                  {allUndecryptableSelected ? t('sync.deselectAll') : t('sync.selectAll')}
                </button>
              </div>
              <div className="mt-1 max-h-40 overflow-y-auto space-y-1">
                {scanResult.undecryptable.map((file) => (
                  <label
                    key={file.fileId}
                    className="flex items-center gap-2 rounded border border-edge bg-surface/20 px-2 py-1.5 text-sm text-content"
                    data-testid={`undecryptable-file-${file.fileId}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedUndecryptable.has(file.fileId)}
                      onChange={() => toggleUndecryptable(file.fileId)}
                      disabled={disabled || deleting}
                      className="accent-danger"
                    />
                    <span className="truncate">{file.syncUnit ?? file.fileName}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center justify-end">
            <button
              type="button"
              className={BTN_DANGER_OUTLINE}
              onClick={() => setConfirming(true)}
              disabled={disabled || !anySelected || deleting}
              data-testid="sync-reset-data"
            >
              {t('sync.deleteSelected')}
            </button>
          </div>
          {confirming && (
            <div className="space-y-2">
              <div
                className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
                data-testid="sync-reset-data-warning"
              >
                {t('sync.resetTargetsConfirm')}
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  className={BTN_SECONDARY}
                  onClick={() => setConfirming(false)}
                  disabled={deleting}
                  data-testid="sync-reset-data-cancel"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="rounded bg-danger px-3 py-1 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50"
                  onClick={handleDelete}
                  disabled={!anySelected || deleting}
                  data-testid="sync-reset-data-confirm"
                >
                  {t('sync.deleteSelected')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
