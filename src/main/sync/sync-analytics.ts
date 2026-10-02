// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze-panel-triggered typing-analytics sync: pulls + pushes one
// keyboard's analytics bundles on its own per-uid mutex, independent
// from the global sync lock.

import { listFiles, driveFilenamePrefix, syncUnitFromFileName } from './google-drive'
import { pLimit } from '../../shared/concurrency'
import { SYNC_CONCURRENCY, syncRuntime } from './sync-runtime-state'
import { requireSyncCredentials, ensurePasswordCheckValidated, listPasswordCheckFiles } from './sync-password'
import { localSyncBlock, remoteSyncBlock, listGuardFiles } from './sync-password-guard'
import { ensureSyncFormatMarker, syncFormatGeneration } from './sync-format'
import { mergeWithRemote, syncOrUpload } from './sync-merge-dispatch'
import { isAnalyticsSyncUnit, collectAnalyticsSyncUnitsForUid } from './sync-bundle'

/** Pull + push typing-analytics bundles for one keyboard, triggered
 * from the Analyze panel mount. Runs on its own per-uid mutex so
 * polling / manual sync stay untouched — the cloud file namespace is
 * disjoint (only `keyboards/{uid}/devices/*` is written) so there is
 * no conflict with the global `isSyncing` path.
 *
 * Returns true on a fully-successful pass so the caller can stamp a
 * rate-limit timestamp; returns false on skip (this uid is already
 * syncing, credentials are missing, a sync password change is in
 * progress, Drive needs a newer sync format, the sync-format marker
 * cannot be created, or the password-check does not open) or on any per-unit
 * failure so the caller can retry on the next Analyze mount. */
export async function executeAnalyticsSync(uid: string): Promise<boolean> {
  // A running password-change operation (sync-password-change.ts) holds
  // `passwordChangeRun`; it in turn refuses to start while any uid is in
  // `analyticsSyncingUids`. Both checks are synchronous, so the two never
  // overlap.
  if (syncRuntime.analyticsSyncingUids.has(uid) || syncRuntime.passwordChangeRun) return false
  syncRuntime.analyticsSyncingUids.add(uid)
  try {
    const credentials = await requireSyncCredentials()
    if (!credentials.ok) return false
    const password = credentials.password

    // The data listing below is name-filtered, so the lock, the sync-format
    // markers and the password-check are looked up with their own narrow
    // listings.
    if (await localSyncBlock()) return false
    const formatGeneration = syncFormatGeneration()
    const guardFiles = await listGuardFiles()
    if (remoteSyncBlock(guardFiles)) return false
    await ensureSyncFormatMarker(guardFiles, formatGeneration)
    await ensurePasswordCheckValidated(password, await listPasswordCheckFiles())

    // Drive-side prefix filter: scope the listing to this keyboard's
    // analytics files. The in-memory `isAnalyticsSyncUnit` + `startsWith`
    // checks below remain as a safety net in case Drive ever returns a
    // looser substring match.
    const prefix = `keyboards/${uid}/devices/`
    const remoteFiles = await listFiles({ nameContains: driveFilenamePrefix(prefix) })
    let anyFailure = false
    const limit = pLimit(SYNC_CONCURRENCY)
    // Units `mergeWithRemote` already handled — it uploads any
    // divergence internally, so the push pass can skip them.
    const mergedUnits = new Set<string>()

    await Promise.allSettled(
      remoteFiles.map((file) =>
        limit(async () => {
          const unit = syncUnitFromFileName(file.name)
          if (!unit || !isAnalyticsSyncUnit(unit)) return
          if (!unit.startsWith(prefix)) return
          try {
            await mergeWithRemote(file, unit, password, remoteFiles)
            mergedUnits.add(unit)
          } catch {
            anyFailure = true
          }
        }),
      ),
    )

    const localUnits = await collectAnalyticsSyncUnitsForUid(uid)
    await Promise.allSettled(
      localUnits
        .filter((unit) => !mergedUnits.has(unit))
        .map((unit) =>
          limit(async () => {
            try {
              await syncOrUpload(unit, password, remoteFiles)
            } catch {
              anyFailure = true
            }
          }),
        ),
    )

    return !anyFailure
  } catch {
    return false
  } finally {
    syncRuntime.analyticsSyncingUids.delete(uid)
  }
}
