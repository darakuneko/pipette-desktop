// SPDX-License-Identifier: GPL-2.0-or-later
//
// Find-on-Hub row for Theme Packs: wraps the shared PackHubResultRow
// with a Preview toggle (leadingActions) ahead of the Download button.
// Split out of ThemePacksModal (Task-split-pack-modals) — it was
// already a standalone function component defined below the modal, so
// this extraction only moves it into its own module.

import { useTranslation } from 'react-i18next'
import { PackHubResultRow } from '../pack-modal/PackHubResultRow'

export interface ThemeHubRowData {
  hubPostId: string
  name: string
  version: string
  uploaderName: string
  alreadyInstalled: boolean
}

export interface ThemeHubRowProps {
  row: ThemeHubRowData
  pendingId: string | null
  /** Defensive: the Hub tab isn't meant to be operable mid-import
   *  either, even though its own actions don't touch the Installed
   *  list directly. */
  importing: boolean
  hubOrigin: string
  previewPostId: string | null
  onPreview: (postId: string) => void
  onDownload: (postId: string) => void
}

export function ThemeHubRow({ row, pendingId, importing, previewPostId, onPreview, onDownload }: ThemeHubRowProps): JSX.Element {
  const { t } = useTranslation()
  const busy = pendingId === row.hubPostId || importing
  return (
    <PackHubResultRow
      hubPostId={row.hubPostId}
      testidPrefix="theme-packs"
      name={row.name}
      version={row.version}
      uploaderName={row.uploaderName}
      alreadyInstalled={row.alreadyInstalled}
      busy={busy}
      onDownload={() => onDownload(row.hubPostId)}
      leadingActions={
        <button
          type="button"
          className={`text-xs font-medium hover:underline disabled:opacity-50 ${
            previewPostId === row.hubPostId ? 'text-success' : 'text-content-secondary'
          }`}
          onClick={() => onPreview(row.hubPostId)}
          disabled={busy}
          data-testid={`theme-packs-hub-preview-${row.hubPostId}`}
        >
          {previewPostId === row.hubPostId ? t('themePacks.previewing') : t('themePacks.preview')}
        </button>
      }
    />
  )
}
