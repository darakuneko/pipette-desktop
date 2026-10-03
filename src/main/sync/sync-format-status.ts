// SPDX-License-Identifier: GPL-2.0-or-later
// The latest known sync-format status of the signed-in account's Drive,
// for the renderer's "update Pipette" banner. Filled by a markers-only
// listing (at startup and after sign-in, sync-ipc.ts) and by the sync
// guard whenever an entry point stops with `updateRequired`
// (sync-password-guard.ts); forgotten on sign-out and sign-in. Null means
// unknown. Every change is reported to the listener (sync-ipc.ts sends it
// to the renderer).
//
// Two counters keep stale results out:
// - The sign-out generation (`syncFormatGeneration`, sync-format.ts):
//   `clearSyncFormatStatus` bumps it, so a listing or a blocked pass that
//   started for the previous account records nothing.
// - `version`, bumped by every write: a refresh result is stored only
//   when nothing was recorded since the refresh started, so a slow
//   listing can't overwrite a newer block.

import { getSyncFormatStatus, syncFormatGeneration, forgetCreatedSyncFormatMarker } from './sync-format'
import { SYNC_FORMAT_VERSION } from '../../shared/constants/sync-format'
import type { SyncFormatStatus } from '../../shared/types/sync'
import { log } from '../logger'

type Listener = (status: SyncFormatStatus | null) => void

let cached: SyncFormatStatus | null = null
let version = 0
let refreshing: Promise<SyncFormatStatus | null> | null = null
let listener: Listener | null = null

function sameStatus(a: SyncFormatStatus | null, b: SyncFormatStatus | null): boolean {
  if (a === null || b === null) return a === b
  return a.required === b.required && a.supported === b.supported && a.updateRequired === b.updateRequired
}

function store(status: SyncFormatStatus | null): void {
  version++
  if (sameStatus(cached, status)) return
  cached = status
  listener?.(status)
}

/** Called with the new status (null once forgotten) whenever it changes. */
export function setSyncFormatStatusListener(next: Listener | null): void {
  listener = next
}

export function getCachedSyncFormatStatus(): SyncFormatStatus | null {
  return cached
}

/** Lists the markers on Drive and stores the result. Never throws: a
 *  failure is logged and the current status (possibly null) is returned.
 *  Calls made while a listing is in flight share it. */
export function refreshSyncFormatStatus(): Promise<SyncFormatStatus | null> {
  if (refreshing) return refreshing
  const startedIn = syncFormatGeneration()
  const startedAt = version
  const run = getSyncFormatStatus().then(
    (status) => {
      if (syncFormatGeneration() === startedIn && version === startedAt) store(status)
    },
    (err: unknown) => {
      log('warn', `sync-format: status check failed: ${String(err)}`)
    },
  ).then(() => {
    if (refreshing === run) refreshing = null
    return syncFormatGeneration() === startedIn ? cached : null
  })
  refreshing = run
  return run
}

/** Forgets the status, any listing in flight and the marker this process
 *  created (sign-out, sign-in): the next account's Drive is checked afresh. */
export function clearSyncFormatStatus(): void {
  forgetCreatedSyncFormatMarker()
  refreshing = null
  store(null)
}

/** Records that an entry point found a marker `required` newer than this
 *  app's. `generation` is `syncFormatGeneration()` taken before the
 *  entry point's listing was requested. */
export function noteSyncFormatUpdateRequired(required: number | null, generation: number): void {
  if (generation !== syncFormatGeneration()) return
  store({ required, supported: SYNC_FORMAT_VERSION, updateRequired: true })
}
