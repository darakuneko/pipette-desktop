// SPDX-License-Identifier: GPL-2.0-or-later
// Merge strategies for the i18n/theme index + pack-body bundle shapes.
// Split out of sync-service.ts so these bundle-variant merge branches
// don't push it past the project's 800-line Service/Util size ceiling.
//
// This module owns only the merge/LWW decision and the post-write
// broadcast — every path/mkdir/writeFile concern lives in
// i18n-pack-store.ts / theme-pack-store.ts's own sync-facing entry
// points (`mergeSyncedIndex`/`applySyncedPackBody`/`statLocalPackMtime`/
// `pinPackBodyMtime`), so a packId sourced from a remote Drive filename
// (the least-trusted input in the sync pipeline) is always validated at
// the same boundary the store already guards its own writes with.
//
// Import-cycle note: this module imports from i18n-pack-store.ts /
// theme-pack-store.ts, which each import `notifyChange` from
// `./sync-service`, whose facade re-exports transitively pull in
// `sync-merge-dispatch.ts`, which imports from this module — a cycle.
// This is the same shape sync-bundle.ts already has via
// key-label-store.ts (sync-service → sync-bundle → key-label-store →
// sync-service) and is inert here for the same reason: every import is
// only used inside a function body, never at module-evaluation time.

import { IpcChannels } from '../../shared/ipc/channels'
import { broadcastToAllWindows } from '../utils/broadcast'
import { safeTimestamp, MalformedSyncBundleError } from './merge'
import { I18N_SYNC_UNIT_PREFIX } from '../../shared/types/i18n-store'
import { THEME_SYNC_UNIT_PREFIX, THEME_INDEX_SYNC_UNIT } from '../../shared/types/theme-store'
import {
  mergeSyncedIndex as mergeSyncedI18nIndex,
  statLocalPackMtime as statLocalI18nPackMtime,
  applySyncedPackBody as applySyncedI18nPackBody,
  pinPackBodyMtime as pinI18nPackBodyMtime,
} from '../i18n-pack-store'
import {
  mergeSyncedIndex as mergeSyncedThemeIndex,
  statLocalPackMtime as statLocalThemePackMtime,
  applySyncedPackBody as applySyncedThemePackBody,
  pinPackBodyMtime as pinThemePackBodyMtime,
} from '../theme-pack-store'
import type { SyncBundle } from '../../shared/types/sync'

/** `i18n/packs/{packId}` / `themes/packs/{packId}` parsed once — the
 *  shape every caller in this module and sync-merge-dispatch.ts needs, instead
 *  of each re-splitting `syncUnit` and re-deriving `isTheme` on its own. */
export interface PackBodySyncUnit {
  isTheme: boolean
  packId: string
}

/** Parses `"i18n/packs/{packId}"` / `"themes/packs/{packId}"` into a
 *  descriptor, or `null` for any other shape (including the bare index
 *  units, handled separately by `mergePackIndexBundle`). */
export function parsePackBodySyncUnit(syncUnit: string): PackBodySyncUnit | null {
  const i18nPrefix = `${I18N_SYNC_UNIT_PREFIX}packs/`
  const themePrefix = `${THEME_SYNC_UNIT_PREFIX}packs/`
  const isTheme = syncUnit.startsWith(themePrefix)
  const isI18n = !isTheme && syncUnit.startsWith(i18nPrefix)
  if (!isI18n && !isTheme) return null
  const packId = syncUnit.slice((isTheme ? themePrefix : i18nPrefix).length)
  if (!packId) return null
  return { isTheme, packId }
}

/** Broadcast the same "pack list changed" event `theme-pack-ipc.ts`'s
 * own mutating handlers fire after a local save/rename/delete, and
 * `i18n-startup-sync.ts` fires after its Hub reconcile. Unlike themes,
 * `i18n-pack-ipc.ts` itself never broadcasts `I18N_PACK_CHANGED` on a
 * local mutation — the window that issued the IPC call already has the
 * fresh data from that call's own return value, so only the
 * cross-process paths (this merge, and the Hub startup reconcile) need
 * to tell OTHER windows. mergePackIndexBundle/mergePackBodyBundle apply
 * an already-merged/already-decided write via the stores' own
 * `mergeSyncedIndex`/`applySyncedPackBody` (not their local
 * read-modify-write helpers, which assume the mutation originated from
 * an IPC call in this same process) — so any open language/theme picker
 * still needs this broadcast to know new content is on disk. No
 * `notifyChange` call here: this merge already decided the correct
 * persisted state (a union that may still need uploading, signalled via
 * this function's own return value / `remoteNeedsUpdate` — not via
 * re-queueing through `notifyChange`). */
function broadcastPackChanged(isTheme: boolean): void {
  broadcastToAllWindows(isTheme ? IpcChannels.THEME_PACK_CHANGED : IpcChannels.I18N_PACK_CHANGED)
}

/**
 * Entry-level LWW merge for "i18n/index" / "themes/index". Delegates
 * the actual read→merge→write to the store's own `mergeSyncedIndex`
 * (i18n-pack-store.ts / theme-pack-store.ts), which runs it as a single
 * step under that store's write lock — this function only picks which
 * store to call and translates the result into the return convention
 * every `mergeSyncUnit` branch shares (`true` = local has data remote
 * still needs, i.e. re-upload the unit).
 *
 * This used to be file-level LWW (whichever side had the newer
 * `metas[].updatedAt`/`savedAt` won wholesale, and the other side's
 * entire roster was discarded). That was a data-loss bug: two machines
 * that each installed a different pack while offline would
 * deterministically erase one of the two packs everywhere once both
 * had synced — whichever machine uploaded second overwrote the cloud
 * roster, and the first machine's next poll then overwrote its own
 * local roster with that incomplete cloud copy, permanently losing its
 * own pack (its body file became an orphan, unreachable because
 * `collectAllSyncUnits` only enumerates pack ids that appear in the
 * index). Entry-level LWW does not have this failure mode: each pack's
 * meta is merged independently by id, so an install on one machine and
 * a concurrent install on another both survive the merge as a union,
 * and only an actual same-id conflict (e.g. two ids that happen to
 * collide, or a delete racing an edit) is resolved by comparing that
 * one id's own timestamps — never by discarding an unrelated id's
 * entry just because it arrived on the "losing" side of the whole
 * file.
 *
 * The built-in English meta (i18n only) rides along in this merge like
 * any other entry and needs no special-casing: every machine creates it
 * locally with its own first-seen timestamp, so two copies differ only
 * in `savedAt`/`updatedAt` — whichever wins that id's own LWW comparison
 * is harmless, since the content every machine generates is identical.
 *
 * `remoteBundle.index.metas` not being an array at all (a stronger
 * malformation than a bad individual element, which the stores' own
 * `mergeSyncedIndex` filters per-entry instead) throws
 * `MalformedSyncBundleError` here rather than silently defaulting to an
 * empty array — the latter used to make a corrupt remote index look
 * like a legitimately-empty one, which the sync poll's `instanceof`
 * check couldn't distinguish from "nothing to merge" to apply its
 * permanently-rejected-revision skip. This mirrors the generic
 * index-based tail in sync-merge-dispatch.ts, which throws the same way for a
 * non-array `.entries`.
 */
export async function mergePackIndexBundle(
  syncUnit: string,
  remoteBundle: SyncBundle,
): Promise<boolean> {
  const isTheme = syncUnit === THEME_INDEX_SYNC_UNIT
  const remoteMetasRaw = (remoteBundle.index as { metas?: unknown } | undefined)?.metas
  if (!Array.isArray(remoteMetasRaw)) {
    throw new MalformedSyncBundleError(syncUnit)
  }

  const result = isTheme
    ? await mergeSyncedThemeIndex(remoteMetasRaw)
    : await mergeSyncedI18nIndex(remoteMetasRaw)

  if (!result.applied) {
    throw new Error(`sync: failed to persist merged ${syncUnit} index`)
  }
  broadcastPackChanged(isTheme)
  return result.remoteNeedsUpdate
}

/** True when the local pack-body file is already strictly newer than
 *  the remote Drive file's `modifiedTime` — i.e. `mergePackBodyBundle`'s
 *  own comparison would end in "local wins" without needing to look at
 *  the bundle at all. `mergeWithRemote` (sync-merge-dispatch.ts) consults this
 *  BEFORE downloading + decrypting the full remote bundle, so a manual
 *  'all'-scope sync doesn't pay that cost for every pack whose local
 *  copy is already known to be newer. A tie or a remote win both return
 *  `false` here — the caller falls through to the normal download path,
 *  which is the only place that actually applies a remote write. */
export async function packBodyLocalWins(
  ref: PackBodySyncUnit,
  remoteModifiedTime: string,
): Promise<boolean> {
  const localTime = await statPackBodyLocalMtime(ref)
  if (localTime === null) return false
  return localTime > safeTimestamp(remoteModifiedTime)
}

/** Local mtime (ms) of the pack body `ref` refers to, or `null` if it's
 *  unsafe or doesn't exist yet. Exposed so `uploadSyncUnit`
 *  (sync-merge-dispatch.ts) can snapshot the mtime BEFORE bundling the body for
 *  upload — that snapshot is later passed to `pinPackBodyMtimeAfterUpload`
 *  as its compare-and-swap baseline, see that function's doc. */
export async function statPackBodyLocalMtime(ref: PackBodySyncUnit): Promise<number | null> {
  return ref.isTheme
    ? statLocalThemePackMtime(ref.packId)
    : statLocalI18nPackMtime(ref.packId)
}

/**
 * File-level LWW merge for "i18n/packs/{id}" / "themes/packs/{id}".
 * The pack body itself carries no timestamp (it's the raw pack JSON,
 * meant to round-trip byte-for-byte with export/import), and the
 * bundle's `index` is a trivial `{ metas: [] }` placeholder for this
 * unit (see sync-bundle.ts's bundleSyncUnit) — so unlike the index
 * bundle above, there is no per-entry timestamp to compare here.
 * Instead: remote side uses the Drive file's own `modifiedTime`, local
 * side uses the pack file's filesystem mtime (pinned to the remote's
 * `modifiedTime` on a prior remote-win by `applySyncedPackBody`, or to
 * the upload response's own `modifiedTime` on a prior local-win — see
 * `pinPackBodyMtimeAfterUpload`). Rejected alternative — reconciling
 * against the sibling index's per-id `updatedAt` — was not used because
 * a remote-only-so-far merge of this unit can race the index unit's own
 * merge (they're separate sync units, downloaded in parallel), so the
 * index's meta for this id is not guaranteed to be present locally yet
 * when this function runs.
 *
 * The snapshot of `localTime` taken here (via `statLocalPackMtime`) is
 * read OUTSIDE the store's write lock — a concurrent local save
 * (savePack/renamePack, both lock-serialized in the store) can land
 * between that read and `applySyncedPackBody` actually acquiring the
 * lock to write. `applySyncedPackBody` re-checks the same comparison
 * again itself, under its lock, immediately before writing (a
 * compare-and-swap) and reports `'local-wins'` instead of clobbering a
 * fresher local save if the race occurred — handled below by marking
 * the unit for re-upload rather than treating it as a failure.
 */
export async function mergePackBodyBundle(
  ref: PackBodySyncUnit,
  remoteBundle: SyncBundle,
  remoteModifiedTime: string,
): Promise<boolean> {
  const { isTheme, packId } = ref
  const remoteContent = remoteBundle.files[`${packId}.json`]
  if (!remoteContent) return false

  const remoteTime = safeTimestamp(remoteModifiedTime)
  const localMtime = isTheme
    ? await statLocalThemePackMtime(packId)
    : await statLocalI18nPackMtime(packId)
  const localTime = localMtime ?? 0

  if (remoteTime <= localTime) {
    // Local already newer-or-tied at this snapshot — no write. A tie
    // keeps local as-is (no reupload); local strictly newer reports
    // `true` so the caller re-uploads.
    return localTime > remoteTime
  }

  // applySyncedPackBody throws MalformedSyncBundleError (not a plain
  // Error) when packId fails the store's own safety check — that
  // propagates straight through this function uncaught, so the sync
  // poll's `instanceof` check can recognize a permanently-rejected
  // revision and stop retrying it (see the store's own doc for why this
  // matters).
  const outcome = isTheme
    ? await applySyncedThemePackBody(packId, remoteContent, remoteModifiedTime)
    : await applySyncedI18nPackBody(packId, remoteContent, remoteModifiedTime)

  if (outcome === 'applied') {
    broadcastPackChanged(isTheme)
    return false
  }
  if (outcome === 'local-wins') {
    // The store's own in-lock CAS re-check found a fresher local write
    // landed after this function's own localTime snapshot above (a
    // save-vs-download race) — local is now the winner; mark for
    // re-upload instead of throwing.
    return true
  }
  throw new Error(`sync: failed to write ${isTheme ? 'theme' : 'i18n'} pack body for ${packId}`)
}

/**
 * After a local-wins UPLOAD of a pack-body sync unit, pin the local
 * body file's mtime to the Drive `modifiedTime` the upload response was
 * just assigned. Without this, the local file keeps its own wall-clock
 * write time — if the local clock runs even slightly ahead of Drive's
 * own clock, that time permanently looks "newer than the remote copy",
 * so every subsequent sync pass would re-upload this unchanged body
 * (and every peer would re-download it), forever.
 *
 * `expectedLocalMtimeMs` is the local body's mtime snapshot taken by the
 * caller (`uploadSyncUnit`, sync-merge-dispatch.ts) at upload-bundling time,
 * BEFORE this store-serialized pin call even runs — bundling, encrypting
 * and uploading to Drive all happen outside the store's write lock, so a
 * user save can land in that window. `pinPackBodyMtime` (i18n/theme
 * stores) re-checks the file's current mtime against this snapshot under
 * its lock and only pins on a match; otherwise it skips, so a fresher
 * local edit doesn't get its content stamped with this stale upload's
 * Drive time (which would make the next LWW compare as a tie and the new
 * edit never get uploaded). See `pinPackBodyMtime`'s own doc for the
 * full CAS contract. A no-op for any syncUnit that isn't a pack-body
 * unit.
 */
export async function pinPackBodyMtimeAfterUpload(
  ref: PackBodySyncUnit,
  modifiedTime: string,
  expectedLocalMtimeMs: number | null,
): Promise<void> {
  if (ref.isTheme) {
    await pinThemePackBodyMtime(ref.packId, modifiedTime, expectedLocalMtimeMs)
  } else {
    await pinI18nPackBodyMtime(ref.packId, modifiedTime, expectedLocalMtimeMs)
  }
}
