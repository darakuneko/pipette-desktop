// SPDX-License-Identifier: GPL-2.0-or-later
// Google Drive API client for appDataFolder

import { getAccessToken } from './google-auth'
import { pLimit } from '../../shared/concurrency'
import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'
import type { SyncEnvelope } from '../../shared/types/sync'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const DELETE_CONCURRENCY = 5

export interface DriveFile {
  id: string
  name: string
  modifiedTime: string
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  if (!token) throw new Error('Not authenticated with Google Drive')
  return { Authorization: `Bearer ${token}` }
}

export interface ListFilesOptions {
  /** Drive `q` substring filter on the `name` field. The value is wrapped
   * in single quotes and any embedded quotes are backslash-escaped per the
   * Drive search-query language. Use it to keep the response narrow when
   * the caller only cares about a known filename prefix (e.g. analytics
   * sync only needs files for one keyboard uid).
   *
   * Omit (or pass an empty string) to list every file in `appDataFolder`. */
  nameContains?: string
}

/** Lists every file in `appDataFolder` matching `options`, following
 *  `nextPageToken` until Drive stops returning one. Every existing caller
 *  (scan, poll, upload/download passes, resets, …) expects a single
 *  complete `DriveFile[]` for the whole appData folder — this loops
 *  internally rather than exposing a separate paginated variant, so
 *  none of those call sites need to change once a user's file count
 *  crosses Drive's single-page cap (1000, this call's own `pageSize`). */
export async function listFiles(options?: ListFilesOptions): Promise<DriveFile[]> {
  const headers = await authHeaders()
  const files: DriveFile[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      fields: 'nextPageToken, files(id, name, modifiedTime)',
      pageSize: '1000',
    })
    const filter = options?.nameContains
    if (filter) {
      const escaped = filter.replace(/'/g, "\\'")
      params.set('q', `name contains '${escaped}'`)
    }
    if (pageToken) params.set('pageToken', pageToken)

    const response = await fetch(`${DRIVE_API}/files?${params}`, { headers })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Drive list failed: ${response.status} ${body}`)
    }

    const data = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string }
    files.push(...(data.files ?? []))
    pageToken = data.nextPageToken
  } while (pageToken)

  return files
}

export async function downloadFile(fileId: string): Promise<SyncEnvelope> {
  const headers = await authHeaders()
  const params = new URLSearchParams({ alt: 'media' })

  const response = await fetch(`${DRIVE_API}/files/${fileId}?${params}`, { headers })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Drive download failed: ${response.status} ${body}`)
  }

  return (await response.json()) as SyncEnvelope
}

export interface UploadedFile {
  id: string
  /** Drive's own `modifiedTime` for the revision this call just wrote.
   *  Callers that decide a local-wins upload (i18n/theme pack bodies —
   *  see `pinPackBodyMtimeAfterUpload` in pack-bundle-merge.ts) pin the
   *  local file's mtime to this value instead of leaving it at "now",
   *  closing a clock-skew gap: a locally-ahead wall clock would
   *  otherwise permanently look newer than Drive's own stamped time,
   *  forcing a redundant re-upload (and re-download on every peer) on
   *  every subsequent sync pass. */
  modifiedTime: string
}

export async function uploadFile(
  name: string,
  envelope: SyncEnvelope,
  existingFileId?: string,
): Promise<UploadedFile> {
  const headers = await authHeaders()
  const content = JSON.stringify(envelope)

  if (existingFileId) {
    // Update existing file. `fields` is requested explicitly — the
    // default response for a media-upload PATCH omits `modifiedTime`.
    const response = await fetch(
      `${UPLOAD_API}/files/${existingFileId}?uploadType=media&fields=id,modifiedTime`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: content,
      },
    )
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Drive update failed: ${response.status} ${body}`)
    }
    return (await response.json()) as UploadedFile
  }

  // Create new file with multipart upload
  const metadata = {
    name,
    parents: ['appDataFolder'],
  }

  const boundary = '---pipette-sync-boundary'
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n')

  // `fields` requested explicitly — same reasoning as the update path above.
  const response = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Drive upload failed: ${response.status} ${body}`)
  }

  return (await response.json()) as UploadedFile
}

export async function deleteFile(fileId: string): Promise<void> {
  const headers = await authHeaders()
  const response = await fetch(`${DRIVE_API}/files/${fileId}`, {
    method: 'DELETE',
    headers,
  })
  if (!response.ok && response.status !== 404) {
    const body = await response.text()
    throw new Error(`Drive delete failed: ${response.status} ${body}`)
  }
}

export async function deleteAllFiles(): Promise<void> {
  const files = await listFiles()
  const limit = pLimit(DELETE_CONCURRENCY)
  await Promise.allSettled(files.map((file) => limit(() => deleteFile(file.id))))
}

export function driveFileName(syncUnit: string): string {
  // "favorites/tapDance" -> "favorites_tapDance.enc"
  // "keyboards/0x1234/settings" -> "keyboards_0x1234_settings.enc"
  // "keyboards/0x1234/snapshots" -> "keyboards_0x1234_snapshots.enc"
  // "keyboards/0x1234/devices/{hash}" -> "keyboards_0x1234_devices_{hash}.enc"
  return driveFilenamePrefix(syncUnit) + '.enc'
}

/** Drive filename prefix for a given sync-unit path prefix (no `.enc`
 * suffix). Pair with `listFiles({ nameContains })` so a single sync-unit
 * subtree is the only thing returned by the Drive listing. Shares its
 * encoding with `driveFileName` so the two stay in lockstep if the
 * filename scheme ever changes. */
export function driveFilenamePrefix(syncUnitPrefix: string): string {
  return syncUnitPrefix.replaceAll('/', '_')
}

/** Filenames with no uid/packId segment — a plain Map lookup resolves
 * these before any regex is attempted, rather than falling through a
 * chain of `===` checks interleaved with the regex-based patterns below.
 * `KEYBOARD_META_SYNC_UNIT`'s filename is derived via `driveFileName` so
 * it can't drift from the constant if that ever changes. */
const EXACT_SYNC_UNIT_FILENAMES = new Map<string, string>([
  ['key-labels.enc', 'key-labels'], // global, all-keyboard store — no uid segment
  ['typing-test-texts.enc', 'typing-test-texts'], // global, all-keyboard store
  ['i18n_index.enc', 'i18n/index'],
  ['themes_index.enc', 'themes/index'],
  [driveFileName(KEYBOARD_META_SYNC_UNIT), KEYBOARD_META_SYNC_UNIT],
])

export function syncUnitFromFileName(fileName: string): string | null {
  const exact = EXACT_SYNC_UNIT_FILENAMES.get(fileName)
  if (exact) return exact

  // "keyboards_0x1234_devices_{hash}_days_{YYYY-MM-DD}.enc"
  //   → "keyboards/0x1234/devices/{hash}/days/{YYYY-MM-DD}"
  // The day regex pins to exactly `YYYY-MM-DD` so machineHash strings
  // containing `_days_...` shaped substrings can't false-match.
  const dayMatch = fileName.match(/^keyboards_(.+?)_devices_(.+?)_days_(\d{4}-\d{2}-\d{2})\.enc$/)
  if (dayMatch) return `keyboards/${dayMatch[1]}/devices/${dayMatch[2]}/days/${dayMatch[3]}`

  // "keyboards_0x1234_settings.enc" → "keyboards/0x1234/settings"
  // "keyboards_0x1234_snapshots.enc" → "keyboards/0x1234/snapshots"
  // "keyboards_0x1234_runs.enc" → "keyboards/0x1234/runs" (per-run raw
  // keystroke log)
  // "keyboards_0x1234_analyze_filters.enc" → "keyboards/0x1234/analyze_filters"
  // (Task-sync-unit-filename-gap: closed the fresh-machine discovery gap
  // for this store — see the task doc for the original report. The uid
  // capture is non-greedy, so this alternation is only unambiguous as
  // long as no future store name here is itself a suffix-composition of
  // another store name in this list (e.g. adding a bare 'filters' store
  // would collide with 'analyze_filters') — pick distinct names.)
  const kbMatch = fileName.match(/^keyboards_(.+?)_(settings|snapshots|runs|analyze_filters)\.enc$/)
  if (kbMatch) return `keyboards/${kbMatch[1]}/${kbMatch[2]}`

  // "favorites_tapDance.enc" → "favorites/tapDance"
  const favMatch = fileName.match(/^favorites_(.+)\.enc$/)
  if (favMatch) return `favorites/${favMatch[1]}`

  // "i18n_packs_{packId}.enc" → "i18n/packs/{packId}"
  // Pack ids are restricted to safe filename characters (UUID-like) so
  // a single greedy capture is enough — no nested separators to split.
  const i18nPackMatch = fileName.match(/^i18n_packs_(.+)\.enc$/)
  if (i18nPackMatch) return `i18n/packs/${i18nPackMatch[1]}`

  // "themes_packs_{packId}.enc" → "themes/packs/{packId}" — same
  // greedy-capture reasoning as the i18n pack pattern above.
  const themePackMatch = fileName.match(/^themes_packs_(.+)\.enc$/)
  if (themePackMatch) return `themes/packs/${themePackMatch[1]}`

  // "password-check.enc" is intentionally never mapped to a sync unit —
  // it's a standalone credential-validation file (see sync-service.ts's
  // PASSWORD_CHECK_UNIT), not a data sync unit, and must stay invisible
  // to scanRemoteData / polling / fresh-machine discovery.

  return null
}

/** Outcome of a matched-files delete batch: `attempted` is how many files
 *  matched the predicate (0 is a legitimate "nothing to delete", not a
 *  failure); `failed` is how many of those rejected. Callers (the
 *  SYNC_RESET_TARGETS IPC handler) surface `failed > 0` as a reset
 *  failure instead of silently discarding it the way a bare
 *  `Promise.allSettled` would. */
export interface DeleteMatchingFilesResult {
  attempted: number
  failed: number
}

/** Shared body for `deleteFilesByPrefix`/`deleteFilesByExactName`: list,
 * filter by `predicate`, then delete every match with bounded
 * concurrency. Both callers still list-then-filter separately per
 * target rather than sharing one listing across a whole reset — resets
 * are a rare path, so that batching isn't worth the added complexity
 * here. */
async function deleteMatchingFiles(
  predicate: (file: DriveFile) => boolean,
  listOptions?: ListFilesOptions,
): Promise<DeleteMatchingFilesResult> {
  const files = await listFiles(listOptions)
  const matched = files.filter(predicate)
  const limit = pLimit(DELETE_CONCURRENCY)
  const results = await Promise.allSettled(
    matched.map((file) => limit(() => deleteFile(file.id))),
  )
  const failed = results.filter((r) => r.status === 'rejected').length
  return { attempted: matched.length, failed }
}

export async function deleteFilesByPrefix(prefix: string): Promise<DeleteMatchingFilesResult> {
  return deleteMatchingFiles((file) => file.name.startsWith(prefix))
}

/** Delete every remote file whose name matches `name` EXACTLY — unlike
 * `deleteFilesByPrefix`, this is for sync units with no subtree to
 * speak of (`key-labels.enc`, `typing-test-texts.enc`): a bare
 * `driveFileName(unit)` string has no trailing separator a prefix
 * match could safely anchor on, and a prefix match against it would
 * also catch any unrelated file that merely starts with the same
 * characters. Deletes ALL matching entries rather than looking up a
 * single id and deleting just that one — Drive keys files by id, not
 * name, so more than one file can legitimately share this exact name
 * (e.g. a stale duplicate left behind by a past upload race); a
 * find-first approach would silently leave such a duplicate behind.
 * Narrows the listing server-side via `nameContains` (the exact match
 * itself still happens client-side as a backstop, since `nameContains`
 * is a substring filter, not an equality one). */
export async function deleteFilesByExactName(name: string): Promise<DeleteMatchingFilesResult> {
  return deleteMatchingFiles((file) => file.name === name, { nameContains: name })
}
