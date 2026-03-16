// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { HUB_BTN, SHARE_LINK_BTN } from './layout-store-types'
import type { HubEntryResult } from './layout-store-types'
import { ACTION_BTN, CONFIRM_DELETE_BTN } from './store-modal-shared'
import type { SnapshotMeta } from '../../../shared/types/snapshot-store'
import type { HubMyPost } from '../../../shared/types/hub'

interface HubOrphanButtonsProps {
  entry: SnapshotMeta
  keyboardName: string
  hubMyPosts?: HubMyPost[]
  hubUploading?: string | null
  fileDisabled?: boolean
  onUploadToHub?: (entryId: string) => void
  onReuploadToHub?: (entryId: string, orphanedPostId: string) => void
  onDeleteOrphanedHubPost?: (entryId: string, orphanedPostId: string) => void
}

export function HubOrphanButtons({
  entry,
  keyboardName,
  hubMyPosts,
  hubUploading,
  fileDisabled,
  onUploadToHub,
  onReuploadToHub,
  onDeleteOrphanedHubPost,
}: HubOrphanButtonsProps) {
  const { t } = useTranslation()
  const orphanPost = hubMyPosts?.find((p) => p.title === entry.label && p.keyboard_name === keyboardName)
  const disabled = !!hubUploading || fileDisabled

  if (orphanPost) {
    return (
      <>
        {onReuploadToHub && (
          <button
            type="button"
            className={HUB_BTN}
            onClick={() => onReuploadToHub(entry.id, orphanPost.id)}
            disabled={disabled}
            data-testid="layout-store-reupload-hub"
          >
            {hubUploading === entry.id ? t('hub.uploading') : t('hub.uploadQuestion')}
          </button>
        )}
        {onDeleteOrphanedHubPost && (
          <button
            type="button"
            className={HUB_BTN}
            onClick={() => onDeleteOrphanedHubPost(entry.id, orphanPost.id)}
            disabled={disabled}
            data-testid="layout-store-delete-orphan-hub"
          >
            {t('hub.deleteFromHub')}
          </button>
        )}
      </>
    )
  }

  if (!onUploadToHub) return null

  return (
    <button
      type="button"
      className={HUB_BTN}
      onClick={() => onUploadToHub(entry.id)}
      disabled={disabled}
      data-testid="layout-store-upload-hub"
    >
      {hubUploading === entry.id ? t('hub.uploading') : t('hub.uploadToHub')}
    </button>
  )
}

export function ShareLink({ url }: { url: string }) {
  const { t } = useTranslation()

  function handleClick(e: React.MouseEvent): void {
    e.preventDefault()
    window.vialAPI.openExternal(url).catch(() => {})
  }

  return (
    <a
      href={url}
      onClick={handleClick}
      className={SHARE_LINK_BTN}
      data-testid="layout-store-hub-share-link"
    >
      {t('hub.openInBrowser')}
    </a>
  )
}

interface LayoutStoreHubRowProps {
  entry: SnapshotMeta
  entryHubPostId: string | undefined
  keyboardName: string
  hubOrigin?: string
  hubMyPosts?: HubMyPost[]
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: HubEntryResult | null
  fileDisabled?: boolean
  confirmHubRemoveId: string | null
  setConfirmHubRemoveId: (id: string | null) => void
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
  onReuploadToHub?: (entryId: string, orphanedPostId: string) => void
  onDeleteOrphanedHubPost?: (entryId: string, orphanedPostId: string) => void
}

export function LayoutStoreHubRow({
  entry,
  entryHubPostId,
  keyboardName,
  hubOrigin,
  hubMyPosts,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  fileDisabled,
  confirmHubRemoveId,
  setConfirmHubRemoveId,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
  onReuploadToHub,
  onDeleteOrphanedHubPost,
}: LayoutStoreHubRowProps) {
  const { t } = useTranslation()

  return (
    <div className="mt-1.5 border-t border-edge pt-1.5" data-testid="layout-store-hub-row">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-accent">{t('hub.pipetteHub')}</span>
        <div className="flex gap-1">
          {entryHubPostId && hubOrigin && (
            <ShareLink url={`${hubOrigin}/post/${encodeURIComponent(entryHubPostId)}`} />
          )}
          {entryHubPostId && confirmHubRemoveId === entry.id && (
            <>
              <button
                type="button"
                className={CONFIRM_DELETE_BTN}
                onClick={() => { onRemoveFromHub?.(entry.id); setConfirmHubRemoveId(null) }}
                data-testid="layout-store-hub-remove-confirm"
              >
                {t('hub.confirmRemove')}
              </button>
              <button
                type="button"
                className={ACTION_BTN}
                onClick={() => setConfirmHubRemoveId(null)}
                data-testid="layout-store-hub-remove-cancel"
              >
                {t('common.cancel')}
              </button>
            </>
          )}
          {entryHubPostId && confirmHubRemoveId !== entry.id && (
            <>
              {onUpdateOnHub && (
                <button
                  type="button"
                  className={HUB_BTN}
                  onClick={() => onUpdateOnHub(entry.id)}
                  disabled={!!hubUploading || fileDisabled}
                  data-testid="layout-store-update-hub"
                >
                  {hubUploading === entry.id ? t('hub.updating') : t('hub.updateOnHub')}
                </button>
              )}
              {onRemoveFromHub && (
                <button
                  type="button"
                  className={HUB_BTN}
                  onClick={() => setConfirmHubRemoveId(entry.id)}
                  disabled={!!hubUploading || fileDisabled}
                  data-testid="layout-store-remove-hub"
                >
                  {t('hub.removeFromHub')}
                </button>
              )}
            </>
          )}
          {!entryHubPostId && (
            <HubOrphanButtons
              entry={entry}
              keyboardName={keyboardName}
              hubMyPosts={hubMyPosts}
              hubUploading={hubUploading}
              fileDisabled={fileDisabled}
              onUploadToHub={onUploadToHub}
              onReuploadToHub={onReuploadToHub}
              onDeleteOrphanedHubPost={onDeleteOrphanedHubPost}
            />
          )}
        </div>
      </div>
      {hubNeedsDisplayName && (entryHubPostId ? !onUpdateOnHub : !onUploadToHub) && (
        <div
          className="mt-1 text-[11px] text-content-muted"
          data-testid="layout-store-hub-needs-display-name"
        >
          {t('hub.needsDisplayName')}
        </div>
      )}
      {hubUploadResult && (hubUploadResult.entryId === entry.id || hubUploadResult.entryIds?.includes(entry.id)) && (
        <div
          className={`mt-1 flex items-center text-[11px] font-medium ${hubUploadResult.kind === 'success' ? 'text-accent' : 'text-danger'}`}
          data-testid="layout-store-hub-result"
        >
          {hubUploadResult.message}
        </div>
      )}
    </div>
  )
}
