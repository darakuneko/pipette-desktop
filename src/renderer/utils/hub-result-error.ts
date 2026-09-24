// SPDX-License-Identifier: GPL-2.0-or-later

import type { TFunction } from 'i18next'
import { HUB_ERROR_ACCOUNT_DEACTIVATED, HUB_ERROR_RATE_LIMITED } from '../../shared/types/hub'

/**
 * Message for a failed layout snapshot or favorite Hub action.
 * Separate from `localizeHubError` (hub-error-i18n.ts) because this one
 * shows any other error text as-is instead of replacing it, and records
 * an account deactivation through `onAccountDeactivated`.
 * `fallback` is an already-translated string, used when `error` is
 * missing or empty.
 */
export function hubResultErrorMessage(
  error: string | undefined,
  fallback: string,
  t: TFunction,
  onAccountDeactivated: () => void,
): string {
  if (error === HUB_ERROR_ACCOUNT_DEACTIVATED) {
    onAccountDeactivated()
    return t('hub.accountDeactivated')
  }
  if (error === HUB_ERROR_RATE_LIMITED) return t('hub.rateLimited')
  return error || fallback
}
