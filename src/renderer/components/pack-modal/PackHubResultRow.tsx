// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared Hub search result row for the Language Packs and Theme Packs
// "Find on Hub" tab: name + version/uploader block, and a trailing
// Installed-badge-or-Download button. Theme Packs additionally slots
// its Preview toggle in via `leadingActions` (rendered before the
// Installed/Download area). Key Labels keeps its own HubTable row
// (extra Author column + fixed-width action slot, plus an "Open"
// link this row doesn't have) — a permanent difference, not a
// pending-convergence gap: Key Labels has no `version` field, so the
// "name + v{version} · uploader" subtitle line this row renders
// doesn't apply to it. Row-level classes (`flex items-center gap-3
// rounded border border-edge bg-surface px-3 py-2`) and the metadata
// text styling (`text-xs`, name `text-sm font-medium`) are still kept
// in sync by hand across both — see KeyLabelsInstalledTable.tsx.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface PackHubResultRowProps {
  hubPostId: string
  /** e.g. `theme-packs` / `language-packs` — matches the row's other testids. */
  testidPrefix: string
  name: string
  version: string
  uploaderName: string
  alreadyInstalled: boolean
  busy: boolean
  onDownload: () => void
  /** Theme Packs only: the Preview toggle rendered before Download/Installed. */
  leadingActions?: ReactNode
}

export function PackHubResultRow({
  hubPostId,
  testidPrefix,
  name,
  version,
  uploaderName,
  alreadyInstalled,
  busy,
  onDownload,
  leadingActions,
}: PackHubResultRowProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="flex items-center gap-3 rounded border border-edge bg-surface px-3 py-2"
      data-testid={`${testidPrefix}-hub-row-${hubPostId}`}
    >
      <div className="flex-1 min-w-0">
        <div className="truncate text-sm font-medium text-content">{name}</div>
        <div className="text-xs text-content-muted">v{version}{uploaderName ? ` · ${uploaderName}` : ''}</div>
      </div>
      {/* Language Packs never passes `leadingActions`, so its trailing
          area keeps the original single-child `shrink-0` wrapper
          rather than picking up Theme Packs' `flex items-center gap-2`
          (which only matters once there are two children to space). */}
      <div className={leadingActions ? 'flex shrink-0 items-center gap-2' : 'shrink-0'}>
        {leadingActions}
        {alreadyInstalled ? (
          <span className="text-xs text-content-muted">{t('common.installed')}</span>
        ) : (
          <button
            type="button"
            className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
            onClick={onDownload}
            disabled={busy}
            data-testid={`${testidPrefix}-hub-download-${hubPostId}`}
          >
            {t('keyLabels.actionDownload')}
          </button>
        )}
      </div>
    </div>
  )
}
