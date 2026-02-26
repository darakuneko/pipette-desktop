// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SavedFavoriteMeta } from '../../../shared/types/favorite-store'
import type { HubFeaturePostType } from '../../../shared/types/hub'

const HUB_BTN_BASE = 'text-[11px] font-medium text-accent bg-accent/10 border border-accent/30 px-2 py-0.5 rounded hover:bg-accent/20 hover:border-accent/50'
const HUB_BTN = `${HUB_BTN_BASE} disabled:opacity-50`

export interface FavHubEntryResult {
  kind: 'success' | 'error'
  message: string
  entryId: string
}

interface FavoriteHubActionsProps {
  entry: SavedFavoriteMeta
  postType?: HubFeaturePostType
  hubOrigin?: string
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: FavHubEntryResult | null
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
}

export function FavoriteHubActions({
  entry,
  postType,
  hubOrigin,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
}: FavoriteHubActionsProps) {
  const { t } = useTranslation()
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  const hasAnyAction = onUploadToHub || onUpdateOnHub || onRemoveFromHub
  if (!hasAnyAction) return null

  const disabled = !!hubUploading
  const isUploading = hubUploading === entry.id
  const result = hubUploadResult?.entryId === entry.id ? hubUploadResult : null

  const hasHubPost = !!entry.hubPostId
  const hubListUrl = hasHubPost && hubOrigin && postType ? `${hubOrigin}/?post_type=${postType}` : null

  return (
    <div className="mt-1.5 border-t border-edge pt-1.5" data-testid="fav-hub-actions">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-accent">{t('hub.pipetteHub')}</span>
        <div className="flex gap-1">
          {!isUploading && hasHubPost && (
            <>
              {confirmRemoveId === entry.id ? (
                <>
                  <button
                    type="button"
                    className={HUB_BTN}
                    onClick={() => { onRemoveFromHub?.(entry.id); setConfirmRemoveId(null) }}
                    disabled={disabled}
                    data-testid="fav-hub-remove-confirm"
                  >
                    {t('hub.confirmRemove')}
                  </button>
                  <button
                    type="button"
                    className={HUB_BTN}
                    onClick={() => setConfirmRemoveId(null)}
                    data-testid="fav-hub-remove-cancel"
                  >
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <>
                  {hubListUrl && (
                    <a
                      href={hubListUrl}
                      onClick={(e) => {
                        e.preventDefault()
                        void window.vialAPI.openExternal(hubListUrl)
                      }}
                      className={HUB_BTN_BASE}
                      data-testid="fav-hub-share-link"
                    >
                      {t('hub.openInBrowser')}
                    </a>
                  )}
                  {!hubNeedsDisplayName && onUpdateOnHub && (
                    <button
                      type="button"
                      className={HUB_BTN}
                      onClick={() => onUpdateOnHub(entry.id)}
                      disabled={disabled}
                      data-testid="fav-hub-update-btn"
                    >
                      {isUploading ? t('hub.updating') : t('hub.updateOnHub')}
                    </button>
                  )}
                  {onRemoveFromHub && (
                    <button
                      type="button"
                      className={HUB_BTN}
                      onClick={() => setConfirmRemoveId(entry.id)}
                      disabled={disabled}
                      data-testid="fav-hub-remove-btn"
                    >
                      {t('hub.removeFromHub')}
                    </button>
                  )}
                </>
              )}
            </>
          )}
          {!isUploading && !hasHubPost && !hubNeedsDisplayName && onUploadToHub && (
            <button
              type="button"
              className={HUB_BTN}
              onClick={() => onUploadToHub(entry.id)}
              disabled={disabled}
              data-testid="fav-hub-upload-btn"
            >
              {t('hub.uploadToHub')}
            </button>
          )}
        </div>
      </div>
      {hubNeedsDisplayName && (hasHubPost ? !onUpdateOnHub : !onUploadToHub) && (
        <div
          className="mt-1 text-[11px] text-content-muted"
          data-testid="fav-hub-needs-display-name"
        >
          {t('hub.needsDisplayName')}
        </div>
      )}
      {isUploading && (
        <div className="mt-1 text-[11px] text-accent" data-testid="fav-hub-uploading">
          {t('hub.uploading')}
        </div>
      )}
      {result && (
        <div
          className={`mt-1 text-[11px] font-medium ${result.kind === 'success' ? 'text-accent' : 'text-danger'}`}
          data-testid="fav-hub-result"
        >
          {result.message}
        </div>
      )}
    </div>
  )
}
