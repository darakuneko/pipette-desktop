// SPDX-License-Identifier: GPL-2.0-or-later
// Data modal: typing analytics per-keyboard day-level view.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingDailySummary } from '../../../shared/types/typing-analytics'

interface Props {
  uid: string
  /** Called after a delete (partial or full) clears the current view. */
  onDeleted?: () => void
  /** Local tab by default. `"sync"` flips this component into a
   * single-remote-device view where summaries come from the hash-
   * scoped query and deletes route to the Sync-delete cloud path. */
  mode?: 'local' | 'sync'
  /** Required for `mode === "sync"`. Identifies which remote device's
   * days are being shown and acted on. */
  machineHash?: string
}

const BTN_DANGER_OUTLINE = 'rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50 disabled:cursor-not-allowed'
const BTN_SECONDARY = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50'

/** Local-time label for the next UTC midnight — used to tell the user
 * when a `live-day-locked` import target will stop being the live day.
 * Shows month/day together because the rollover often falls on the
 * next local calendar day (e.g. JST sees UTC rollover at 09:00). */
function utcRolloverLocalLabel(): string {
  const now = Date.now()
  const d = new Date(now)
  const unlockMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return new Date(unlockMs).toLocaleString(undefined, {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatActiveMs(ms: number): string {
  if (ms < 1_000) return `${ms} ms`
  const totalSec = Math.floor(ms / 1_000)
  const h = Math.floor(totalSec / 3_600)
  const m = Math.floor((totalSec % 3_600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

type ConfirmMode = 'selected' | 'all' | null

type ImportStatus =
  | { phase: 'importing' }
  | { phase: 'exporting' }
  | { phase: 'import-done'; imported: number; rejections: { fileName: string; reason: string }[] }
  | { phase: 'export-done'; written: number }

export function TypingAnalyticsContent({ uid, onDeleted, mode = 'local', machineHash }: Props) {
  const { t } = useTranslation()
  const [summaries, setSummaries] = useState<TypingDailySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>(null)
  const [busy, setBusy] = useState(false)
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null)
  const isSync = mode === 'sync' && typeof machineHash === 'string'

  const loadSummaries = useCallback(async () => {
    setLoading(true)
    try {
      if (isSync) {
        // Lazy fetch: pull any day cloud currently holds for this
        // remote device that isn't already in the local per-day tree.
        // The "known" set must be compared in UTC-day space because
        // the cloud listing is UTC but the daily-summary query groups
        // by local calendar day; mixing the two caused every Sync
        // view open to re-download the same days in non-UTC timezones.
        try {
          const [cloudDays, localDays] = await Promise.all([
            window.vialAPI.typingAnalyticsListRemoteCloudDays(uid, machineHash!),
            window.vialAPI.typingAnalyticsListLocalDeviceDays(uid, machineHash!),
          ])
          const knownUtcDays = new Set(localDays)
          const toFetch = cloudDays.filter((d) => !knownUtcDays.has(d))
          for (const day of toFetch) {
            await window.vialAPI.typingAnalyticsFetchRemoteDay(uid, machineHash!, day)
          }
        } catch {
          /* network errors surface via summaries being empty */
        }
      }
      const rows = isSync
        ? await window.vialAPI.typingAnalyticsListItemsForHash(uid, machineHash!)
        : await window.vialAPI.typingAnalyticsListItemsLocal(uid)
      setSummaries(rows)
      setSelected(new Set())
    } catch {
      setSummaries([])
    } finally {
      setLoading(false)
    }
  }, [uid, machineHash, isSync])

  useEffect(() => {
    void loadSummaries()
  }, [loadSummaries])

  const toggleSelected = useCallback((date: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])

  const allSelected = summaries.length > 0 && summaries.every((s) => selected.has(s.date))
  const selectAll = useCallback(() => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(summaries.map((s) => s.date)))
  }, [allSelected, summaries])

  const totalKeystrokes = useMemo(
    () => summaries.reduce((sum, s) => sum + s.keystrokes, 0),
    [summaries],
  )

  const handleDeleteSelected = useCallback(async () => {
    if (selected.size === 0) return
    // Capture the "delete clears the list" signal BEFORE the await so the
    // next loadSummaries() replacing `summaries` cannot race this check.
    const clearsView = summaries.length === selected.size
    setBusy(true)
    try {
      if (isSync) {
        for (const date of selected) {
          await window.vialAPI.typingAnalyticsDeleteRemoteDay(uid, machineHash!, date)
        }
      } else {
        await window.vialAPI.typingAnalyticsDeleteItems(uid, Array.from(selected))
      }
      setConfirmMode(null)
      await loadSummaries()
      if (clearsView) onDeleted?.()
    } finally {
      setBusy(false)
    }
  }, [uid, machineHash, isSync, selected, summaries.length, loadSummaries, onDeleted])

  const handleDeleteAll = useCallback(async () => {
    setBusy(true)
    try {
      if (isSync) {
        for (const summary of summaries) {
          await window.vialAPI.typingAnalyticsDeleteRemoteDay(uid, machineHash!, summary.date)
        }
      } else {
        await window.vialAPI.typingAnalyticsDeleteAll(uid)
      }
      setConfirmMode(null)
      await loadSummaries()
      onDeleted?.()
    } finally {
      setBusy(false)
    }
  }, [uid, machineHash, isSync, summaries, loadSummaries, onDeleted])

  const handleExport = useCallback(async () => {
    if (selected.size === 0) return
    setBusy(true)
    setImportStatus({ phase: 'exporting' })
    try {
      const res = await window.vialAPI.typingAnalyticsExport(uid, Array.from(selected))
      if (res.cancelled) {
        setImportStatus(null)
      } else {
        setImportStatus({ phase: 'export-done', written: res.written })
      }
    } finally {
      setBusy(false)
    }
  }, [uid, selected])

  const handleImport = useCallback(async () => {
    setBusy(true)
    setImportStatus({ phase: 'importing' })
    try {
      const { result, cancelled } = await window.vialAPI.typingAnalyticsImport()
      if (cancelled) {
        setImportStatus(null)
        return
      }
      setImportStatus({ phase: 'import-done', imported: result.imported, rejections: result.rejections })
      if (result.imported > 0) {
        await loadSummaries()
        onDeleted?.()
      }
    } finally {
      setBusy(false)
    }
  }, [loadSummaries, onDeleted])

  const footer = (
    <div className="mt-4 border-t border-edge pt-3 shrink-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {!isSync && confirmMode === null && (
            <>
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => void handleImport()}
                disabled={busy}
                data-testid="typing-import"
              >
                {t('dataModal.typing.importLabel')}
              </button>
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => void handleExport()}
                disabled={busy || selected.size === 0}
                data-testid="typing-export"
              >
                {t('dataModal.typing.exportLabel')}
              </button>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
        {confirmMode === 'selected' ? (
          <>
            <span className="text-sm text-danger">
              {t('dataModal.typing.confirmDeleteSelected', { count: selected.size })}
            </span>
            <button
              type="button"
              className={BTN_DANGER_OUTLINE}
              onClick={() => void handleDeleteSelected()}
              disabled={busy}
              data-testid="typing-delete-selected-confirm"
            >
              {t('common.confirmDelete')}
            </button>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => setConfirmMode(null)}
              disabled={busy}
              data-testid="typing-delete-selected-cancel"
            >
              {t('common.cancel')}
            </button>
          </>
        ) : confirmMode === 'all' ? (
          <>
            <span className="text-sm text-danger">{t('dataModal.typing.confirmDeleteAll')}</span>
            <button
              type="button"
              className={BTN_DANGER_OUTLINE}
              onClick={() => void handleDeleteAll()}
              disabled={busy}
              data-testid="typing-delete-all-confirm"
            >
              {t('common.confirmDelete')}
            </button>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => setConfirmMode(null)}
              disabled={busy}
              data-testid="typing-delete-all-cancel"
            >
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={BTN_DANGER_OUTLINE}
              onClick={() => setConfirmMode('selected')}
              disabled={selected.size === 0 || busy}
              data-testid="typing-delete-selected"
            >
              {t('dataModal.typing.deleteSelected', { count: selected.size })}
            </button>
            <button
              type="button"
              className={BTN_DANGER_OUTLINE}
              onClick={() => setConfirmMode('all')}
              disabled={summaries.length === 0 || busy}
              data-testid="typing-delete-all"
            >
              {t('dataModal.typing.deleteAll')}
            </button>
          </>
        )}
        </div>
      </div>
    </div>
  )

  const bannerTone = (() => {
    if (!importStatus) return ''
    if (importStatus.phase === 'importing' || importStatus.phase === 'exporting') {
      return 'border-edge bg-surface-dim text-content-secondary'
    }
    if (importStatus.phase === 'import-done' && importStatus.rejections.length > 0) {
      return 'border-warning/40 bg-warning/10 text-warning'
    }
    return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
  })()
  const inProgress = importStatus?.phase === 'importing' || importStatus?.phase === 'exporting'
  const importBanner = importStatus ? (
    <div
      className={`mb-2 flex items-start gap-2 rounded border px-3 py-2 text-[13px] shrink-0 ${bannerTone}`}
      data-testid="typing-import-status"
    >
      <div className="flex-1 space-y-1 min-w-0">
        {importStatus.phase === 'importing' && (
          <div>{t('dataModal.typing.importStatus.importing')}</div>
        )}
        {importStatus.phase === 'exporting' && (
          <div>{t('dataModal.typing.importStatus.exporting')}</div>
        )}
        {importStatus.phase === 'export-done' && (
          <div>{t('dataModal.typing.importStatus.exported', { count: importStatus.written })}</div>
        )}
        {importStatus.phase === 'import-done' && (
          <>
            <div>{t('dataModal.typing.importStatus.imported', { count: importStatus.imported })}</div>
            {importStatus.rejections.length > 0 && (
              <ul className="list-disc pl-4 space-y-0.5">
                {Array.from(
                  importStatus.rejections.reduce((m, r) => m.set(r.reason, (m.get(r.reason) ?? 0) + 1), new Map<string, number>()),
                ).map(([reason, count]) => (
                  <li key={reason}>
                    {t(`dataModal.typing.importStatus.reason.${reason}`, {
                      defaultValue: reason,
                      unlock: utcRolloverLocalLabel(),
                    })}
                    {count > 1 && <span className="ml-1 text-content-muted">(×{count})</span>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {!inProgress && (
        <button
          type="button"
          className="text-content-muted hover:text-content"
          onClick={() => setImportStatus(null)}
          aria-label={t('common.close')}
          data-testid="typing-import-status-dismiss"
        >
          ×
        </button>
      )}
    </div>
  ) : null

  if (loading) {
    return <div className="py-4 text-center text-[13px] text-content-muted">{t('common.loading')}</div>
  }

  if (summaries.length === 0) {
    return (
      <div className="flex flex-col h-full" data-testid="typing-empty">
        {importBanner}
        <div className="flex-1 py-4 text-center text-[13px] text-content-muted">
          {t('dataModal.typing.noItems')}
        </div>
        {footer}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="typing-list">
      {importBanner}
      <div className="py-2 text-[13px] text-content-muted shrink-0">
        {t('dataModal.typing.summaryLine', {
          days: summaries.length,
          keystrokes: totalKeystrokes.toLocaleString(),
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-edge text-content-secondary">
              <th className="w-8 py-1.5 px-2 text-left">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={selectAll}
                  aria-label={t('dataModal.typing.selectAll')}
                  data-testid="typing-select-all"
                />
              </th>
              <th className="py-1.5 px-2 text-left font-medium">{t('dataModal.typing.colDate')}</th>
              <th className="py-1.5 px-2 text-right font-medium">{t('dataModal.typing.colKeystrokes')}</th>
              <th className="py-1.5 px-2 text-right font-medium">{t('dataModal.typing.colActiveMs')}</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => (
              <tr
                key={s.date}
                className="border-b border-edge/50 hover:bg-surface-dim/30"
                data-testid={`typing-row-${s.date}`}
              >
                <td className="py-1.5 px-2">
                  <input
                    type="checkbox"
                    checked={selected.has(s.date)}
                    onChange={() => toggleSelected(s.date)}
                    aria-label={t('dataModal.typing.selectRow', { date: s.date })}
                  />
                </td>
                <td className="py-1.5 px-2 font-mono text-content">{s.date}</td>
                <td className="py-1.5 px-2 text-right text-content">{s.keystrokes.toLocaleString()}</td>
                <td className="py-1.5 px-2 text-right text-content-secondary">{formatActiveMs(s.activeMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  )
}
