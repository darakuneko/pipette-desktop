// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared types for Pipette Hub "Private (Unlisted) Uploads".
//
// A private upload is reachable only via its secret token URL and never
// appears in any listing. Each local entry is EITHER public (`hubPostId`)
// OR private (`hubPrivate`) — never both. The two fields are mutually
// exclusive and the stores enforce that invariant on write.
//
// Kept in its own module (rather than in `hub.ts`) so the per-entry meta
// types under `src/shared/types/*-store.ts` can import `HubPrivateLink`
// without creating an import cycle through `hub.ts`.

/** URL segment after `/api/private/`. Only `files` (keyboard / feature /
 *  analytics posts) supports private uploads; key labels, i18n packs and
 *  theme packs are public-only. */
export type HubPrivateKind = 'files'

/** Local linkage to a private (unlisted) Hub post. Persisted on the
 *  entry meta in place of `hubPostId` and synced the same way. */
export interface HubPrivateLink {
  /** Private post id (path segment). Required for `DELETE /api/private/<kind>/:id`. */
  id: string
  /** Relative share URL including the secret `?token=`. Prefix with the
   *  Hub origin to open / copy. */
  url: string
  /** ISO 8601 expiry timestamp. Private links always expire (max 180
   *  days); `null` only for legacy entries created before that rule. */
  expiresAt: string | null
}

/** Raw `data` payload of a `POST /api/private/*` response. */
export interface HubPrivateUploadResponse {
  id: string
  token: string
  url: string
  expires_at: string | null
}

/** IPC result of a private upload. `url` is the relative path (token
 *  included); the renderer prefixes the Hub origin to build the link. */
export interface HubPrivateUploadResult {
  success: boolean
  id?: string
  url?: string
  expiresAt?: string | null
  error?: string
}
