// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pre-upload confirmation dialog. Lets the user choose Public vs Private
// visibility and (for Private) an expiry. Used for both the initial
// upload and the Update flow, where it doubles as a visibility switch.
// Switching to/away from Private deletes and recreates the post, so the
// share URL and expiry change — the modal warns about that.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { formatDateTime } from '../editors/store-modal-shared'

export type UploadVisibility = 'public' | 'private'

export interface UploadChoice {
  visibility: UploadVisibility
  /** Private link lifetime in days (1–180). `null` for public uploads,
   *  which have no expiry. The Hub no longer supports unlimited private
   *  links — omitting the value server-side applies the 180-day max. */
  expiresInDays: number | null
}

export interface UploadConfirmRequest {
  mode: 'create' | 'update'
  /** Current linkage state of the entry being uploaded. */
  currentVisibility: 'none' | 'public' | 'private'
}

interface Props {
  request: UploadConfirmRequest
  onConfirm: (choice: UploadChoice) => void
  onCancel: () => void
}

/** Selectable private-link expiry presets, in days. The Hub caps private
 *  links at 180 days and no longer allows an unlimited option. */
export const EXPIRY_PRESETS: number[] = [1, 3, 7, 30, 60, 90, 180]
const DEFAULT_EXPIRY_DAYS = 7

const RADIO_ROW = 'flex items-start gap-2 rounded-md border p-3 cursor-pointer'
const SELECT_CLASS = 'rounded-md border border-edge bg-surface px-2 py-1 text-sm text-content focus:border-accent focus:outline-none'

// Format with the app's locale-free helper rather than toLocaleString:
// `i18n.language` carries app-internal tags (e.g. "builtin:en" or a pack
// id) that are not valid BCP-47 and would throw a RangeError.
function formatExpiryDate(days: number): string {
  return formatDateTime(Date.now() + days * 24 * 60 * 60 * 1000)
}

export function UploadConfirmModal({ request, onConfirm, onCancel }: Props) {
  const { t } = useTranslation()
  useEscapeClose(onCancel)

  const [visibility, setVisibility] = useState<UploadVisibility>(
    request.currentVisibility === 'private' ? 'private' : 'public',
  )
  const [expiresInDays, setExpiresInDays] = useState<number>(DEFAULT_EXPIRY_DAYS)

  // The Update flow rebuilds the post (delete → create) whenever the
  // target is Private, or when switching away from Private to Public —
  // both produce a fresh URL / expiry. public→public keeps its URL.
  const willChangeUrl =
    request.mode === 'update' && !(request.currentVisibility === 'public' && visibility === 'public')

  const title = request.mode === 'update'
    ? t('hub.uploadConfirm.title.update')
    : t('hub.uploadConfirm.title.create')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="upload-confirm-backdrop"
      onClick={onCancel}
    >
      <div
        className="w-modal-sm max-w-modal-vw max-h-modal-80vh overflow-y-auto rounded-lg bg-surface-alt p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <ModalCloseButton testid="upload-confirm-close" onClick={onCancel} />
        </div>

        <div className="space-y-2">
          <label
            className={`${RADIO_ROW} ${visibility === 'public' ? 'border-accent bg-accent/10' : 'border-edge'}`}
            data-testid="upload-confirm-visibility-public"
          >
            <input
              type="radio"
              name="upload-visibility"
              checked={visibility === 'public'}
              onChange={() => setVisibility('public')}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-content">{t('hub.uploadConfirm.visibilityPublic')}</span>
              <span className="block text-xs text-content-secondary">{t('hub.uploadConfirm.publicDesc')}</span>
            </span>
          </label>

          <label
            className={`${RADIO_ROW} ${visibility === 'private' ? 'border-accent bg-accent/10' : 'border-edge'}`}
            data-testid="upload-confirm-visibility-private"
          >
            <input
              type="radio"
              name="upload-visibility"
              checked={visibility === 'private'}
              onChange={() => setVisibility('private')}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-content">{t('hub.uploadConfirm.visibilityPrivate')}</span>
              <span className="block text-xs text-content-secondary">{t('hub.uploadConfirm.privateDesc')}</span>
            </span>
          </label>
        </div>

        {visibility === 'private' && (
          <div className="mt-4">
            <label className="mb-1 block text-sm font-medium text-content" htmlFor="upload-confirm-expiry">
              {t('hub.uploadConfirm.expiryLabel')}
            </label>
            <select
              id="upload-confirm-expiry"
              className={SELECT_CLASS}
              data-testid="upload-confirm-expiry-select"
              value={String(expiresInDays)}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
            >
              {EXPIRY_PRESETS.map((preset) => (
                <option key={preset} value={String(preset)}>
                  {t('hub.uploadConfirm.expiryDays', { count: preset })}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-content-secondary" data-testid="upload-confirm-expiry-preview">
              {t('hub.uploadConfirm.expiresAtPreview', { date: formatExpiryDate(expiresInDays) })}
            </p>
          </div>
        )}

        {willChangeUrl && (
          <p className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-content-secondary" data-testid="upload-confirm-warning">
            {t('hub.uploadConfirm.warnUrlExpiryChange')}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-edge px-3 py-1.5 text-sm text-content hover:bg-surface-dim"
            onClick={onCancel}
            data-testid="upload-confirm-cancel"
          >
            {t('hub.uploadConfirm.cancel')}
          </button>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-content-inverse hover:bg-accent-hover"
            onClick={() => onConfirm({ visibility, expiresInDays: visibility === 'private' ? expiresInDays : null })}
            data-testid="upload-confirm-submit"
          >
            {t('hub.uploadConfirm.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
