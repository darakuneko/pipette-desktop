// SPDX-License-Identifier: GPL-2.0-or-later
//
// Sync entry points for the i18n pack store (pack-bundle-merge.ts).
//
// mergePackIndexBundle/mergePackBodyBundle own the LWW comparison
// (Drive modifiedTime vs local mtime for the body; nothing to own for
// the index anymore — see mergeSyncedIndex below) — these entry points
// only know how to apply an already-decided winning write. Routing the
// write through here (instead of pack-bundle-merge.ts joining
// userData/sync/i18n/... and calling writeFile itself, as it used to)
// gets two things pack-bundle-merge.ts cannot provide on its own:
// `isSafePackId` validation of a packId sourced from a remote Drive
// filename (least-trusted input), and `withIndexWriteLock` so a merge
// write can't land in the middle of this store's own read-modify-write
// cycle (save/rename/delete/reorder/purge) — which, combined with the
// old non-atomic write, is how a torn read could get persisted as an
// empty index over a real roster.

import { mkdir, stat, utimes } from 'node:fs/promises'
import { gcTombstones, mergeEntries, MalformedSyncBundleError } from './sync/merge'
import { log } from './logger'
import { isSafePackId } from './utils/safe-filename'
import { I18N_INDEX_SYNC_UNIT, type I18nPackMeta } from '../shared/types/i18n-store'
import {
  PACKS_DIRNAME,
  getIndexPath,
  getPackPath,
  getPacksDir,
  getStoreDir,
  isPackMetaCandidate,
  packSyncUnit,
  readIndex,
  withIndexWriteLock,
  writeFileAtomic,
} from './i18n-pack-store-internal'

/** Entry-level LWW merge + persist for a synced remote index. Replaces
 *  the old whole-file "remote newer wholesale-replaces local" strategy,
 *  which silently destroyed the other side's roster whenever two
 *  machines each installed a different pack while offline — see
 *  pack-bundle-merge.ts's `mergePackIndexBundle` doc for the full
 *  writeup. Reuses the exact same `mergeEntries`/`gcTombstones`
 *  machinery every other entry-based sync unit (favorites, key-labels,
 *  etc.) already relies on — `I18nPackMeta` carries the same
 *  id/filename/savedAt/updatedAt/deletedAt? shape `EntryMeta` requires.
 *  `preserveLocalOrder` is set because index order is user-meaningful
 *  (drag order), same as key-labels.
 *
 *  Reads, merges, and writes under the write lock as a single atomic
 *  step — not a separate outside-lock read followed by a decided
 *  "apply" call, which is what the old `applySyncedIndex(rawJson)`
 *  shape did. That gap let a concurrent local mutation
 *  (save/rename/delete/reorder) land between the caller's read and its
 *  write (TOCTOU); folding read→merge→write into one lock-held function
 *  closes it.
 *
 *  A remote meta whose `id` doesn't pass `isSafePackId` is dropped
 *  before merging (never persisted, never counted toward
 *  `remoteNeedsUpdate`) — a hostile id here would otherwise later flow
 *  through `collectAllSyncUnits` into a sync-unit string with more than
 *  the expected 3 `/`-separated segments, which `bundleSyncUnit`'s i18n
 *  pack branch would fail to match, falling through to the generic
 *  index-based tail and joining an attacker-chosen path into a
 *  filesystem read that gets bundled for upload. Kept metas also get
 *  their `filename` recomputed from the (now-validated) `id` rather than
 *  trusting whatever string the remote sent — `filename` is never
 *  actually used to build a filesystem path in this store (every path
 *  is derived from `id` via `getPackPath`), but there's no reason to
 *  persist an attacker-controlled string when the correct value is a
 *  one-line derivation.
 *
 *  The built-in English meta rides along in this same merge like any
 *  other entry: every machine creates it locally with its own
 *  first-seen timestamp (`ensureBuiltinEnglishEntry`), so two machines'
 *  copies differ only in `savedAt`/`updatedAt` — whichever side's
 *  per-id LWW wins is harmless, since the content (`name`/`version`/
 *  `enabled`) every machine generates is identical.
 *
 *  `remoteMetas` is typed `unknown[]` rather than `I18nPackMeta[]`
 *  because it is attacker-reachable data (a remote Drive file) whose
 *  shape is never actually guaranteed — a bare `metas: [null]` used to
 *  crash this function reading `m.id` off `null` before `isSafePackId`
 *  ever ran. `isPackMetaCandidate` treats any non-object entry the same
 *  way as a rejected id: dropped via the same unit-name-only warn path
 *  below, never thrown. The `metas` field not being an array at all is
 *  a stronger malformation than a bad element and is rejected one layer
 *  up, by `mergePackIndexBundle` (pack-bundle-merge.ts), which throws
 *  `MalformedSyncBundleError` before this function is even called — see
 *  its own doc for why that one is poll-skip-permanent rather than
 *  silently-filtered.
 *
 *  Returns `applied: false` (never throws) only on an I/O failure
 *  writing the merged index — never for a rejected meta, since those
 *  are silently filtered rather than failing the whole unit. */
export async function mergeSyncedIndex(
  remoteMetas: readonly unknown[],
): Promise<{ applied: boolean; remoteNeedsUpdate: boolean }> {
  return withIndexWriteLock(async () => {
    try {
      const localIndex = await readIndex()
      const rejectedCount = remoteMetas.filter((m) => !isPackMetaCandidate(m) || !isSafePackId(m.id)).length
      if (rejectedCount > 0) {
        log('warn', `sync: dropped ${rejectedCount} unsafe remote meta id(s) for ${I18N_INDEX_SYNC_UNIT}`)
      }
      const safeRemoteMetas = remoteMetas
        .filter((m): m is I18nPackMeta => isPackMetaCandidate(m) && isSafePackId(m.id))
        .map((m) => ({ ...m, filename: `${PACKS_DIRNAME}/${m.id}.json` }))
      const localMetas = gcTombstones(localIndex.metas)
      const remoteMetasGced = gcTombstones(safeRemoteMetas)
      const result = mergeEntries(localMetas, remoteMetasGced, { preserveLocalOrder: true })
      await mkdir(getStoreDir(), { recursive: true })
      await writeFileAtomic(getIndexPath(), JSON.stringify({ metas: result.entries }, null, 2))
      return { applied: true, remoteNeedsUpdate: result.remoteNeedsUpdate }
    } catch {
      return { applied: false, remoteNeedsUpdate: false }
    }
  })
}

/** Local mtime (ms) of a pack body file, or `null` when `packId` is
 *  unsafe or the file doesn't exist yet — either way there is no local
 *  clock to compare against, so the remote side trivially wins the LWW
 *  comparison. */
export async function statLocalPackMtime(packId: string): Promise<number | null> {
  if (!isSafePackId(packId)) return null
  try {
    const stats = await stat(getPackPath(packId))
    return stats.mtime.getTime()
  } catch {
    return null
  }
}

/** Outcome of `applySyncedPackBody`: `'applied'` (write landed),
 *  `'local-wins'` (the in-lock CAS re-check below found local is
 *  already newer-or-tied, so nothing was written), or `'io-error'` (a
 *  genuine, presumably-transient failure). Callers treat `'io-error'`
 *  as an ordinary retried sync failure and `'local-wins'` as "mark for
 *  re-upload, don't fail the unit" — see `mergePackBodyBundle`. */
export type ApplyPackBodyOutcome = 'applied' | 'local-wins' | 'io-error'

/** Apply an already-LWW-won remote pack body. Rejects an unsafe `packId`
 *  by THROWING `MalformedSyncBundleError` (defense in depth — the merge
 *  layer's own filename parsing should never produce one, but this is
 *  the boundary where a remote Drive filename, the least-trusted input
 *  in the sync pipeline, actually gets joined into a filesystem path).
 *  Throwing here (rather than returning `false`, as this used to) lets
 *  the sync poll's `instanceof MalformedSyncBundleError` check recognize
 *  this as a permanently-rejected revision and stop retrying it every 3
 *  minutes — a bare `Error` previously looked identical to a transient
 *  I/O failure, which the poll deliberately DOES keep retrying.
 *
 *  Re-checks the local pack file's mtime against `remoteModifiedTime`
 *  again HERE, under the lock, immediately before writing (a
 *  compare-and-swap): the caller's own LWW decision
 *  (`mergePackBodyBundle` in pack-bundle-merge.ts) reads local mtime
 *  OUTSIDE this lock, so a local save (`savePack`/`renamePack` — both
 *  lock-serialized) can land in the window between that read and this
 *  write acquiring the lock. If local is now `>=` the remote revision
 *  this call was about to apply, refuse the write and report
 *  `'local-wins'` instead of clobbering the fresher local save — the
 *  caller then marks the unit for re-upload rather than treating it as
 *  a failure.
 *
 *  On success, pins the written file's mtime to the remote's own
 *  `modifiedTime` rather than leaving it at "now" — without that, the
 *  very next LWW comparison would see the freshly written local copy as
 *  newer than the remote it was just copied from, re-upload it, and
 *  round-trip forever between any two devices that both hold this
 *  pack. The mtime pin is a SEPARATE try/catch from the body write
 *  above: the write already landed by the time we attempt this, so a
 *  utimes failure (e.g. a filesystem without utimes support) must not
 *  report `'io-error'` — that would fail the whole unit and re-enter
 *  this same clock-skew race on the very next poll, unbounded. Instead
 *  it's logged as a unit-name-only warn and treated as `'applied'`: the
 *  worst case is one redundant future re-upload of unchanged content,
 *  which is strictly better than an unbounded retry loop. Returns
 *  `'io-error'` (never throws for this case) on any OTHER I/O failure
 *  (i.e. the write itself) so the caller can surface it as an ordinary,
 *  retried, per-unit sync failure. */
export async function applySyncedPackBody(
  packId: string,
  rawJson: string,
  remoteModifiedTime: string,
): Promise<ApplyPackBodyOutcome> {
  if (!isSafePackId(packId)) {
    throw new MalformedSyncBundleError(packSyncUnit(packId))
  }
  return withIndexWriteLock(async () => {
    try {
      const path = getPackPath(packId)
      const modMs = new Date(remoteModifiedTime).getTime()
      if (!Number.isNaN(modMs)) {
        try {
          const currentStat = await stat(path)
          if (currentStat.mtime.getTime() >= modMs) return 'local-wins'
        } catch {
          // no local file yet — nothing to race against, proceed
        }
      }
      await mkdir(getPacksDir(), { recursive: true })
      await writeFileAtomic(path, rawJson)
      if (!Number.isNaN(modMs)) {
        try {
          const pinned = new Date(modMs)
          await utimes(path, pinned, pinned)
        } catch {
          log('warn', `sync: failed to pin mtime for ${packSyncUnit(packId)} after apply`)
        }
      }
      return 'applied'
    } catch {
      return 'io-error'
    }
  })
}

/** Pin a pack body file's mtime to the Drive `modifiedTime` a
 *  just-completed local-wins UPLOAD was assigned, closing a
 *  clock-skew gap: without this, the local file keeps its own
 *  wall-clock write time, which (if the local clock runs even slightly
 *  ahead of Drive's own clock) permanently looks "newer than the
 *  remote copy" — every subsequent sync pass would then re-upload this
 *  unchanged body, and every peer would re-download it, forever.
 *  Lock-scoped so it can't race a concurrent local save's own write of
 *  this same file.
 *
 *  `expectedLocalMtimeMs` is a compare-and-swap guard: the caller
 *  (`uploadSyncUnit`, sync-merge-dispatch.ts) snapshots the local file's mtime
 *  BEFORE bundling the content for upload — outside this store's write
 *  lock, since bundling/encrypting/uploading to Drive all happen
 *  without holding it. A user save (`savePack`/`renamePack`, both
 *  lock-serialized) can land in the window between that snapshot and
 *  this function actually acquiring the lock. Blindly pinning in that
 *  case would stamp the NEW content with the OLD upload's Drive time —
 *  the next LWW comparison then sees local and remote as tied, and the
 *  new edit never gets uploaded. So this re-checks the file's current
 *  mtime against the snapshot, under the lock, immediately before
 *  writing: only pin if nothing changed; otherwise skip (the newer
 *  edit's own upload will supersede this pin attempt). `null` means the
 *  caller had no local snapshot to compare (the pack body did not exist
 *  yet at snapshot time) — since there's nothing to safely CAS against,
 *  skip rather than guess.
 *
 *  Best-effort beyond the CAS check: swallows any I/O error (stat or
 *  utimes) with a unit-name-only warn, since a missed pin only costs a
 *  redundant re-upload on the next pass, not data loss. */
export async function pinPackBodyMtime(
  packId: string,
  modifiedTime: string,
  expectedLocalMtimeMs: number | null,
): Promise<void> {
  if (!isSafePackId(packId)) return
  await withIndexWriteLock(async () => {
    const modMs = new Date(modifiedTime).getTime()
    if (Number.isNaN(modMs)) return
    if (expectedLocalMtimeMs === null) {
      log('debug', `sync: skipped mtime pin for ${packSyncUnit(packId)} — no local snapshot to compare`)
      return
    }
    try {
      const path = getPackPath(packId)
      const currentStat = await stat(path)
      if (currentStat.mtime.getTime() !== expectedLocalMtimeMs) {
        log('debug', `sync: skipped mtime pin for ${packSyncUnit(packId)} — local file changed since upload snapshot`)
        return
      }
      const pinned = new Date(modMs)
      await utimes(path, pinned, pinned)
    } catch {
      log('warn', `sync: failed to pin mtime for ${packSyncUnit(packId)} after upload`)
    }
  })
}
