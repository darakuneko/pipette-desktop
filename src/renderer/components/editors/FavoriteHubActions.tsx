// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SavedFavoriteMeta } from '../../../shared/types/favorite-store'

const HUB_BTN_BASE = 'text-[11px] font-medium text-accent bg-accent/10 border border-accent/30 px-2 py-0.5 rounded hover:bg-accent/20 hover:border-accent/50'
const HUB_BTN = `${HUB_BTN_BASE} disabled:opacity-50`

export interface FavHubEntryResult {
  kind: 'success' | 'error'
  message: string
  entryId: string
}

interface FavoriteHubActionsProps {
  entry: SavedFavoriteMeta
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
  const hubPostUrl = hasHubPost && hubOrigin ? `${hubOrigin}/posts/${entry.hubPostId}` : null

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1" data-testid="fav-hub-actions">
      {hubNeedsDisplayName && (
        <span className="text-[10px] text-content-muted" data-testid="fav-hub-needs-display-name">
          {t('hub.needsDisplayName')}
        </span>
      )}

      {isUploading && (
        <span className="text-[10px] text-accent" data-testid="fav-hub-uploading">
          {t('hub.uploading')}
        </span>
      )}

      {result && (
        <span
          className={`text-[10px] ${result.kind === 'success' ? 'text-accent' : 'text-red-400'}`}
          data-testid="fav-hub-result"
        >
          {result.message}
        </span>
      )}

      {!isUploading && !hubNeedsDisplayName && (
        <>
          {hasHubPost ? (
            <>
              {onUpdateOnHub && (
                <button
                  type="button"
                  className={HUB_BTN}
                  onClick={() => onUpdateOnHub(entry.id)}
                  disabled={disabled}
                  data-testid="fav-hub-update-btn"
                >
                  {t('hub.updateOnHub')}
                </button>
              )}
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
                onRemoveFromHub && (
                  <button
                    type="button"
                    className={HUB_BTN}
                    onClick={() => setConfirmRemoveId(entry.id)}
                    disabled={disabled}
                    data-testid="fav-hub-remove-btn"
                  >
                    {t('hub.removeFromHub')}
                  </button>
                )
              )}
              {hubPostUrl && (
                <a
                  href={hubPostUrl}
                  onClick={(e) => {
                    e.preventDefault()
                    void window.vialAPI.openExternal(hubPostUrl)
                  }}
                  className={HUB_BTN_BASE}
                  data-testid="fav-hub-share-link"
                >
                  {t('hub.openInBrowser')}
                </a>
              )}
            </>
          ) : (
            onUploadToHub && (
              <button
                type="button"
                className={HUB_BTN}
                onClick={() => onUploadToHub(entry.id)}
                disabled={disabled}
                data-testid="fav-hub-upload-btn"
              >
                {t('hub.uploadToHub')}
              </button>
            )
          )}
        </>
      )}
    </div>
  )
}
