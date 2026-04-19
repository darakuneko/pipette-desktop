// SPDX-License-Identifier: GPL-2.0-or-later
// Data modal: typing analytics per-keyboard day-level view.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingDailySummary } from '../../../shared/types/typing-analytics'

interface Props {
  uid: string
  name: string
  /** Called after a delete (partial or full) clears the current view. */
  onDeleted?: () => void
  /** Local tab by default. `"sync"` flips this component into a
   * single-remote-device view where summaries come from the hash-
   * scoped query and deletes route to the Sync-delete cloud path. */
  mode?: 'local' | 'sync'
  /** Required for `mode === "sync"`. Identifies which remote device's
   * days are being shown and acted on. */
  machineHash?: string
  /** Optional heading suffix (e.g. device label) appended next to the
   * keyboard name for the Sync view. */
  deviceLabel?: string
}

const BTN_DANGER_OUTLINE = 'rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50 disabled:cursor-not-allowed'
const BTN_SECONDARY = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50'

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

export function TypingAnalyticsContent({ uid, name, onDeleted, mode = 'local', machineHash, deviceLabel }: Props) {
  const { t } = useTranslation()
  const [summaries, setSummaries] = useState<TypingDailySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>(null)
  const [busy, setBusy] = useState(false)
  const isSync = mode === 'sync' && typeof machineHash === 'string'

  const loadSummaries = useCallback(async () => {
    setLoading(true)
    try {
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

  const footer = (
    <div className="mt-4 border-t border-edge pt-3 shrink-0">
      <div className="flex flex-wrap items-center justify-end gap-2">
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
  )

  if (loading) {
    return <div className="py-4 text-center text-[13px] text-content-muted">{t('common.loading')}</div>
  }

  if (summaries.length === 0) {
    return (
      <div className="flex flex-col h-full" data-testid="typing-empty">
        <div className="flex-1 py-4 text-center text-[13px] text-content-muted">
          {t('dataModal.typing.noItems')}
        </div>
        {footer}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="typing-list">
      <div className="flex items-center justify-between py-2 text-[13px] text-content-muted shrink-0">
        <span>
          {t('dataModal.typing.summaryHeader', {
            name: deviceLabel ? `${name} — ${deviceLabel}` : name,
            days: summaries.length,
            keystrokes: totalKeystrokes.toLocaleString(),
          })}
        </span>
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
