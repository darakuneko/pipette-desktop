// SPDX-License-Identifier: GPL-2.0-or-later
// Merge of the i18n/theme index + pack-body bundle shapes.
//
// This module routes each unit to its store's sync entry points
// (`mergeSyncedIndex` / `applySyncedPackBody`, i18n-pack-store.ts /
// theme-pack-store.ts, on top of `sync/pack-sync.ts`) and owns the
// post-write broadcast. Every path/write concern lives in the stores, so a
// packId sourced from a remote Drive filename (the least-trusted input in
// the sync pipeline) is always validated at the same boundary the store
// already guards its own writes with.
//
// Import-cycle note: this module imports from i18n-pack-store.ts /
// theme-pack-store.ts, which each import `notifyChange` from
// `./sync-service`, whose facade re-exports transitively pull in
// `sync-merge-dispatch.ts`, which imports from this module — a cycle.
// It is inert for the same reason as sync-bundle.ts's (sync-service →
// sync-bundle → key-label-store → sync-service): every import is only
// used inside a function body, never at module-evaluation time.

import { IpcChannels } from '../../shared/ipc/channels'
import { broadcastToAllWindows } from '../utils/broadcast'
import { MalformedSyncBundleError } from './merge'
import { driveFileName } from './google-drive'
import { forgetRemoteState, syncRuntime } from './sync-runtime-state'
import { notifyChange } from './sync-service'
import { I18N_INDEX_SYNC_UNIT, I18N_SYNC_UNIT_PREFIX } from '../../shared/types/i18n-store'
import { THEME_SYNC_UNIT_PREFIX, THEME_INDEX_SYNC_UNIT } from '../../shared/types/theme-store'
import {
  mergeSyncedIndex as mergeSyncedI18nIndex,
  applySyncedPackBody as applySyncedI18nPackBody,
} from '../i18n-pack-store'
import {
  mergeSyncedIndex as mergeSyncedThemeIndex,
  applySyncedPackBody as applySyncedThemePackBody,
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

function isPackIndexSyncUnit(syncUnit: string): boolean {
  return syncUnit === I18N_INDEX_SYNC_UNIT || syncUnit === THEME_INDEX_SYNC_UNIT
}

/** Runs `run` for every pack index unit of `items` first, then for the
 *  rest, so a body unit is applied against a roster already merged in the
 *  same pass (a body for an id the roster has not brought yet would
 *  otherwise have no meta to apply to). */
export async function settlePackIndexUnitsFirst<T>(
  items: readonly T[],
  unitOf: (item: T) => string,
  run: (item: T) => Promise<unknown>,
): Promise<void> {
  await Promise.allSettled(items.filter((i) => isPackIndexSyncUnit(unitOf(i))).map(run))
  await Promise.allSettled(items.filter((i) => !isPackIndexSyncUnit(unitOf(i))).map(run))
}

/** Records that `syncUnit`'s roster is in step with Drive; called by
 *  `mergeWithRemote` / `syncOrUpload` (sync-merge-dispatch.ts). */
export function markPackRosterSynced(syncUnit: string): void {
  if (isPackIndexSyncUnit(syncUnit)) syncRuntime.syncedPackRosters.add(syncUnit)
}

/** Broadcast the same "pack list changed" event `theme-pack-ipc.ts`'s
 * own mutating handlers fire after a local save/rename/delete, and
 * `i18n-startup-sync.ts` fires after its Hub reconcile. Unlike themes,
 * `i18n-pack-ipc.ts` itself never broadcasts `I18N_PACK_CHANGED` on a
 * local mutation — the window that issued the IPC call already has the
 * fresh data from that call's own return value, so only the
 * cross-process paths (this merge, and the Hub startup reconcile) need
 * to tell OTHER windows. */
function broadcastPackChanged(isTheme: boolean): void {
  broadcastToAllWindows(isTheme ? IpcChannels.THEME_PACK_CHANGED : IpcChannels.I18N_PACK_CHANGED)
}

/**
 * Merge for "i18n/index" / "themes/index": the store's `mergeSyncedIndex`
 * runs read → merge → write as one step under its own lock. Returns
 * `true` when Drive needs this device's roster.
 *
 * A pack whose meta now shows a body this device does not hold (a pack
 * only Drive had, or one brought back) gets its body unit's recorded
 * revision forgotten, so the next pass downloads that body even when
 * Drive did not change it.
 *
 * `remoteBundle.index.metas` not being an array at all (a stronger
 * malformation than a bad individual element, which the stores filter
 * per entry) throws `MalformedSyncBundleError` rather than defaulting to
 * an empty array, which would make a corrupt remote index look like a
 * legitimately empty one to the sync poll's permanently-rejected-revision
 * skip.
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
  const prefix = isTheme ? THEME_SYNC_UNIT_PREFIX : I18N_SYNC_UNIT_PREFIX
  for (const id of result.bodyFetchIds) forgetRemoteState(driveFileName(`${prefix}packs/${id}`))
  broadcastPackChanged(isTheme)
  return result.remoteNeedsUpdate
}

/**
 * Merge for "i18n/packs/{id}" / "themes/packs/{id}". The bundle carries the
 * body clock and body fields of the sending device's meta (a v1 bundle has
 * neither and falls back to the Drive `modifiedTime`, see
 * `applySyncedPackBody` in pack-sync.ts). A remote win writes the file and
 * the meta's body group together, and the roster unit is queued so Drive
 * gets the new body fields too. Returns `true` when Drive needs this
 * device's body.
 */
export async function mergePackBodyBundle(
  ref: PackBodySyncUnit,
  remoteBundle: SyncBundle,
  remoteModifiedTime: string,
): Promise<boolean> {
  const { isTheme, packId } = ref
  const indexUnit = isTheme ? THEME_INDEX_SYNC_UNIT : I18N_INDEX_SYNC_UNIT
  const rosterMerged = syncRuntime.syncedPackRosters.has(indexUnit)
  const outcome = isTheme
    ? await applySyncedThemePackBody(packId, remoteBundle, remoteModifiedTime, rosterMerged)
    : await applySyncedI18nPackBody(packId, remoteBundle, remoteModifiedTime, rosterMerged)

  if (outcome === 'applied') {
    notifyChange(indexUnit)
    broadcastPackChanged(isTheme)
    return false
  }
  return outcome === 'local-wins'
}
