// SPDX-License-Identifier: GPL-2.0-or-later
//
// Renderer-side mapper from raw Hub error strings to i18n keys.
// Hub errors arrive at the renderer in three shapes:
//
//   1. Bare sentinel constants for "well-known" auth/quota issues
//      (e.g. `HUB_ERROR_ACCOUNT_DEACTIVATED`, `HUB_ERROR_RATE_LIMITED`).
//   2. Formatted HubHttpError strings from `hub-client.ts`:
//      `<label>: <status> <body>` (e.g. `"Hub analytics upload failed:
//      400 {\"ok\":false,\"error\":\"INVALID_PAYLOAD: keystrokes
//      below threshold\"}"`).
//   3. Plain main-process validation strings (`"Saved filter entry
//      not found"`, `"No keymap snapshot recorded for this range"` …).
//
// Surfacing the raw text in the UI bleeds backend phrasing and JSON
// punctuation into a user-facing modal — this helper recognises the
// known patterns and rewrites them to localised messages, falling
// back to the caller-supplied default for unknown shapes.

import type { TFunction } from 'i18next'
import {
  HUB_ERROR_ACCOUNT_DEACTIVATED,
  HUB_ERROR_DISPLAY_NAME_CONFLICT,
  HUB_ERROR_RATE_LIMITED,
} from '../../shared/types/hub'

/** INVALID_PAYLOAD reasons the Hub server emits and the i18n key each
 * one maps to. Listed explicitly so the renderer's localisation can't
 * silently miss a new validation case — adding a server-side reason
 * without a row here falls back to the generic `invalidPayload` key. */
const INVALID_PAYLOAD_KEYS: Array<[reason: string, key: string]> = [
  ['keystrokes below threshold', 'hub.error.keystrokesBelow'],
  ['range exceeds 30 days', 'hub.error.rangeExceeds'],
  ['unsupported version', 'hub.error.unsupportedVersion'],
  ['kind mismatch', 'hub.error.kindMismatch'],
]

/** Bare main-process / server sentinels (no formatting around them). */
const SENTINEL_KEYS: Record<string, string> = {
  [HUB_ERROR_ACCOUNT_DEACTIVATED]: 'hub.accountDeactivated',
  [HUB_ERROR_RATE_LIMITED]: 'hub.rateLimited',
  [HUB_ERROR_DISPLAY_NAME_CONFLICT]: 'hub.displayNameTaken',
  // Main-side prepareAnalyticsExport rejections.
  'Saved filter entry not found': 'hub.error.entryNotFound',
  'Saved filter payload is not valid JSON': 'hub.error.malformedSavedPayload',
  'Unsupported saved filter version': 'hub.error.unsupportedSavedVersion',
  'Saved filter has no range': 'hub.error.noRange',
  'No keymap snapshot recorded for this range': 'hub.error.noSnapshot',
  'Invalid uid': 'hub.error.invalidId',
  'Invalid entryId': 'hub.error.invalidId',
  'Invalid post ID': 'hub.error.invalidId',
  'Title must not be empty': 'hub.error.titleEmpty',
  'Title too long': 'hub.error.titleTooLong',
}

/** Any HubHttpError string contains `: <status> <body>`. We match the
 * status to a localised category before falling through to the generic
 * upload/update fallback. */
const STATUS_KEY_BY_CODE: Record<string, string> = {
  '401': 'hub.error.authFailed',
  '403': 'hub.accountDeactivated',
  '413': 'hub.error.payloadTooLarge',
  '429': 'hub.rateLimited',
}

const INVALID_PAYLOAD_PREFIX = 'INVALID_PAYLOAD:'
/** Matches the body that hub-client.ts wraps every HubHttpError in. */
const HUB_HTTP_RE = /:\s+(\d{3})(?:\s|$)/

/**
 * Convert a raw error string from main into a localised user-facing
 * message. `fallbackKey` is the i18n key used when no pattern matches
 * (typically `hub.uploadFailed` / `hub.updateFailed`).
 */
export function localizeHubError(
  raw: string | undefined,
  fallbackKey: string,
  t: TFunction,
): string {
  if (!raw) return t(fallbackKey)

  // Sentinel constant or a bare prepareAnalyticsExport message.
  const sentinelKey = SENTINEL_KEYS[raw]
  if (sentinelKey) return t(sentinelKey)

  // Hub-server `INVALID_PAYLOAD: <reason>` — search the raw string so
  // we also catch cases where the validator nested it inside the
  // formatted `Hub analytics upload failed: 400 {"ok":false,
  // "error":"INVALID_PAYLOAD: ..."}` body.
  const invalidIdx = raw.indexOf(INVALID_PAYLOAD_PREFIX)
  if (invalidIdx !== -1) {
    const tail = raw.slice(invalidIdx + INVALID_PAYLOAD_PREFIX.length).trim()
    for (const [reason, key] of INVALID_PAYLOAD_KEYS) {
      if (tail.startsWith(reason)) return t(key)
    }
    // `<field> must be array` covers ten different fields — collapse
    // them rather than enumerate each one.
    if (/ must be array/.test(tail)) return t('hub.error.malformedPayload')
    return t('hub.error.invalidPayload')
  }

  // HubHttpError: `Label: <status> <body>` — look up the status code
  // first because 401 / 403 / 413 / 429 each have specific copy.
  const httpMatch = HUB_HTTP_RE.exec(raw)
  if (httpMatch) {
    const code = httpMatch[1]
    const statusKey = STATUS_KEY_BY_CODE[code]
    if (statusKey) return t(statusKey)
  }

  return t(fallbackKey)
}
