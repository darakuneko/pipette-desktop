// SPDX-License-Identifier: GPL-2.0-or-later
//
// Settings → Tools → Theme Packs modal. Mirrors LanguagePacksModal:
//   - Built-in themes (System, Light, Dark) as a horizontal selector bar
//   - Imported theme packs listed below with Select / Rename / Export / Delete
//   - Import button in the Installed tab toolbar

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trans, useTranslation } from 'react-i18next'
import { Circle, CheckCircle2, Monitor, Sun, Moon } from 'lucide-react'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useAppConfig } from '../../hooks/useAppConfig'
import { useInlineRename } from '../../hooks/useInlineRename'
import { useThemePackStore } from '../../hooks/useThemePackStore'
import type { HubThemePostListItem } from '../../../shared/types/hub'
import { buildHubCategoryUrl, HUB_CATEGORY } from '../../../shared/hub-urls'
import type { ThemeMode, ThemeSelection } from '../../../shared/types/app-config'
import { PackRow } from './ThemePackRow'

type TabId = 'installed' | 'hub'

export interface ThemePacksModalProps {
  open: boolean
  onClose: () => void
  onThemeChange: (mode: ThemeSelection) => void
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
}: ThemePacksModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const store = useThemePackStore()
  const rename = useInlineRename<string>()
  const appConfig = useAppConfig()

  const [activeTab, setActiveTab] = useState<TabId>('installed')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [hubResults, setHubResults] = useState<HubThemePostListItem[]>([])
  const [hubSearched, setHubSearched] = useState(false)
  const [hubSearching, setHubSearching] = useState(false)
  const [hubOrigin, setHubOrigin] = useState('')

  const activeTheme = appConfig.config.theme

  useEffect(() => {
    if (!open) return
    void window.vialAPI.hubGetOrigin().then((origin) => { if (origin) setHubOrigin(origin) }).catch(() => null)
  }, [open])

  const installedHubPostIds = useMemo(
    () => new Set(store.metas.filter((m) => !m.deletedAt && m.hubPostId).map((m) => m.hubPostId as string)),
    [store.metas],
  )

  const hubRows = useMemo(() => hubResults.map((item) => ({
    hubPostId: item.id,
    name: item.name,
    version: item.version,
    baseTheme: item.baseTheme,
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

  useEffect(() => {
    if (!open) {
      setActionError(null)
      setConfirmDeleteId(null)
    }
  }, [open])

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
    setPendingId(id)
    try {
      const result = await store.remove(id)
      if (!result.success && result.error) setActionError(result.error)
    } finally {
      setPendingId(null)
      setConfirmDeleteId(null)
    }
  }, [store])

  const handleImportFile = useCallback(async () => {
    setActionError(null)
    try {
      const dialogResult = await store.importFromDialog()
      if (dialogResult.canceled) return
      if (dialogResult.parseError) {
        setActionError(dialogResult.parseError)
        return
      }
      if (!dialogResult.raw) return
      const result = await store.applyImport(dialogResult.raw)
      if (!result.success && result.error) setActionError(result.error)
    } catch {
      setActionError(t('themePacks.parseError'))
    }
  }, [store, t])

  const handleRenameCommit = useCallback(async (id: string) => {
    const newName = rename.commitRename(id)
    if (!newName) return
    setActionError(null)
    const result = await store.rename(id, newName)
    if (!result.success && result.error) setActionError(result.error)
  }, [rename, store])

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
          <TabButton id="installed" label={t('common.installed')} active={activeTab === 'installed'} onClick={() => setActiveTab('installed')} />
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
              {t('themePacks.importButton')}
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
                />
              ))}
            </div>
          ) : (
            <HubTable
              rows={hubRows}
              hubSearched={hubSearched}
              pendingId={pendingId}
              hubOrigin={hubOrigin}
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
  baseTheme: string
  uploaderName: string
  alreadyInstalled: boolean
}

interface HubTableProps {
  rows: HubRow[]
  hubSearched: boolean
  pendingId: string | null
  hubOrigin: string
  onDownload: (postId: string) => void
}

function HubTable({ rows, hubSearched, pendingId, hubOrigin, onDownload }: HubTableProps): JSX.Element {
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
              {' · '}
              <span className="rounded bg-surface-dim px-1 py-0.5 text-[11px]">
                {row.baseTheme === 'dark' ? t('themePacks.baseThemeDark') : t('themePacks.baseThemeLight')}
              </span>
            </div>
          </div>
          <div className="shrink-0">
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
