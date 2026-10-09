// SPDX-License-Identifier: GPL-2.0-or-later
// Google Drive API client for appDataFolder

import { getAccessToken } from './google-auth'
import { driveRequest } from './drive-retry'
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
  /** RFC 3339 time Drive assigned when the file was created. Optional
   *  because a listing that does not request the field omits it. */
  createdTime?: string
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
  const files: DriveFile[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      fields: 'nextPageToken, files(id, name, modifiedTime, createdTime)',
      pageSize: '1000',
    })
    const filter = options?.nameContains
    if (filter) {
      const escaped = filter.replace(/'/g, "\\'")
      params.set('q', `name contains '${escaped}'`)
    }
    if (pageToken) params.set('pageToken', pageToken)

    const { text } = await driveRequest({
      label: 'list',
      getHeaders: authHeaders,
      send: (headers) => fetch(`${DRIVE_API}/files?${params}`, { headers }),
      retryTransient: true,
    })

    const data = JSON.parse(text) as { files?: DriveFile[]; nextPageToken?: string }
    files.push(...(data.files ?? []))
    pageToken = data.nextPageToken
  } while (pageToken)

  return files
}

/** Downloads a file's content as text, without parsing it. */
export async function downloadRawFile(fileId: string): Promise<string> {
  const params = new URLSearchParams({ alt: 'media' })

  const { text } = await driveRequest({
    label: 'download',
    getHeaders: authHeaders,
    send: (headers) => fetch(`${DRIVE_API}/files/${fileId}?${params}`, { headers }),
    retryTransient: true,
  })

  return text
}

export async function downloadFile(fileId: string): Promise<SyncEnvelope> {
  return JSON.parse(await downloadRawFile(fileId)) as SyncEnvelope
}

export interface UploadedFile {
  id: string
  /** Drive's own `modifiedTime` for the revision this call just wrote.
   *  The uploader records it as the revision this machine last handled
   *  (`recordRemoteState`, sync-runtime-state.ts), so the next poll does
   *  not take its own upload for a remote change. */
  modifiedTime: string
}

export interface UploadFileOptions {
  /** When the update of `existingFileId` gets 404 (the file is gone), create
   *  the file instead of failing. For an id remembered from an earlier
   *  create rather than taken from a listing. */
  createIfMissing?: boolean
}

/** Updates `existingFileId`, or creates `name` when no id is given (or, with
 *  `createIfMissing`, when that id no longer exists). The returned id is
 *  the file actually written. */
export async function uploadFile(
  name: string,
  envelope: SyncEnvelope,
  existingFileId?: string,
  options?: UploadFileOptions,
): Promise<UploadedFile> {
  const content = JSON.stringify(envelope)

  if (existingFileId) {
    // Update existing file. `fields` is requested explicitly — the
    // default response for a media-upload PATCH omits `modifiedTime`.
    const { status, text } = await driveRequest({
      label: 'update',
      getHeaders: authHeaders,
      send: (headers) =>
        fetch(`${UPLOAD_API}/files/${existingFileId}?uploadType=media&fields=id,modifiedTime`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: content,
        }),
      retryTransient: true,
      acceptStatus: options?.createIfMissing ? (code) => code === 404 : undefined,
    })
    if (status !== 404) return JSON.parse(text) as UploadedFile
  }

  // `fields` requested explicitly — same reasoning as the update path above.
  const text = await createAppDataFile(name, content, 'id,modifiedTime')
  return JSON.parse(text) as UploadedFile
}

/** Creates a new appDataFolder file whose content is `content` as is (no
 *  sync envelope) and returns the id Drive assigned. */
export async function createRawFile(name: string, content: string): Promise<{ id: string }> {
  const text = await createAppDataFile(name, content, 'id')
  const { id } = JSON.parse(text) as { id: string }
  return { id }
}

/** Multipart create in appDataFolder; resolves with the response body
 *  restricted to `fields`. */
async function createAppDataFile(name: string, content: string, fields: string): Promise<string> {
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

  // Only rate-limit responses are retried here: after a 5xx or a network
  // error the file may already have been created, and sending the create
  // again would leave two files with the same name.
  const { text } = await driveRequest({
    label: 'upload',
    getHeaders: authHeaders,
    send: (headers) =>
      fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=${fields}`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      }),
    retryTransient: false,
  })

  return text
}

export async function deleteFile(fileId: string): Promise<void> {
  // A 404 means the file is already gone, which is what the caller wants.
  await driveRequest({
    label: 'delete',
    getHeaders: authHeaders,
    send: (headers) => fetch(`${DRIVE_API}/files/${fileId}`, { method: 'DELETE', headers }),
    retryTransient: true,
    acceptStatus: (status) => status === 404,
  })
}

/** Renames `fileId` to `name` (a metadata-only PATCH; the content is not
 *  touched). Resolves with the renamed file, or null when it no longer
 *  exists. Safe to retry: renaming to the same name again changes nothing. */
export async function renameFile(fileId: string, name: string): Promise<DriveFile | null> {
  const { status, text } = await driveRequest({
    label: 'rename',
    getHeaders: authHeaders,
    send: (headers) =>
      fetch(`${DRIVE_API}/files/${fileId}?fields=id,name,modifiedTime`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    retryTransient: true,
    acceptStatus: (code) => code === 404,
  })
  if (status === 404) return null
  return JSON.parse(text) as DriveFile
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

/** Sync unit of the encrypted password-check sentinel file. Its envelope
 *  carries this as `syncUnit`, but it is a credential check, not data. */
export const PASSWORD_CHECK_UNIT = 'password-check'

/** Unencrypted lock a machine holds while it re-encrypts every remote file
 *  under a new sync password (sync-password-lock.ts). */
export const PASSWORD_CHANGE_LOCK_FILE = 'password-change-lock.json'

export function isPasswordChangeLockFile(name: string): boolean {
  return name === PASSWORD_CHANGE_LOCK_FILE
}

/** Name prefix of the unencrypted sync-format markers (sync-format.ts);
 *  also the `nameContains` filter that lists only them. */
export const SYNC_FORMAT_FILE_PREFIX = 'sync-format-v'

const SYNC_FORMAT_FILE_PATTERN = /^sync-format-v(\d+)\.json$/

export function syncFormatFileName(version: number): string {
  return `${SYNC_FORMAT_FILE_PREFIX}${version}.json`
}

/** The `n` of a `sync-format-v{n}.json` marker name; null for any other name. */
export function parseSyncFormatFileName(name: string): number | null {
  const match = SYNC_FORMAT_FILE_PATTERN.exec(name)
  if (!match) return null
  const version = Number(match[1])
  return Number.isSafeInteger(version) ? version : null
}

/** Whether a listed file holds encrypted user data, i.e. is none of the
 *  password-check sentinel, the password-change lock and the sync-format
 *  markers. Listings keep them so sync entry points can see them; data
 *  handling filters with this. */
export function isDataFileName(name: string): boolean {
  return (
    name !== driveFileName(PASSWORD_CHECK_UNIT) &&
    !isPasswordChangeLockFile(name) &&
    parseSyncFormatFileName(name) === null
  )
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

  // "keyboards_0x1234_devices_{hash}_deleted-ranges.enc"
  //   → "keyboards/0x1234/devices/{hash}/deleted-ranges"
  const rangesMatch = fileName.match(/^keyboards_(.+?)_devices_(.+?)_deleted-ranges\.enc$/)
  if (rangesMatch) return `keyboards/${rangesMatch[1]}/devices/${rangesMatch[2]}/deleted-ranges`

  // "keyboards_0x1234_settings.enc" → "keyboards/0x1234/settings"
  // "keyboards_0x1234_snapshots.enc" → "keyboards/0x1234/snapshots"
  // "keyboards_0x1234_runs.enc" → "keyboards/0x1234/runs" (per-run raw
  // keystroke log)
  // "keyboards_0x1234_analyze_filters.enc" → "keyboards/0x1234/analyze_filters"
  // The uid capture is non-greedy, so this alternation is only unambiguous as
  // long as no future store name here is itself a suffix-composition of
  // another store name in this list (e.g. adding a bare 'filters' store
  // would collide with 'analyze_filters') — pick distinct names.
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
  // it's a standalone credential-validation file (PASSWORD_CHECK_UNIT
  // above), not a data sync unit, and must stay invisible
  // to scanRemoteData / polling / fresh-machine discovery.

  return null
}

/** Outcome of a delete batch: `attempted` is how many files it tried to
 *  delete (0 is a legitimate "nothing to delete", not a failure); `failed`
 *  is how many of those rejected. Callers (the SYNC_RESET_TARGETS and
 *  SYNC_DELETE_FILES IPC handlers) surface `failed > 0` as a failure
 *  instead of silently discarding it the way a bare `Promise.allSettled`
 *  would. */
export interface DeleteMatchingFilesResult {
  attempted: number
  failed: number
  /** Message of the first rejected delete; absent when none failed. */
  firstError?: string
}

/** Deletes every file in `fileIds` with bounded concurrency. A rejected
 *  delete does not stop the others; each rejection is logged. */
export async function deleteFilesById(fileIds: readonly string[]): Promise<DeleteMatchingFilesResult> {
  const limit = pLimit(DELETE_CONCURRENCY)
  const results = await Promise.allSettled(fileIds.map((id) => limit(() => deleteFile(id))))
  const reasons: string[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') return
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
    console.warn(`[google-drive] delete of ${fileIds[i]} failed: ${reason}`)
    reasons.push(reason)
  })
  return { attempted: fileIds.length, failed: reasons.length, firstError: reasons[0] }
}

/** Deletes every remote file whose name starts with `prefix`; a trash
 *  file (drive-trash.ts) starts with its original name, so it goes too.
 *  Each reset target lists separately rather than sharing one listing
 *  across a whole reset — resets are a rare path. */
export async function deleteFilesByPrefix(prefix: string): Promise<DeleteMatchingFilesResult> {
  const files = await listFiles()
  return deleteFilesById(files.filter((file) => file.name.startsWith(prefix)).map((file) => file.id))
}
