// SPDX-License-Identifier: GPL-2.0-or-later
//
// Settings → Tools → Theme Packs modal. Mirrors LanguagePacksModal:
//   - Built-in themes (System, Light, Dark) as a horizontal selector bar
//   - Imported theme packs listed below with Select / Rename / Export / Delete
//   - Import button in the Installed tab toolbar

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trans, useTranslation } from 'react-i18next'
import { Circle, CheckCircle2, Monitor, Sun, Moon } from 'lucide-react'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useAppConfig } from '../../hooks/useAppConfig'
import { useInlineRename } from '../../hooks/useInlineRename'
import { useThemePackStore } from '../../hooks/useThemePackStore'
import { applyPackColors, clearPackColors, isPackTheme, extractPackId } from '../../hooks/useTheme'
import type { ThemeColorScheme, ThemePackColors } from '../../../shared/types/theme-store'
import type { HubThemePostListItem, HubThemePackBody } from '../../../shared/types/hub'
import { buildHubCategoryUrl, HUB_CATEGORY } from '../../../shared/hub-urls'
import { useHubFreshness } from '../../hooks/useHubFreshness'
import type { ThemeMode, ThemeSelection } from '../../../shared/types/app-config'
import { PackRow } from './ThemePackRow'

type TabId = 'installed' | 'hub'

export interface ThemePacksModalProps {
  open: boolean
  onClose: () => void
  onThemeChange: (mode: ThemeSelection) => void
  hubCanWrite?: boolean
}

const BUILTIN_THEMES: { mode: ThemeMode; icon: typeof Monitor }[] = [
  { mode: 'system', icon: Monitor },
  { mode: 'light', icon: Sun },
  { mode: 'dark', icon: Moon },
]

export function ThemePacksModal({
  open,
  onClose,
  onThemeChange,
  hubCanWrite = false,
}: ThemePacksModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const store = useThemePackStore()
  const rename = useInlineRename<string>()
  const appConfig = useAppConfig()

  const [activeTab, setActiveTab] = useState<TabId>('installed')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{ id: string; kind: 'success' | 'error'; message: string } | null>(null)
  const [search, setSearch] = useState('')
  const [hubResults, setHubResults] = useState<HubThemePostListItem[]>([])
  const [hubSearched, setHubSearched] = useState(false)
  const [hubSearching, setHubSearching] = useState(false)
  const [hubOrigin, setHubOrigin] = useState('')
  const [previewPostId, setPreviewPostId] = useState<string | null>(null)
  const previewSeqRef = useRef(0)
  const hubPreviewCacheRef = useRef(new Map<string, HubThemePackBody>())
  const activePackCacheRef = useRef<{ id: string; colors: ThemePackColors; colorScheme: ThemeColorScheme } | null>(null)

  const activeTheme = appConfig.config.theme

  useEffect(() => {
    if (!open) return
    void window.vialAPI.hubGetOrigin().then((origin) => { if (origin) setHubOrigin(origin) }).catch(() => null)
  }, [open])

  const installedHubPostIds = useMemo(
    () => new Set(store.metas.filter((m) => !m.deletedAt && m.hubPostId).map((m) => m.hubPostId as string)),
    [store.metas],
  )

  const freshnessCandidates = useMemo(
    () => store.metas
      .filter((m) => !m.deletedAt && !!m.hubPostId)
      .map((m) => ({ localId: m.id, hubPostId: m.hubPostId as string })),
    [store.metas],
  )

  const fetchTimestamps = useCallback(
    (ids: string[]) => window.vialAPI.themePackHubTimestamps(ids),
    [],
  )

  const hubFreshness = useHubFreshness({
    enabled: open && activeTab === 'installed',
    candidates: freshnessCandidates,
    fetchTimestamps,
  })

  const hubRows = useMemo(() => hubResults.map((item) => ({
    hubPostId: item.id,
    name: item.name,
    version: item.version,
    uploaderName: item.uploaderName ?? '',
    alreadyInstalled: installedHubPostIds.has(item.id),
  })), [hubResults, installedHubPostIds])

  const runSearch = useCallback(async (query: string): Promise<void> => {
    setHubSearching(true)
    setActionError(null)
    try {
      const result = await window.vialAPI.hubListThemePosts({ q: query })
      if (result.success && result.data) {
        setHubResults(result.data.items)
        setHubSearched(true)
      } else {
        setActionError(result.error ?? t('themePacks.hubEmpty'))
      }
    } finally {
      setHubSearching(false)
    }
  }, [t])

  useEffect(() => {
    if (!open || activeTab !== 'hub') return
    const query = search.trim()
    if (query.length < 2) {
      setHubResults((prev) => (prev.length === 0 ? prev : []))
      setHubSearched((prev) => (prev ? false : prev))
      return
    }
    const handle = window.setTimeout(() => { void runSearch(query) }, 300)
    return () => { window.clearTimeout(handle) }
  }, [open, activeTab, search, runSearch])

  const restoreActiveTheme = useCallback(() => {
    clearPackColors()
    if (isPackTheme(activeTheme)) {
      const packId = extractPackId(activeTheme)
      const cached = activePackCacheRef.current
      if (cached && cached.id === packId) {
        applyPackColors(cached.colors, cached.colorScheme)
      } else {
        void window.vialAPI.themePackGet(packId).then((result) => {
          if (result.success && result.data) {
            activePackCacheRef.current = { id: packId, colors: result.data.pack.colors, colorScheme: result.data.pack.colorScheme }
            applyPackColors(result.data.pack.colors, result.data.pack.colorScheme)
          }
        })
      }
    }
    setPreviewPostId(null)
  }, [activeTheme])

  const handlePreview = useCallback(async (postId: string): Promise<void> => {
    if (previewPostId === postId) {
      restoreActiveTheme()
      return
    }
    const cached = hubPreviewCacheRef.current.get(postId)
    if (cached) {
      applyPackColors(cached.colors as ThemePackColors, cached.colorScheme)
      setPreviewPostId(postId)
      return
    }
    const seq = ++previewSeqRef.current
    setPendingId(postId)
    try {
      const result = await window.vialAPI.hubDownloadThemePost(postId)
      if (!result.success || !result.data || previewSeqRef.current !== seq) return
      hubPreviewCacheRef.current.set(postId, result.data)
      applyPackColors(result.data.colors as ThemePackColors, result.data.colorScheme)
      setPreviewPostId(postId)
    } finally {
      if (previewSeqRef.current === seq) setPendingId(null)
    }
  }, [previewPostId, restoreActiveTheme])

  useEffect(() => {
    if (!open) {
      if (previewPostId) restoreActiveTheme()
      setActionError(null)
      setLastResult(null)
      setConfirmDeleteId(null)
      setConfirmRemoveId(null)
      hubPreviewCacheRef.current.clear()
      activePackCacheRef.current = null
    }
  }, [open, previewPostId, restoreActiveTheme])

  useEffect(() => {
    activePackCacheRef.current = null
  }, [activeTheme])

  const pushPackToHub = useCallback(async (
    packId: string,
    hubPostId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    const get = await window.vialAPI.themePackGet(packId)
    if (!get.success || !get.data) {
      return { success: false, error: get.error ?? t('themePacks.parseError') }
    }
    const res = await window.vialAPI.hubUpdateThemePost({
      postId: hubPostId,
      entryId: packId,
      pack: get.data.pack as HubThemePackBody,
    })
    if (res.success) {
      await store.refresh()
      return { success: true }
    }
    return { success: false, error: res.error ?? t('hub.updateFailed') }
  }, [store, t])

  const handleTabInstalled = useCallback(() => {
    if (previewPostId) restoreActiveTheme()
    setActiveTab('installed')
  }, [previewPostId, restoreActiveTheme])

  const handleSelectTheme = useCallback((selection: ThemeSelection) => {
    if (selection === activeTheme) return
    setActionError(null)
    onThemeChange(selection)
  }, [activeTheme, onThemeChange])

  const handleExport = useCallback(async (id: string) => {
    setActionError(null)
    setPendingId(id)
    try {
      const result = await store.exportPack(id)
      if (!result.success && result.error) setActionError(result.error)
    } finally {
      setPendingId(null)
    }
  }, [store])

  const handleDelete = useCallback(async (id: string) => {
    setActionError(null)
    setLastResult(null)
    setPendingId(id)
    try {
      const meta = store.metas.find((m) => m.id === id)
      if (meta?.hubPostId) {
        await window.vialAPI.hubDeleteThemePost(meta.hubPostId, id).catch(() => null)
      }
      const result = await store.remove(id)
      if (!result.success && result.error) setActionError(result.error)
      if (result.success && isPackTheme(activeTheme) && extractPackId(activeTheme) === id) {
        onThemeChange('system')
      }
    } finally {
      setPendingId(null)
      setConfirmDeleteId(null)
    }
  }, [store, activeTheme, onThemeChange])

  const handleImportFile = useCallback(async () => {
    setActionError(null)
    setLastResult(null)
    try {
      const dialogResult = await store.importFromDialog()
      if (dialogResult.canceled) return
      if (dialogResult.parseError) {
        setActionError(dialogResult.parseError)
        return
      }
      if (!dialogResult.raw) return
      const result = await store.applyImport(dialogResult.raw)
      if (!result.success || !result.meta) {
        if (result.error) setActionError(result.error)
        return
      }
      setLastResult({ id: result.meta.id, kind: 'success', message: t('common.saved') })
      if (result.meta.hubPostId) {
        const upd = await pushPackToHub(result.meta.id, result.meta.hubPostId)
        if (upd.success) {
          setLastResult({ id: result.meta.id, kind: 'success', message: t('common.synced') })
        } else {
          setActionError(upd.error ?? t('hub.updateFailed'))
        }
      }
    } catch {
      setActionError(t('themePacks.parseError'))
    }
  }, [store, t, pushPackToHub])

  const handleRenameCommit = useCallback(async (id: string) => {
    const newName = rename.commitRename(id)
    if (!newName) return
    setActionError(null)
    setPendingId(id)
    try {
      const result = await store.rename(id, newName)
      if (!result.success && result.error) {
        setActionError(result.error)
        return
      }
      const meta = store.metas.find((m) => m.id === id)
      if (meta?.hubPostId) {
        const upd = await pushPackToHub(id, meta.hubPostId)
        if (upd.success) {
          setLastResult({ id, kind: 'success', message: t('common.synced') })
        } else {
          setActionError(upd.error ?? t('hub.updateFailed'))
        }
      }
    } finally {
      setPendingId(null)
    }
  }, [rename, store, t, pushPackToHub])

  const handleUpload = useCallback(async (id: string): Promise<void> => {
    setPendingId(id)
    setActionError(null)
    setLastResult(null)
    try {
      const get = await window.vialAPI.themePackGet(id)
      if (!get.success || !get.data) {
        setLastResult({ id, kind: 'error', message: get.error ?? t('themePacks.parseError') })
        return
      }
      const result = await window.vialAPI.hubUploadThemePost({
        entryId: id,
        pack: get.data.pack as HubThemePackBody,
      })
      if (result.success) {
        setLastResult({ id, kind: 'success', message: t('hub.uploadSuccess') })
        await store.refresh()
      } else {
        setLastResult({ id, kind: 'error', message: result.error ?? t('hub.uploadFailed') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store, t])

  const handleUpdate = useCallback(async (id: string): Promise<void> => {
    const meta = store.metas.find((m) => m.id === id)
    if (!meta?.hubPostId) return
    setPendingId(id)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await pushPackToHub(id, meta.hubPostId)
      if (result.success) {
        setLastResult({ id, kind: 'success', message: t('hub.updateSuccess') })
      } else {
        setLastResult({ id, kind: 'error', message: result.error ?? t('hub.updateFailed') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store.metas, pushPackToHub, t])

  const handleSync = useCallback(async (id: string): Promise<void> => {
    const meta = store.metas.find((m) => m.id === id)
    if (!meta?.hubPostId) return
    setPendingId(id)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await window.vialAPI.hubDownloadThemePost(meta.hubPostId)
      if (!result.success || !result.data) {
        setLastResult({ id, kind: 'error', message: result.error ?? t('themePacks.parseError') })
        return
      }
      const apply = await store.applyImport(result.data, { id, hubPostId: meta.hubPostId })
      if (apply.success) {
        setLastResult({ id, kind: 'success', message: t('common.synced') })
        await store.refresh()
      } else {
        setLastResult({ id, kind: 'error', message: apply.error ?? t('themePacks.parseError') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store, t])

  const handleRemove = useCallback(async (id: string): Promise<void> => {
    const meta = store.metas.find((m) => m.id === id)
    if (!meta?.hubPostId) return
    setPendingId(id)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await window.vialAPI.hubDeleteThemePost(meta.hubPostId, id)
      if (result.success) {
        setLastResult({ id, kind: 'success', message: t('hub.removeSuccess') })
        await store.refresh()
      } else {
        setLastResult({ id, kind: 'error', message: result.error ?? t('hub.removeFailed') })
      }
    } finally {
      setPendingId(null)
      setConfirmRemoveId(null)
    }
  }, [store, t])

  const handleHubDownload = useCallback(async (postId: string): Promise<void> => {
    setPendingId(postId)
    setActionError(null)
    try {
      const result = await window.vialAPI.hubDownloadThemePost(postId)
      if (!result.success || !result.data) {
        setActionError(result.error ?? t('themePacks.hubEmpty'))
        return
      }
      await store.applyImport(result.data, { hubPostId: postId })
    } finally {
      setPendingId(null)
    }
  }, [store, t])

  const handleRenameKey = (event: React.KeyboardEvent<HTMLInputElement>, id: string): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleRenameCommit(id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      rename.cancelRename()
    }
  }

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="theme-packs-backdrop"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl h-[80vh] flex flex-col rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="theme-packs-modal"
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-base font-semibold text-content">{t('themePacks.title')}</h2>
          <ModalCloseButton testid="theme-packs-close" onClick={onClose} />
        </div>

        <div className="flex border-b border-edge" data-testid="theme-packs-tabs">
          <TabButton id="installed" label={t('common.installed')} active={activeTab === 'installed'} onClick={handleTabInstalled} />
          <TabButton id="hub" label={t('common.findOnHub')} active={activeTab === 'hub'} onClick={() => setActiveTab('hub')} />
        </div>

        {activeTab === 'hub' && (
          <div className="flex items-center gap-2 px-4 py-3 border-b border-edge">
            <input
              type="text"
              value={search}
              placeholder={t('common.searchPlaceholder')}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(search) }}
              className="flex-1 rounded border border-edge bg-surface px-3 py-1.5 text-sm text-content focus:border-accent focus:outline-none"
              data-testid="theme-packs-search-input"
            />
            <button
              type="button"
              disabled={hubSearching || search.trim().length < 2}
              onClick={() => void runSearch(search.trim())}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              data-testid="theme-packs-search-button"
            >
              {hubSearching ? t('keyLabels.searching') : t('i18n.search')}
            </button>
          </div>
        )}

        {activeTab === 'installed' && (
          <div className="flex items-center justify-end px-4 py-3 border-b border-edge">
            <button
              type="button"
              onClick={() => void handleImportFile()}
              className="rounded border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-hover"
              data-testid="theme-packs-import-button"
            >
              {t('i18n.import')}
            </button>
          </div>
        )}

        {actionError && (
          <div className="mx-4 my-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700" data-testid="theme-packs-error">
            {actionError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {activeTab === 'installed' ? (
            <div className="space-y-2">
              <div className="flex rounded border border-edge bg-surface p-1 gap-0.5">
                {BUILTIN_THEMES.map(({ mode, icon: Icon }) => {
                  const isActive = activeTheme === mode
                  return (
                    <button
                      key={mode}
                      type="button"
                      aria-label={t('themePacks.selectTheme', { name: t(`theme.${mode}`) })}
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-accent/15 text-accent'
                          : 'text-content-secondary hover:text-content'
                      }`}
                      onClick={() => handleSelectTheme(mode)}
                      data-testid={`theme-packs-builtin-${mode}`}
                    >
                      {isActive ? (
                        <CheckCircle2 size={16} className="text-accent" aria-hidden="true" />
                      ) : (
                        <Circle size={16} aria-hidden="true" />
                      )}
                      <Icon size={16} aria-hidden="true" />
                      {t(`theme.${mode}`)}
                    </button>
                  )
                })}
              </div>

              {store.metas.map((meta) => (
                <PackRow
                  key={meta.id}
                  meta={meta}
                  isActive={activeTheme === `pack:${meta.id}`}
                  pendingId={pendingId}
                  confirmDeleteId={confirmDeleteId}
                  setConfirmDeleteId={setConfirmDeleteId}
                  rename={rename}
                  onRenameKey={handleRenameKey}
                  onRenameCommit={handleRenameCommit}
                  onSelect={handleSelectTheme}
                  onExport={handleExport}
                  onDelete={handleDelete}
                  hubOrigin={hubOrigin}
                  hubCanWrite={hubCanWrite}
                  hubFreshness={hubFreshness}
                  lastResult={lastResult}
                  confirmRemoveId={confirmRemoveId}
                  setConfirmRemoveId={setConfirmRemoveId}
                  onUpload={handleUpload}
                  onUpdate={handleUpdate}
                  onSync={handleSync}
                  onRemove={handleRemove}
                />
              ))}
            </div>
          ) : (
            <HubTable
              rows={hubRows}
              hubSearched={hubSearched}
              pendingId={pendingId}
              hubOrigin={hubOrigin}
              previewPostId={previewPostId}
              onPreview={(postId) => void handlePreview(postId)}
              onDownload={(postId) => void handleHubDownload(postId)}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ */

interface TabButtonProps {
  id: TabId
  label: string
  active: boolean
  onClick: () => void
}

function TabButton({ id, label, active, onClick }: TabButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
        active ? 'border-b-2 border-accent text-accent' : 'text-content-secondary hover:text-content'
      }`}
      data-testid={`theme-packs-tab-${id}`}
      aria-pressed={active}
    >
      {label}
    </button>
  )
}

/* ------------------------------------------------------------------ */

interface HubRow {
  hubPostId: string
  name: string
  version: string
  uploaderName: string
  alreadyInstalled: boolean
}

interface HubTableProps {
  rows: HubRow[]
  hubSearched: boolean
  pendingId: string | null
  hubOrigin: string
  previewPostId: string | null
  onPreview: (postId: string) => void
  onDownload: (postId: string) => void
}

function HubTable({ rows, hubSearched, pendingId, hubOrigin, previewPostId, onPreview, onDownload }: HubTableProps): JSX.Element {
  const { t } = useTranslation()
  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-content-muted" data-testid="theme-packs-hub-empty">
        {hubSearched ? (
          t('themePacks.hubEmpty')
        ) : (
          <Trans
            i18nKey="common.findOnHubHint"
            components={{
              hub: hubOrigin ? (
                <a
                  href={buildHubCategoryUrl(hubOrigin, HUB_CATEGORY.THEME_PACKS)}
                  onClick={(e) => {
                    e.preventDefault()
                    void window.vialAPI.openExternal(buildHubCategoryUrl(hubOrigin, HUB_CATEGORY.THEME_PACKS))
                  }}
                  className="text-accent hover:underline"
                  data-testid="theme-packs-hub-initial-link"
                />
              ) : (
                <span />
              ),
            }}
          />
        )}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div
          key={row.hubPostId}
          className="flex items-center gap-3 rounded border border-edge bg-surface px-3 py-2"
          data-testid={`theme-packs-hub-row-${row.hubPostId}`}
        >
          <div className="flex-1 min-w-0">
            <div className="truncate text-sm font-medium text-content">{row.name}</div>
            <div className="text-xs text-content-muted">
              v{row.version}{row.uploaderName ? ` · ${row.uploaderName}` : ''}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className={`text-xs font-medium hover:underline disabled:opacity-50 ${
                previewPostId === row.hubPostId ? 'text-success' : 'text-content-secondary'
              }`}
              onClick={() => onPreview(row.hubPostId)}
              disabled={pendingId === row.hubPostId}
              data-testid={`theme-packs-hub-preview-${row.hubPostId}`}
            >
              {previewPostId === row.hubPostId ? t('themePacks.previewing') : t('themePacks.preview')}
            </button>
            {row.alreadyInstalled ? (
              <span className="text-xs text-content-muted">{t('common.installed')}</span>
            ) : (
              <button
                type="button"
                className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
                onClick={() => onDownload(row.hubPostId)}
                disabled={pendingId === row.hubPostId}
                data-testid={`theme-packs-hub-download-${row.hubPostId}`}
              >
                {t('keyLabels.actionDownload')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
