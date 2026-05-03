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
import { ACTION_BTN, CONFIRM_DELETE_BTN } from '../editors/store-modal-shared'
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
  const hubPostId = entry.hubPostId
  const isUploading = hubUploading === entry.id
  const buttonsDisabled = !!hubUploading || fileDisabled
  const resultMatches = hubUploadResult?.entryId === entry.id

  return (
    <div
      className="mt-1.5 border-t border-edge pt-1.5"
      data-testid={`analyze-filter-store-hub-row-${entry.id}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-accent">
          {t('hub.pipetteHub')}
        </span>
        <div className="flex gap-1">
          {hubPostId && hubOrigin && (
            <ShareLink url={`${hubOrigin}/post/${encodeURIComponent(hubPostId)}`} />
          )}
          {hubPostId && confirmHubRemoveId === entry.id && (
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
          {hubPostId && confirmHubRemoveId !== entry.id && (
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
          {!hubPostId && onUploadToHub && (
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
      {hubNeedsDisplayName && (hubPostId ? !onUpdateOnHub : !onUploadToHub) && (
        <div
          className="mt-1 text-[11px] text-content-muted"
          data-testid={`analyze-filter-store-hub-needs-display-name-${entry.id}`}
        >
          {t('hub.needsDisplayName')}
        </div>
      )}
      {resultMatches && hubUploadResult && (
        <div
          className={`mt-1 flex items-center text-[11px] font-medium ${
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
