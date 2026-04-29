// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTroubleshooting } from '../../hooks/useTroubleshooting'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { BTN_SECONDARY as SETTINGS_BTN_SECONDARY } from '../settings-modal/settings-modal-shared'
import { HubPostRow, DEFAULT_PER_PAGE } from '../hub-post-shared'
import { DataNavTree } from './DataNavTree'
import { DataNavBreadcrumb } from './DataNavBreadcrumb'
import { FavoriteTabContent } from './FavoriteTabContent'
import { KeyboardSavesContent } from './KeyboardSavesContent'
import { TypingAnalyticsContent } from './TypingAnalyticsContent'
import { useDataNavTree } from './useDataNavTree'
import type { FavoriteType } from '../../../shared/types/favorite-store'
import type { FavHubEntryResult } from '../editors/FavoriteHubActions'
import type { UseSyncReturn } from '../../hooks/useSync'
import type { HubMyPost, HubPaginationMeta, HubFetchMyPostsParams } from '../../../shared/types/hub'

interface Props {
  onClose: () => void
  sync: UseSyncReturn
  hubEnabled: boolean
  hubAuthenticated: boolean
  hubPosts: HubMyPost[]
  hubPostsPagination?: HubPaginationMeta
  onHubRefresh?: (params?: HubFetchMyPostsParams) => Promise<void>
  onHubRename: (postId: string, newTitle: string) => Promise<void>
  onHubDelete: (postId: string) => Promise<void>
  hubOrigin?: string
  hubNeedsDisplayName?: boolean
  hubFavUploading?: string | null
  hubFavUploadResult?: FavHubEntryResult | null
  onFavUploadToHub?: (type: FavoriteType, entryId: string) => void
  onFavUpdateOnHub?: (type: FavoriteType, entryId: string) => void
  onFavRemoveFromHub?: (type: FavoriteType, entryId: string) => void
  onFavRenameOnHub?: (entryId: string, hubPostId: string, newLabel: string) => void
  onResetStart?: () => void
  onResetEnd?: () => void
}

export function DataModal({
  onClose,
  sync,
  hubEnabled,
  hubAuthenticated,
  hubPosts,
  hubPostsPagination,
  onHubRefresh,
  onHubRename,
  onHubDelete,
  hubOrigin,
  hubNeedsDisplayName,
  hubFavUploading,
  hubFavUploadResult,
  onFavUploadToHub,
  onFavUpdateOnHub,
  onFavRemoveFromHub,
  onFavRenameOnHub,
  onResetStart,
  onResetEnd,
}: Props) {
  const { t } = useTranslation()
  const showHubTab = hubEnabled && hubAuthenticated
  const syncEnabled = sync.authStatus.authenticated && sync.hasPassword
  const nav = useDataNavTree({ showHubTab, syncEnabled })

  const troubleshoot = useTroubleshooting({
    sync,
    active: nav.activePath?.section === 'local',
    onResetStart,
    onResetEnd,
  })

  useEscapeClose(onClose, !troubleshoot.busy)

  // Reset to null if hub tab becomes hidden while active
  useEffect(() => {
    if (!showHubTab && nav.activePath?.page === 'hub-keyboard') {
      nav.setActivePath(null)
    }
  }, [showHubTab, nav.activePath?.page, nav.setActivePath])

  // Load local hubPostIds to filter hub posts not available locally
  const [localHubPostIds, setLocalHubPostIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (nav.storedKeyboards.length === 0) {
      setLocalHubPostIds(new Set())
      return
    }
    async function load() {
      const results = await Promise.allSettled(
        nav.storedKeyboards.map((kb) => window.vialAPI.snapshotStoreList(kb.uid)),
      )
      const ids = new Set<string>()
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.success && r.value.entries) {
          for (const entry of r.value.entries) {
            if (entry.hubPostId) ids.add(entry.hubPostId)
          }
        }
      }
      setLocalHubPostIds(ids)
    }
    void load()
  }, [nav.storedKeyboards])

  // Filter hub posts: exclude posts that exist locally (matched by hubPostId)
  const hubPostsFiltered = useMemo(() =>
    hubPosts.filter((p) => !localHubPostIds.has(p.id)),
  [hubPosts, localHubPostIds])

  const hubKeyboardNames = useMemo(() => {
    const names = new Set(hubPostsFiltered.map((p) => p.keyboard_name))
    return [...names].sort()
  }, [hubPostsFiltered])

  // Hub pagination
  const [hubPage, setHubPage] = useState(1)
  useEffect(() => {
    if (hubPostsPagination?.page != null) setHubPage(hubPostsPagination.page)
  }, [hubPostsPagination?.page])

  const refreshHubPage = useCallback(async (page: number) => {
    await onHubRefresh?.({ page, per_page: DEFAULT_PER_PAGE })
  }, [onHubRefresh])

  const handleHubPageChange = useCallback((newPage: number) => {
    setHubPage(newPage)
    void refreshHubPage(newPage)
  }, [refreshHubPage])

  const handleHubRenameWithPageRefresh = useCallback(async (postId: string, newTitle: string) => {
    await onHubRename(postId, newTitle)
    void refreshHubPage(hubPage)
  }, [onHubRename, hubPage, refreshHubPage])

  const handleHubDeleteWithPageAdjust = useCallback(async (postId: string) => {
    await onHubDelete(postId)
    if (hubPosts.length <= 1 && hubPage > 1) {
      handleHubPageChange(hubPage - 1)
    } else {
      void refreshHubPage(hubPage)
    }
  }, [onHubDelete, hubPosts.length, hubPage, handleHubPageChange, refreshHubPage])

  function renderContent(): React.ReactNode {
    const path = nav.activePath
    if (!path) return null

    if (path.page === 'favorite') {
      return (
        <FavoriteTabContent
          key={path.favoriteType}
          favoriteType={path.favoriteType}
          hubOrigin={hubOrigin}
          hubNeedsDisplayName={hubNeedsDisplayName}
          hubUploading={hubFavUploading}
          hubUploadResult={hubFavUploadResult}
          onUploadToHub={onFavUploadToHub ? (entryId) => onFavUploadToHub(path.favoriteType, entryId) : undefined}
          onUpdateOnHub={onFavUpdateOnHub ? (entryId) => onFavUpdateOnHub(path.favoriteType, entryId) : undefined}
          onRemoveFromHub={onFavRemoveFromHub ? (entryId) => onFavRemoveFromHub(path.favoriteType, entryId) : undefined}
          onRenameOnHub={onFavRenameOnHub}
        />
      )
    }

    if (path.page === 'application') {
      return (
        <LocalApplicationContent
          troubleshoot={troubleshoot}
          t={t}
        />
      )
    }

    if (path.page === 'keyboard') {
      return (
        <KeyboardSavesContent
          key={path.uid}
          source="local"
          uid={path.uid}
          name={path.name}
          hubOrigin={hubOrigin}
          onDeleted={() => { nav.setActivePath(null); void nav.refreshStoredKeyboards().catch(() => {}) }}
        />
      )
    }

    if (path.page === 'sync-keyboard') {
      return (
        <KeyboardSavesContent
          key={`sync-${path.uid}`}
          source="sync"
          uid={path.uid}
          name={path.name}
          sync={sync}
          onDeleted={() => { nav.setActivePath(null); void nav.handleSyncScan() }}
        />
      )
    }

    if (path.page === 'sync-favorite') {
      return (
        <div className="py-4 text-center text-[13px] text-content-muted">
          {t(`editor.${path.favoriteType}.title`)}
        </div>
      )
    }

    if (path.page === 'typing') {
      return (
        <TypingAnalyticsContent
          key={`typing-${path.uid}`}
          uid={path.uid}
          onDeleted={() => { void nav.refreshTypingKeyboards() }}
        />
      )
    }

    if (path.page === 'sync-typing-device') {
      return (
        <TypingAnalyticsContent
          key={`sync-typing-${path.uid}-${path.machineHash}`}
          uid={path.uid}
          mode="sync"
          machineHash={path.machineHash}
          onDeleted={() => { void nav.refreshTypingKeyboards() }}
        />
      )
    }

    if (path.page === 'hub-keyboard') {
      const filtered = hubPostsFiltered.filter((p) => p.keyboard_name === path.keyboardName)
      return renderHubContent(filtered)
    }

    return null
  }

  function renderHubContent(posts: typeof hubPosts): React.ReactNode {
    const hasPosts = posts.length > 0

    return (
      <div className="space-y-4">
        {!hasPosts ? (
          <p className="text-sm text-content-muted" data-testid="hub-no-posts">
            {t('hub.noPosts')}
          </p>
        ) : (
          <div data-testid="hub-post-list">
            <div className="space-y-1">
              {posts.map((post) => (
                <HubPostRow key={post.id} post={post} onRename={handleHubRenameWithPageRefresh} onDelete={handleHubDeleteWithPageAdjust} hubOrigin={hubOrigin} />
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="data-modal-backdrop"
      onClick={troubleshoot.busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-modal-title"
        className="w-[860px] max-w-[95vw] h-[min(720px,80vh)] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="data-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2 shrink-0">
          <h2 id="data-modal-title" className="text-lg font-bold text-content">{t('dataModal.title')}</h2>
          {!troubleshoot.busy && <ModalCloseButton testid="data-modal-close" onClick={onClose} />}
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <div className="w-[220px] shrink-0 border-r border-edge overflow-y-auto">
            <DataNavTree
              storedKeyboards={nav.storedKeyboards}
              typingKeyboards={nav.typingKeyboards}
              hasRemoteTyping={nav.hasRemoteTyping}
              activePath={nav.activePath}
              onNavigate={nav.setActivePath}
              isExpanded={nav.isExpanded}
              onToggle={nav.toggleExpand}
              showHubTab={showHubTab}
              hubKeyboardNames={hubKeyboardNames}
              syncScanResult={nav.syncScanResult}
              syncScanning={nav.syncScanning}
              onSyncKeyboardSelect={nav.onSyncKeyboardSelect}
              downloadingUid={nav.downloadingUid}
              downloadErrorByUid={nav.downloadErrorByUid}
              remoteTypingHashes={nav.remoteTypingHashes}
              ensureRemoteTypingHashes={nav.ensureRemoteTypingHashes}
            />
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {nav.activePath && (
              <div className="px-5 pt-3 pb-2 shrink-0">
                <DataNavBreadcrumb path={nav.activePath} />
              </div>
            )}
            <div className="flex-1 overflow-y-auto px-5 pb-5">
              {renderContent()}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Inline component for Local > Application content */
function LocalApplicationContent({
  troubleshoot,
  t,
}: {
  troubleshoot: ReturnType<typeof useTroubleshooting>
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  return (
    <div className="space-y-6" data-testid="local-tab-content">
      <section>
        <p className="text-sm text-content-secondary mb-3">{t('dataModal.importExportDesc')}</p>
        <div className="flex items-center justify-between mb-3">
          {troubleshoot.importResult ? (
            <span
              className={`text-sm ${troubleshoot.importResult === 'success' ? 'text-accent' : 'text-danger'}`}
              data-testid="local-data-import-result"
            >
              {troubleshoot.importResult === 'success' ? t('sync.importComplete') : t('sync.importFailed')}
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={SETTINGS_BTN_SECONDARY}
              onClick={troubleshoot.handleImport}
              disabled={troubleshoot.busy}
              data-testid="local-data-import"
            >
              {t('sync.import')}
            </button>
            <button
              type="button"
              className={SETTINGS_BTN_SECONDARY}
              onClick={troubleshoot.handleExport}
              disabled={troubleshoot.busy}
              data-testid="local-data-export"
            >
              {t('sync.export')}
            </button>
          </div>
        </div>
        <AppSettingsReset troubleshoot={troubleshoot} t={t} />
      </section>
    </div>
  )
}

const BTN_DANGER_OUTLINE = 'rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50'

/** Simple application settings reset with confirm */
function AppSettingsReset({
  troubleshoot,
  t,
}: {
  troubleshoot: ReturnType<typeof useTroubleshooting>
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const [confirming, setConfirming] = useState(false)

  async function handleReset(): Promise<void> {
    await window.vialAPI.resetLocalTargets({ keyboards: false, favorites: false, appSettings: true })
    setConfirming(false)
  }

  return (
    <div className="flex items-center justify-between" data-testid="app-settings-reset">
      <span className="text-sm text-content-secondary">{t('dataModal.resetAppSettings')}</span>
      {confirming ? (
        <div className="flex items-center gap-2">
          <button type="button" className={BTN_DANGER_OUTLINE} onClick={() => void handleReset()} disabled={troubleshoot.busy} data-testid="app-reset-confirm">
            {t('common.confirmReset')}
          </button>
          <button type="button" className={SETTINGS_BTN_SECONDARY} onClick={() => setConfirming(false)} data-testid="app-reset-cancel">
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button type="button" className={BTN_DANGER_OUTLINE} onClick={() => setConfirming(true)} disabled={troubleshoot.busy} data-testid="app-reset-btn">
          {t('common.reset')}
        </button>
      )}
    </div>
  )
}
