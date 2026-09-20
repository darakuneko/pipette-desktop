// SPDX-License-Identifier: GPL-2.0-or-later
// Single entry point for exporting the Analyze charts as CSV. The
// modal lists every category as a toggle button (all on by default)
// and runs the corresponding builder for each selected category. All
// resulting files are shipped to the main process in a single bundle
// so the user only sees one directory picker no matter how many
// categories they ticked.
//
// Filenames follow `{keyboard}_{hash|all}_{start}_{end}_{slug}.csv`,
// where the timestamps are local-time YYYYMMDDHHmm so the user can
// see at a glance which range a file covers without reopening it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KEYBOARD_LAYOUTS, LAYOUT_BY_ID } from '../../data/keyboard-layouts'
import { useKeyLabels } from '../../hooks/useKeyLabels'
import { AnchoredPopover } from '../ui/AnchoredPopover'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { FILTER_BUTTON } from './analyze-filter-styles'
import { scopeToSelectValue } from '../../../shared/types/analyze-filters'
import { TYPING_APP_UNKNOWN_NAME } from '../../../shared/types/typing-analytics'
import {
  type AnalyzeExportContext,
  type AnalyzeUploadCallbacks,
  type Category,
  CATEGORIES,
  REQUIRES_SNAPSHOT,
  allOn,
  formatLocalCompact,
  sanitizeKeyboardName,
  categoryRowClass,
  TARGET_POPOVER_MAX_H,
  TARGET_POPOVER_MIN_H,
  VIEWPORT_EDGE_GAP,
  specificsFor,
  pickBuilders,
} from './analyze-export-helpers'

export type { AnalyzeExportContext, AnalyzeUploadCallbacks, AnalyzeExportCategory } from './analyze-export-helpers'

interface Props {
  isOpen: boolean
  onClose: () => void
  ctx: AnalyzeExportContext | null
  /** `'export'` is the historical CSV-bundle path. `'upload'` reuses
   * the same category-picker UI but routes the confirm action to
   * `upload.onConfirm` and swaps the button label. */
  mode?: 'export' | 'upload'
  upload?: AnalyzeUploadCallbacks
}

export function AnalyzeExportModal({ isOpen, onClose, ctx, mode = 'export', upload }: Props) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Record<Category, boolean>>(allOn)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([])
  const [targetPickerOpen, setTargetPickerOpen] = useState(false)
  const targetTriggerRef = useRef<HTMLButtonElement>(null)
  const keyLabels = useKeyLabels()
  const [appDataApps, setAppDataApps] = useState<string[]>([])
  const [appDataOptions, setAppDataOptions] = useState<string[]>([])
  const [appPickerOpen, setAppPickerOpen] = useState(false)
  const appTriggerRef = useRef<HTMLButtonElement>(null)

  const layoutOptions = useMemo(() => {
    const sourceId = ctx?.layoutComparison.sourceLayoutId
    const seen = new Set<string>()
    const out: { id: string; name: string }[] = []
    for (const meta of keyLabels.metas) {
      if (seen.has(meta.id) || meta.id === sourceId) continue
      seen.add(meta.id)
      out.push({ id: meta.id, name: meta.name })
    }
    for (const def of KEYBOARD_LAYOUTS) {
      if (seen.has(def.id) || def.id === sourceId) continue
      seen.add(def.id)
      out.push({ id: def.id, name: def.name })
    }
    return out
  }, [keyLabels.metas, ctx?.layoutComparison.sourceLayoutId])

  const targetIdSet = useMemo(() => new Set(selectedTargetIds), [selectedTargetIds])

  const targetButtonLabel = useMemo(() => {
    if (selectedTargetIds.length === 0) return t('analyze.layoutComparison.noTargetOption')
    if (selectedTargetIds.length === 1) {
      const opt = layoutOptions.find((o) => o.id === selectedTargetIds[0])
      return opt?.name ?? selectedTargetIds[0]
    }
    const first = layoutOptions.find((o) => o.id === selectedTargetIds[0])?.name ?? selectedTargetIds[0]
    return `${first} +${selectedTargetIds.length - 1}`
  }, [selectedTargetIds, layoutOptions, t])

  const handleTargetClose = useCallback(() => setTargetPickerOpen(false), [])
  const handleAppClose = useCallback(() => setAppPickerOpen(false), [])

  const appDataSet = useMemo(() => new Set(appDataApps), [appDataApps])

  const appButtonLabel = useMemo(() => {
    if (appDataApps.length === 0) return t('analyze.export.appDataApps.none')
    if (appDataApps.length === appDataOptions.length) return t('analyze.export.appDataApps.all')
    if (appDataApps.length === 1) return appDataApps[0]
    const first = appDataApps[0]
    return `${first} +${appDataApps.length - 1}`
  }, [appDataApps, appDataOptions.length, t])

  const handleAppToggle = (name: string) => {
    setAppDataApps((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name],
    )
  }

  const handleAppSelectAll = () => setAppDataApps([...appDataOptions])
  const handleAppDeselectAll = () => setAppDataApps([])

  const [targetPopoverMaxH, setTargetPopoverMaxH] = useState(TARGET_POPOVER_MAX_H)
  useLayoutEffect(() => {
    if (!targetPickerOpen || !targetTriggerRef.current) return
    const update = () => {
      const rect = targetTriggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const available = rect.top - VIEWPORT_EDGE_GAP
      setTargetPopoverMaxH(Math.max(TARGET_POPOVER_MIN_H, Math.min(TARGET_POPOVER_MAX_H, available)))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [targetPickerOpen])

  useEffect(() => {
    if (!isOpen) return
    setSelected(allOn())
    setError(null)
    setTargetPickerOpen(false)
    setAppPickerOpen(false)
    const targetId = ctx?.layoutComparison.targetLayoutId
    setSelectedTargetIds(targetId ? [targetId] : [])
  }, [isOpen, ctx?.layoutComparison.targetLayoutId])

  useEffect(() => {
    if (!isOpen || mode !== 'upload' || !ctx) {
      setAppDataOptions([])
      setAppDataApps([])
      return
    }
    let cancelled = false
    const scope = scopeToSelectValue(ctx.deviceScope)
    window.vialAPI
      .typingAnalyticsListAppsForRange(ctx.uid, ctx.range.fromMs, ctx.range.toMs, scope)
      .then((rows) => {
        if (cancelled) return
        const names = rows
          .filter((r) => r.name !== TYPING_APP_UNKNOWN_NAME)
          .map((r) => r.name)
        setAppDataOptions(names)
        setAppDataApps(names)
      })
      .catch(() => {
        if (!cancelled) {
          setAppDataOptions([])
          setAppDataApps([])
        }
      })
    return () => { cancelled = true }
  }, [isOpen, mode, ctx?.uid, ctx?.range.fromMs, ctx?.range.toMs, ctx?.deviceScope])

  useEscapeClose(onClose, isOpen)

  const snapshotMissing = ctx?.snapshot === null

  const isCategoryAvailable = (c: Category): boolean => {
    if (!ctx) return false
    if (REQUIRES_SNAPSHOT[c] && snapshotMissing) return false
    if (c === 'layoutComparison') {
      if (mode === 'upload') return selectedTargetIds.length > 0
      return ctx.layoutComparison.targetLayoutId !== null
    }
    return true
  }

  const anySelected = CATEGORIES.some((c) => selected[c] && isCategoryAvailable(c))

  const handleToggle = (c: Category) => {
    if (!isCategoryAvailable(c)) return
    setSelected((prev) => ({ ...prev, [c]: !prev[c] }))
  }

  const handleTargetToggle = (id: string) => {
    setSelectedTargetIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const handleExport = async () => {
    if (!ctx || !anySelected || exporting) return
    setExporting(true)
    setError(null)
    try {
      const builders = pickBuilders(ctx, selected, t)
      const entries = await Promise.all(builders)
      const prefix = `${sanitizeKeyboardName(ctx.keyboardName)}_${ctx.machineHashOrAll}_${formatLocalCompact(ctx.range.fromMs)}_${formatLocalCompact(ctx.range.toMs)}`
      const files = entries.map((e) => ({ name: `${prefix}_${e.slug}`, content: e.content }))
      const result = await window.vialAPI.exportCsvBundle(files)
      if (!result.success && result.error !== 'cancelled') {
        setError(result.error ?? t('analyze.export.failed'))
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('analyze.export.failed'))
    } finally {
      setExporting(false)
    }
  }

  const handleUpload = async () => {
    if (!ctx || !upload || !anySelected || upload.isUploading) return
    setError(null)
    const picked = new Set<Category>()
    for (const c of CATEGORIES) {
      if (selected[c] && isCategoryAvailable(c)) {
        if (c === 'layoutComparison' && selectedTargetIds.length === 0) continue
        picked.add(c)
      }
    }
    try {
      const result = await upload.onConfirm(picked, { targetLayoutIds: selectedTargetIds, appDataApps })
      if (result.ok) onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('analyze.export.failed'))
    }
  }

  const isUploading = mode === 'upload' && (upload?.isUploading ?? false)
  const confirmLabel = mode === 'upload'
    ? (isUploading
        ? t(upload?.isExisting ? 'hub.updating' : 'hub.uploading')
        : t(upload?.isExisting ? 'hub.updateOnHub' : 'hub.uploadToHub'))
    : t('analyze.export.confirm')
  const confirmDisabled = mode === 'upload'
    ? !anySelected || isUploading || ctx === null
    : !anySelected || exporting || ctx === null
  const confirmHandler = mode === 'upload' ? handleUpload : handleExport

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="analyze-export-modal"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('analyze.export.categoriesLabel')}
        className="w-modal-notify max-w-modal-xl-vw flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-end px-3 pt-3 shrink-0">
          <ModalCloseButton testid="analyze-export-close" onClick={onClose} />
        </div>
        <div className="flex flex-col gap-3 px-5 pb-3">
          {ctx !== null && (
            <div
              className="flex flex-col gap-0.5 rounded-md border border-edge bg-surface px-3 py-2 text-xs text-content-secondary"
              data-testid="analyze-export-common"
            >
              <div><span className="text-content-muted">{t('analyze.export.conditionLabel.device')}: </span>{ctx.conditions.device}</div>
              {mode !== 'upload' && (
                <div><span className="text-content-muted">{t('analyze.export.conditionLabel.app')}: </span>{ctx.conditions.app}</div>
              )}
              {mode !== 'upload' && (
                <div><span className="text-content-muted">{t('analyze.export.conditionLabel.keymap')}: </span>{ctx.conditions.keymap}</div>
              )}
              <div><span className="text-content-muted">{t('analyze.export.conditionLabel.range')}: </span>{ctx.conditions.range}</div>
            </div>
          )}
          <div className="flex flex-col gap-2" role="group" aria-label={t('analyze.export.categoriesLabel')}>
            {CATEGORIES.map((c) => {
              const available = isCategoryAvailable(c)
              const active = available && selected[c]
              const specifics = ctx !== null ? specificsFor(c, ctx, t) : []
              const showTargetPicker = c === 'layoutComparison' && mode === 'upload'
              return (
                <div key={c} className={showTargetPicker ? categoryRowClass(active) : 'flex flex-col'}>
                  <button
                    type="button"
                    className={showTargetPicker ? 'text-left' : categoryRowClass(active)}
                    aria-pressed={active}
                    disabled={!available}
                    onClick={() => handleToggle(c)}
                    data-testid={`analyze-export-toggle-${c}`}
                  >
                    <span className="text-sm font-semibold">
                      {t(`analyze.export.category.${c}`)}
                    </span>
                    {specifics.length > 0 && !showTargetPicker && (
                      <span className="text-xs text-content-muted">
                        {specifics.map((s, i) => (
                          <span key={i} className={i === 0 ? '' : 'ml-3'}>{s}</span>
                        ))}
                      </span>
                    )}
                  </button>
                  {showTargetPicker && ctx !== null && (
                    <div className="mt-1 flex flex-col gap-1 text-xs">
                      <div className="text-content-muted">
                        {t('analyze.layoutComparison.sourceLabel')}: {LAYOUT_BY_ID.get(ctx.layoutComparison.sourceLayoutId)?.name ?? ctx.layoutComparison.sourceLayoutId}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-content-muted">{t('analyze.layoutComparison.targetLabel')}:</span>
                        <button
                          ref={targetTriggerRef}
                          type="button"
                          className="rounded border border-edge bg-surface px-2 py-0.5 text-left text-content-secondary transition-colors hover:bg-surface-dim"
                          onClick={() => setTargetPickerOpen((prev) => !prev)}
                          aria-haspopup="listbox"
                          aria-expanded={targetPickerOpen}
                        >
                          {targetButtonLabel}
                        </button>
                        <AnchoredPopover
                          anchorRef={targetTriggerRef}
                          open={targetPickerOpen}
                          onClose={handleTargetClose}
                          placement="top"
                          className="z-60 min-w-dropdown rounded-md border border-edge bg-surface p-1 text-xs shadow-lg"
                          role="listbox"
                          aria-multiselectable
                        >
                          {/* Exception: maxHeight is a runtime value computed from layout measurements; no static Tailwind class can express this. */}
                          <div className="overflow-y-auto" style={{ maxHeight: targetPopoverMaxH }}>
                            {layoutOptions.map((opt) => (
                              <label
                                key={opt.id}
                                className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-content transition-colors hover:bg-surface-dim"
                              >
                                <input
                                  type="checkbox"
                                  className="cursor-pointer"
                                  checked={targetIdSet.has(opt.id)}
                                  onChange={() => handleTargetToggle(opt.id)}
                                />
                                <span className="flex-1 truncate">{opt.name}</span>
                              </label>
                            ))}
                          </div>
                        </AnchoredPopover>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {mode === 'upload' && appDataOptions.length >= 2 && (
            <div className="flex flex-col gap-1 rounded-md border border-edge px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-sm font-semibold text-content">{t('analyze.export.appDataApps.label')}</span>
                <button
                  ref={appTriggerRef}
                  type="button"
                  className="rounded border border-edge bg-surface px-2 py-0.5 text-left text-xs text-content-secondary transition-colors hover:bg-surface-dim"
                  onClick={() => setAppPickerOpen((prev) => !prev)}
                  aria-haspopup="listbox"
                  aria-expanded={appPickerOpen}
                >
                  {appButtonLabel}
                </button>
                <AnchoredPopover
                  anchorRef={appTriggerRef}
                  open={appPickerOpen}
                  onClose={handleAppClose}
                  placement="top"
                  className="z-60 min-w-dropdown rounded-md border border-edge bg-surface p-1 text-xs shadow-lg"
                  role="listbox"
                  aria-multiselectable
                >
                  <div className="flex gap-1 px-2 py-1">
                    <button
                      type="button"
                      className="text-accent text-xs hover:underline"
                      onClick={handleAppSelectAll}
                    >
                      {t('analyze.export.appDataApps.selectAll')}
                    </button>
                    <span className="text-content-muted">/</span>
                    <button
                      type="button"
                      className="text-accent text-xs hover:underline"
                      onClick={handleAppDeselectAll}
                    >
                      {t('analyze.export.appDataApps.deselectAll')}
                    </button>
                  </div>
                  <div className="my-0.5 border-t border-edge" />
                  <div className="max-h-72 overflow-y-auto">
                    {appDataOptions.map((name) => (
                      <label
                        key={name}
                        className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-content transition-colors hover:bg-surface-dim"
                      >
                        <input
                          type="checkbox"
                          className="cursor-pointer"
                          checked={appDataSet.has(name)}
                          onChange={() => handleAppToggle(name)}
                        />
                        <span className="flex-1 truncate">{name}</span>
                      </label>
                    ))}
                  </div>
                </AnchoredPopover>
              </div>
              <p className="text-xs text-content-muted">{t('analyze.export.appDataApps.hint')}</p>
            </div>
          )}
          {snapshotMissing && (
            <p className="text-xs text-content-muted" data-testid="analyze-export-snapshot-warning">
              {t('analyze.export.snapshotMissing')}
            </p>
          )}
          {error !== null && (
            <p className="text-xs text-error" role="alert" data-testid="analyze-export-error">
              {error}
            </p>
          )}
          {mode === 'upload' && upload?.uploadResult && (
            <p
              className={`text-xs font-medium ${upload.uploadResult.kind === 'success' ? 'text-accent' : 'text-danger'}`}
              data-testid="analyze-export-upload-result"
              role={upload.uploadResult.kind === 'error' ? 'alert' : undefined}
            >
              {upload.uploadResult.message}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-edge bg-surface px-5 py-3">
          <button
            type="button"
            className={FILTER_BUTTON}
            onClick={() => { void confirmHandler() }}
            disabled={confirmDisabled}
            data-testid="analyze-export-confirm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
