// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared Hub action strip (Open / Upload / Sync-with-update-dot /
// Update + Remove-confirm-pair) used by the Language Packs, Theme
// Packs, and Key Labels installed rows' second line.
//
// Every `show*` flag is pre-computed by the caller so real asymmetries
// stay put instead of being baked into this shared component — e.g.
// Theme Packs only shows "Open" when `hubOrigin` has loaded, Language
// Packs shows it whenever `hubPostId` is set (its own `onOpen` handler
// no-ops until `hubOrigin` arrives). `canWrite` and
// `hideOthersWhileConfirmingRemove` exist for the same reason: Key
// Labels' write-gating and remove-confirmation rendering were real,
// deliberate asymmetries from its original `HubLineActions`, not
// oversights, so they were added as opt-in props rather than folded
// into the other two callers' behavior.

import { useTranslation } from 'react-i18next'

export interface PackHubActionsProps {
  id: string
  /** e.g. `theme-packs` / `language-packs` — matches the row's other testids. */
  testidPrefix: string
  busy: boolean
  showOpen: boolean
  onOpen: () => void
  showUpload: boolean
  onUpload: () => void
  /** Hub-linked row that doesn't get Update/Remove (not signed in for writes). */
  showSync: boolean
  hasUpdateAvailable: boolean
  onSync: () => void
  showUpdateRemove: boolean
  confirmingRemove: boolean
  onUpdate: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
  /**
   * Additional write-gate that *disables* (rather than hides) Upload /
   * Update / Remove. Language Packs and Theme Packs already fold
   * `hubCanWrite` into `showUpload`/`showUpdateRemove` (hidden
   * entirely when false), so this prop is a no-op for them. Key
   * Labels keeps these buttons visible regardless of write access and
   * only disables them — its original `HubLineActions` behavior —
   * so it passes its own `hubCanWrite` here instead of folding it
   * into the show* flags. Defaults to `true` so the two existing
   * callers are unaffected without passing it.
   */
  canWrite?: boolean
  /**
   * When true, Open/Upload/Sync are hidden while `confirmingRemove` is
   * active so only the Confirm/Cancel pair shows — Key Labels'
   * original behavior, which treated the remove confirmation as
   * replacing the whole action line rather than layering on top of
   * it. Defaults to `false`, preserving Language/Theme Packs' existing
   * behavior of keeping Open visible alongside Confirm/Cancel.
   */
  hideOthersWhileConfirmingRemove?: boolean
}

const LINK_CLASS = 'text-xs font-medium hover:underline disabled:opacity-50'

export function PackHubActions({
  id,
  testidPrefix,
  busy,
  showOpen,
  onOpen,
  showUpload,
  onUpload,
  showSync,
  hasUpdateAvailable,
  onSync,
  showUpdateRemove,
  confirmingRemove,
  onUpdate,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
  canWrite = true,
  hideOthersWhileConfirmingRemove = false,
}: PackHubActionsProps): JSX.Element {
  const { t } = useTranslation()
  const hideOthers = hideOthersWhileConfirmingRemove && showUpdateRemove && confirmingRemove

  return (
    <>
      {showOpen && !hideOthers && (
        <button
          type="button"
          className={`${LINK_CLASS} text-accent`}
          onClick={onOpen}
          disabled={busy}
          data-testid={`${testidPrefix}-open-${id}`}
        >
          {t('hub.openInBrowser')}
        </button>
      )}
      {showUpload && !hideOthers && (
        <button
          type="button"
          className={`${LINK_CLASS} text-accent`}
          onClick={onUpload}
          disabled={busy || !canWrite}
          data-testid={`${testidPrefix}-upload-${id}`}
        >
          {t('keyLabels.actionUpload')}
        </button>
      )}
      {showSync && !hideOthers && (
        <button
          type="button"
          className={`${LINK_CLASS} text-accent inline-flex items-center gap-1`}
          onClick={onSync}
          disabled={busy}
          data-testid={`${testidPrefix}-sync-${id}`}
        >
          {hasUpdateAvailable && (
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-success animate-pulse"
              data-testid={`${testidPrefix}-update-available-${id}`}
            />
          )}
          {t('keyLabels.actionSync')}
        </button>
      )}
      {showUpdateRemove && (
        confirmingRemove ? (
          <>
            <button
              type="button"
              className={`${LINK_CLASS} text-danger`}
              onClick={onConfirmRemove}
              disabled={busy || !canWrite}
              data-testid={`${testidPrefix}-confirm-remove-${id}`}
            >
              {t('hub.confirmRemove')}
            </button>
            <button
              type="button"
              className={`${LINK_CLASS} text-content-muted`}
              onClick={onCancelRemove}
              data-testid={`${testidPrefix}-cancel-remove-${id}`}
            >
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`${LINK_CLASS} text-accent`}
              onClick={onUpdate}
              disabled={busy || !canWrite}
              data-testid={`${testidPrefix}-update-${id}`}
            >
              {t('keyLabels.actionUpdate')}
            </button>
            <button
              type="button"
              className={`${LINK_CLASS} text-danger`}
              onClick={onAskRemove}
              disabled={busy || !canWrite}
              data-testid={`${testidPrefix}-remove-${id}`}
            >
              {t('keyLabels.actionRemove')}
            </button>
          </>
        )
      )}
    </>
  )
}
