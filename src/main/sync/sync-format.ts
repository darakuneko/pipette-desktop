// SPDX-License-Identifier: GPL-2.0-or-later
// Sync-format markers: unencrypted `sync-format-v{n}.json` files in
// appDataFolder that say which sync format the data on Drive needs.
//
// - The required version is the largest `n` listed. An app whose
//   SYNC_FORMAT_VERSION is smaller stops syncing (`updateRequired` in
//   sync-password-guard.ts). Only names count: the content
//   (`{ "type": "sync-format", "version": n }`) is there for anyone
//   inspecting the Drive and is never read.
// - Every pass that may write creates our own marker before touching any
//   data, so data in our format never sits on Drive without it. No file is
//   ever rewritten, so two machines syncing at once cannot lower the
//   required version.
// - Smaller markers are deleted only once our own marker is listed: a
//   just-created marker can be missing from listings for a while, and
//   deleting the smaller ones then would show other machines no marker.
//   Markers with `n` >= ours are never deleted.

import {
  listFiles,
  createRawFile,
  deleteFile,
  parseSyncFormatFileName,
  syncFormatFileName,
  SYNC_FORMAT_FILE_PREFIX,
  type DriveFile,
} from './google-drive'
import { syncRuntime } from './sync-runtime-state'
import { SYNC_FORMAT_VERSION } from '../../shared/constants/sync-format'
import { log } from '../logger'

/** `createdMemoryMs`: how long a marker this process created that no
 *  listing shows yet still counts as present (Drive's listing lag), so it
 *  is not created a second time. Exported so tests can replace the clock. */
export const syncFormatTiming = {
  createdMemoryMs: 5 * 60 * 1000,
  now: (): number => Date.now(),
}

/** The largest marker version in `listing`; null when it has no marker. */
export function requiredSyncFormat(listing: DriveFile[]): number | null {
  let required: number | null = null
  for (const file of listing) {
    const version = parseSyncFormatFileName(file.name)
    if (version !== null && (required === null || version > required)) required = version
  }
  return required
}

/** Whether `listing` holds a marker newer than this app's sync format. */
export function isSyncFormatUpdateRequired(listing: DriveFile[]): boolean {
  return (requiredSyncFormat(listing) ?? 0) > SYNC_FORMAT_VERSION
}

/** A listing of just the markers, for entry points whose own listing is
 *  name-filtered. `nameContains` is a substring match, so the exact name
 *  pattern is applied as well. */
export async function listSyncFormatFiles(): Promise<DriveFile[]> {
  const files = await listFiles({ nameContains: SYNC_FORMAT_FILE_PREFIX })
  return files.filter((file) => parseSyncFormatFileName(file.name) !== null)
}

/** Forgets the marker this process created (and any creation in flight),
 *  for sign-out: the next account's Drive is checked afresh. */
export function forgetCreatedSyncFormatMarker(): void {
  syncRuntime.syncFormatMarkerGeneration++
  syncRuntime.syncFormatMarkerCreatedAt = null
  syncRuntime.syncFormatMarkerSeenAt = null
  syncRuntime.syncFormatMarkerCreating = null
}

/** The current sign-out generation; see `ensureSyncFormatMarker`. */
export function syncFormatGeneration(): number {
  return syncRuntime.syncFormatMarkerGeneration
}

function isRecent(at: number | null): boolean {
  return at !== null && syncFormatTiming.now() - at < syncFormatTiming.createdMemoryMs
}

function recentlyCreatedOwnMarker(): boolean {
  const createdAt = syncRuntime.syncFormatMarkerCreatedAt
  if (createdAt === null) return false
  if (syncFormatTiming.now() - createdAt < syncFormatTiming.createdMemoryMs) return true
  syncRuntime.syncFormatMarkerCreatedAt = null
  return false
}

/** Creates our marker, or waits for the creation already in flight. A
 *  failed create is not retried here (createRawFile only retries rate
 *  limits): the caller's pass stops and the next pass tries again. */
async function createOwnMarkerOnce(generation: number): Promise<void> {
  const inFlight = syncRuntime.syncFormatMarkerCreating
  if (inFlight) return inFlight
  const content = JSON.stringify({ type: 'sync-format', version: SYNC_FORMAT_VERSION })
  const run = createRawFile(syncFormatFileName(SYNC_FORMAT_VERSION), content).then(() => {
    if (syncRuntime.syncFormatMarkerGeneration === generation) {
      syncRuntime.syncFormatMarkerCreatedAt = syncFormatTiming.now()
    }
  })
  syncRuntime.syncFormatMarkerCreating = run
  const settle = (): void => {
    if (syncRuntime.syncFormatMarkerCreating === run) syncRuntime.syncFormatMarkerCreating = null
  }
  run.then(settle, settle)
  return run
}

/** Best effort: a smaller marker left behind changes nothing, since only
 *  the largest one decides. */
async function deleteOlderMarkers(listing: DriveFile[]): Promise<void> {
  for (const file of listing) {
    const version = parseSyncFormatFileName(file.name)
    if (version === null || version >= SYNC_FORMAT_VERSION) continue
    try {
      await deleteFile(file.id)
    } catch (err) {
      log('warn', `sync-format: cannot delete ${file.name}: ${String(err)}`)
    }
  }
}

/** Run by every entry point that may write to Drive, after the guard
 *  passed and before any data is read or written. `listing` must include
 *  the markers (an unfiltered listing, or `listSyncFormatFiles`). Throws
 *  when our marker is missing and cannot be created; the pass must then
 *  stop without writing data. `generation` is `syncFormatGeneration()`
 *  taken before `listing` was requested, so a sign-out during the listing
 *  leaves nothing remembered. */
export async function ensureSyncFormatMarker(listing: DriveFile[], generation: number): Promise<void> {
  const ownName = syncFormatFileName(SYNC_FORMAT_VERSION)
  if (listing.some((file) => file.name === ownName)) {
    if (syncRuntime.syncFormatMarkerGeneration === generation) {
      syncRuntime.syncFormatMarkerCreatedAt = null
      syncRuntime.syncFormatMarkerSeenAt = syncFormatTiming.now()
    }
    await deleteOlderMarkers(listing)
    return
  }
  if (recentlyCreatedOwnMarker()) return
  await createOwnMarkerOnce(generation)
}

/** `ensureSyncFormatMarker` for a write whose caller may hold only a
 *  name-filtered listing (creating the password-check): skipped when our
 *  marker was created or listed within `createdMemoryMs`, otherwise run on
 *  a markers-only listing. */
export async function ensureSyncFormatMarkerKnown(): Promise<void> {
  if (isRecent(syncRuntime.syncFormatMarkerSeenAt) || recentlyCreatedOwnMarker()) return
  const generation = syncFormatGeneration()
  await ensureSyncFormatMarker(await listSyncFormatFiles(), generation)
}

export interface SyncFormatStatus {
  /** Largest marker version on Drive; null when Drive has none. */
  required: number | null
  supported: number
  updateRequired: boolean
}

/** The markers on Drive compared with this app's sync format. Lists only
 *  the markers; Drive errors propagate. */
export async function getSyncFormatStatus(): Promise<SyncFormatStatus> {
  const markers = await listSyncFormatFiles()
  return {
    required: requiredSyncFormat(markers),
    supported: SYNC_FORMAT_VERSION,
    updateRequired: isSyncFormatUpdateRequired(markers),
  }
}
