// SPDX-License-Identifier: GPL-2.0-or-later
//
// Hub action row for an Analyze saved-filter entry. Mirrors
// LayoutStoreHubRow visually so the keymap save panel and the analyze
// save panel share one pattern: a thin border-top, "Hub" label on the
// left, and one or more action buttons on the right (Upload / Update /
// Remove + Open). Status text appears below when the entry is the
// active target of an in-flight upload or a recently completed result.

import { useTranslation } from 'react-i18next'
import { HUB_BTN, SHARE_LINK_BTN } from '../editors/layout-store-types'
import type { HubEntryResult } from '../editors/layout-store-types'
import { ACTION_BTN, CONFIRM_DELETE_BTN, formatDateShort } from '../editors/store-modal-shared'
import type { AnalyzeFilterSnapshotMeta } from '../../../shared/types/analyze-filter-store'

interface ShareLinkProps {
  url: string
}

function ShareLink({ url }: ShareLinkProps): JSX.Element {
  const { t } = useTranslation()
  function handleClick(e: React.MouseEvent): void {
    e.preventDefault()
    window.vialAPI.openExternal(url).catch(() => { /* user-triggered, ignore failures */ })
  }
  return (
    <a
      href={url}
      onClick={handleClick}
      className={SHARE_LINK_BTN}
      data-testid="analyze-filter-store-hub-share-link"
    >
      {t('hub.openInBrowser')}
    </a>
  )
}

export interface AnalyzeFilterStoreHubRowProps {
  entry: AnalyzeFilterSnapshotMeta
  hubOrigin?: string
  hubNeedsDisplayName?: boolean
  /** Entry id currently being uploaded — buttons disable / status text
   * switches to "Uploading…" while this matches the row's id. */
  hubUploading?: string | null
  /** Per-entry result of the last upload attempt. Stays visible until
   * the next upload kicks off so the user can see "Uploaded" / failure
   * for a few seconds. */
  hubUploadResult?: HubEntryResult | null
  fileDisabled?: boolean
  confirmHubRemoveId: string | null
  setConfirmHubRemoveId: (id: string | null) => void
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
}

export function AnalyzeFilterStoreHubRow({
  entry,
  hubOrigin,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  fileDisabled,
  confirmHubRemoveId,
  setConfirmHubRemoveId,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
}: AnalyzeFilterStoreHubRowProps): JSX.Element {
  const { t } = useTranslation()
  // public and private linkage are mutually exclusive.
  const isPrivate = !!entry.hubPrivate
  const hubPostId = isPrivate ? undefined : entry.hubPostId
  const linked = isPrivate || !!hubPostId
  const isUploading = hubUploading === entry.id
  const buttonsDisabled = !!hubUploading || fileDisabled
  const resultMatches = hubUploadResult?.entryId === entry.id
  const openUrl = isPrivate
    ? (hubOrigin && entry.hubPrivate ? `${hubOrigin}${entry.hubPrivate.url}` : undefined)
    : (hubPostId && hubOrigin ? `${hubOrigin}/post/${encodeURIComponent(hubPostId)}` : undefined)
  const badge = isPrivate
    ? t('hub.private.badgePrivate')
    : (hubPostId ? t('hub.private.badgePublic') : t('hub.pipetteHub'))

  return (
    <div
      className="mt-1.5 border-t border-edge pt-1.5"
      data-testid={`analyze-filter-store-hub-row-${entry.id}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-accent" data-testid={`analyze-filter-store-hub-badge-${entry.id}`}>
          {badge}
        </span>
        <div className="flex gap-1">
          {openUrl && <ShareLink url={openUrl} />}
          {linked && confirmHubRemoveId === entry.id && (
            <>
              <button
                type="button"
                className={CONFIRM_DELETE_BTN}
                onClick={() => { onRemoveFromHub?.(entry.id); setConfirmHubRemoveId(null) }}
                data-testid={`analyze-filter-store-hub-remove-confirm-${entry.id}`}
              >
                {t('hub.confirmRemove')}
              </button>
              <button
                type="button"
                className={ACTION_BTN}
                onClick={() => setConfirmHubRemoveId(null)}
                data-testid={`analyze-filter-store-hub-remove-cancel-${entry.id}`}
              >
                {t('common.cancel')}
              </button>
            </>
          )}
          {linked && confirmHubRemoveId !== entry.id && (
            <>
              {onUpdateOnHub && (
                <button
                  type="button"
                  className={HUB_BTN}
                  onClick={() => onUpdateOnHub(entry.id)}
                  disabled={buttonsDisabled}
                  data-testid={`analyze-filter-store-update-hub-${entry.id}`}
                >
                  {isUploading ? t('hub.updating') : t('hub.updateOnHub')}
                </button>
              )}
              {onRemoveFromHub && (
                <button
                  type="button"
                  className={HUB_BTN}
                  onClick={() => setConfirmHubRemoveId(entry.id)}
                  disabled={buttonsDisabled}
                  data-testid={`analyze-filter-store-remove-hub-${entry.id}`}
                >
                  {t('hub.removeFromHub')}
                </button>
              )}
            </>
          )}
          {!linked && onUploadToHub && (
            <button
              type="button"
              className={HUB_BTN}
              onClick={() => onUploadToHub(entry.id)}
              disabled={buttonsDisabled}
              data-testid={`analyze-filter-store-upload-hub-${entry.id}`}
            >
              {isUploading ? t('hub.uploading') : t('hub.uploadToHub')}
            </button>
          )}
        </div>
      </div>
      {isPrivate && entry.hubPrivate && (
        <div className="mt-1 text-xs text-content-muted" data-testid={`analyze-filter-store-hub-expiry-${entry.id}`}>
          {entry.hubPrivate.expiresAt
            ? t('hub.private.expiresAt', { date: formatDateShort(entry.hubPrivate.expiresAt) })
            : t('hub.private.noExpiry')}
        </div>
      )}
      {hubNeedsDisplayName && (linked ? !onUpdateOnHub : !onUploadToHub) && (
        <div
          className="mt-1 text-xs text-content-muted"
          data-testid={`analyze-filter-store-hub-needs-display-name-${entry.id}`}
        >
          {t('hub.needsDisplayName')}
        </div>
      )}
      {resultMatches && hubUploadResult && (
        <div
          className={`mt-1 flex items-center text-xs font-medium ${
            hubUploadResult.kind === 'success' ? 'text-accent' : 'text-danger'
          }`}
          data-testid={`analyze-filter-store-hub-result-${entry.id}`}
        >
          {hubUploadResult.message}
        </div>
      )}
    </div>
  )
}
