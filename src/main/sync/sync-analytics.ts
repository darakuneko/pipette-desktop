// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze-panel-triggered typing-analytics sync: pulls + pushes one
// keyboard's analytics bundles on its own per-uid mutex, independent
// from the global sync lock. Split out of sync-service.ts to keep it
// under the project's 800-line Service/Util size ceiling.

import { listFiles, driveFilenamePrefix, syncUnitFromFileName } from './google-drive'
import { pLimit } from '../../shared/concurrency'
import { SYNC_CONCURRENCY } from './sync-runtime-state'
import { requireSyncCredentials } from './sync-password'
import { mergeWithRemote, syncOrUpload } from './sync-merge-dispatch'
import { isAnalyticsSyncUnit, collectAnalyticsSyncUnitsForUid } from './sync-bundle'

/** Per-uid mutex so switching between keyboards while the previous
 * sync is still running doesn't immediately skip the new uid. Uses
 * a Set instead of a single flag so `uid-a` and `uid-b` can proceed
 * in parallel — the cloud file namespace (`keyboards/{uid}/devices/*`)
 * is disjoint across uids so there is no conflict. */
const analyticsSyncingUids = new Set<string>()

/** Pull + push typing-analytics bundles for one keyboard, triggered
 * from the Analyze panel mount. Runs on its own per-uid mutex so
 * polling / manual sync stay untouched — the cloud file namespace is
 * disjoint (only `keyboards/{uid}/devices/*` is written) so there is
 * no conflict with the global `isSyncing` path.
 *
 * Returns true on a fully-successful pass so the caller can stamp a
 * rate-limit timestamp; returns false on skip (this uid is already
 * syncing or credentials are missing) or on any per-unit failure so
 * the caller can retry on the next Analyze mount. */
export async function executeAnalyticsSync(uid: string): Promise<boolean> {
  if (analyticsSyncingUids.has(uid)) return false
  analyticsSyncingUids.add(uid)
  try {
    const credentials = await requireSyncCredentials()
    if (!credentials.ok) return false
    const password = credentials.password

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
    analyticsSyncingUids.delete(uid)
  }
}
