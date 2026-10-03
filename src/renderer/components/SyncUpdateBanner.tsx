// SPDX-License-Identifier: GPL-2.0-or-later
// Top-of-window notice that Cloud Sync stopped because Google Drive needs
// a newer sync format than this app supports. Only sync is stopped; the
// rest of the app keeps working, so the banner can be closed for the
// session.

import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { BTN_SECONDARY, ICON_SM } from '../constants/ui-tokens'
import type { SyncUpdateBannerState } from '../hooks/use-sync-format-status'

export const PIPETTE_RELEASES_URL = 'https://github.com/darakuneko/pipette-desktop/releases/latest'

interface Props {
  state: SyncUpdateBannerState
}

export function SyncUpdateBanner({ state }: Props) {
  const { t } = useTranslation()

  if (!state.visible) return null

  return (
    <div
      className="flex items-center justify-between border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning"
      data-testid="sync-update-banner"
    >
      <span>{t('sync.updateBanner.message')}</span>
      <div className="ml-2 flex shrink-0 items-center gap-2">
        <button
          type="button"
          className={BTN_SECONDARY}
          onClick={() => void window.vialAPI.openExternal(PIPETTE_RELEASES_URL).catch(() => {})}
          data-testid="sync-update-download"
        >
          {t('sync.updateBanner.openDownloadPage')}
        </button>
        <button
          type="button"
          onClick={state.dismiss}
          className="shrink-0 rounded p-1 text-warning hover:text-warning/80"
          aria-label={t('common.close')}
        >
          <X size={ICON_SM} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
