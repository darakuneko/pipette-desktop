// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pass-level GC coordinator for i18n/theme pack stores. Runs each
// store's single-lock `runGcUnderLock()` (purge expired tombstones →
// sweep orphan pack bodies) for whichever store(s) a completed sync
// DOWNLOAD PASS actually touched.
//
// Binding: this must only ever be invoked once per whole pass (from
// `executeDownloadSync` in sync-execute.ts and `pollForRemoteChanges` in
// sync-polling.ts), NEVER from inside a single sync unit's own merge
// callback. The index unit (`i18n/index` / `themes/index`) and each pack-body unit
// (`i18n/packs/{id}` / `themes/packs/{id}`) merge in parallel with no
// ordering guarantee within a pass — a per-unit sweep triggered by
// whichever merge happens to finish first could delete a pack body
// file whose sibling index entry (the thing that would mark it
// "still active") simply hasn't landed yet, permanently losing a pack
// that was never actually orphaned.
//
// Failure rule: a store's SWEEP step is skipped when ANY sync unit
// belonging to that store's prefix failed in this pass — an index
// merge that failed to apply (or a pack body still mid-flight after a
// transient error) means the just-read index cannot be trusted as a
// complete "still active" roster, and sweeping against it risks
// deleting a body file for an entry that simply hasn't merged in yet.
// The PURGE step (tombstone expiry) still runs regardless — it only
// ever *removes* metas already past their own TTL and is index-only
// (no pack-body filesystem scan), so it stays safe and idempotent even
// when a sibling unit failed this pass.
//
// Pulled into its own module (rather than growing sync-service.ts
// further) per .claude/rules/file-splitting.md.

import { log } from '../logger'
import { runGcUnderLock as runI18nGc } from '../i18n-pack-store'
import { runGcUnderLock as runThemeGc } from '../theme-pack-store'
import { I18N_SYNC_UNIT_PREFIX } from '../../shared/types/i18n-store'
import { THEME_SYNC_UNIT_PREFIX } from '../../shared/types/theme-store'

interface PackGcStore {
  prefix: string
  /** Used only in the "pack-gc: {label} sweep failed: ..." warn log. */
  label: string
  runGc: (options?: { skipSweep?: boolean }) => Promise<{ purged: number; swept: number }>
}

const STORES: readonly PackGcStore[] = [
  { prefix: I18N_SYNC_UNIT_PREFIX, label: 'i18n', runGc: runI18nGc },
  { prefix: THEME_SYNC_UNIT_PREFIX, label: 'theme', runGc: runThemeGc },
]

function touchesPrefix(syncUnits: readonly string[], prefix: string): boolean {
  return syncUnits.some((unit) => unit.startsWith(prefix))
}

/**
 * Run post-pass GC for every pack store a just-completed download pass
 * attempted to merge (index or body — attempted rather than
 * strictly-succeeded is deliberate for deciding WHETHER to run GC at all;
 * `failedSyncUnits` then decides what GC is allowed to do once it runs —
 * see the module doc above for the sweep-skip rule). Never throws — a GC
 * failure is logged (unit-name-only, no bundle content) and does not fail
 * the sync pass that triggered it.
 */
export async function runPackGcAfterPass(
  attemptedSyncUnits: readonly string[],
  failedSyncUnits: readonly string[] = [],
): Promise<void> {
  const tasks = STORES
    .filter((store) => touchesPrefix(attemptedSyncUnits, store.prefix))
    .map((store) => {
      const skipSweep = touchesPrefix(failedSyncUnits, store.prefix)
      return store.runGc({ skipSweep }).catch((err: unknown) => {
        log('warn', `pack-gc: ${store.label} sweep failed: ${String(err)}`)
      })
    })

  await Promise.all(tasks)
}
