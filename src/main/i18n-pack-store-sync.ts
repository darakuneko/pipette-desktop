// SPDX-License-Identifier: GPL-2.0-or-later
//
// Sync entry points for the i18n pack store (pack-bundle-merge.ts,
// sync-bundle.ts): this store's adapter for the shared pack sync
// (`sync/pack-sync.ts`). Routing the writes through here keeps the
// `isSafePackId` check of a packId sourced from a remote Drive filename
// and this store's `withIndexWriteLock` around every read-merge-write.

import type { SyncBundle } from '../shared/types/sync'
import {
  type ApplyPackBodyOutcome,
  type PackIndexMergeResult,
  type PackSyncStore,
  applySyncedPackBody as applyPackBody,
  bundlePackBody,
  bundlePackIndex,
  mergeSyncedPackIndex,
} from './sync/pack-sync'
import {
  LOCAL_ONLY_PACK_IDS,
  getIndexPath,
  getPackPath,
  packSyncUnit,
  readIndex,
  withIndexWriteLock,
  writeIndex,
} from './i18n-pack-store-internal'

const i18nPackSync: PackSyncStore<'i18nPacks'> = {
  store: 'i18nPacks',
  bodySyncUnit: packSyncUnit,
  withLock: withIndexWriteLock,
  readIndex,
  writeIndex,
  indexPath: getIndexPath,
  packPath: getPackPath,
  localOnlyIds: LOCAL_ONLY_PACK_IDS,
}

/** See `mergeSyncedPackIndex` (pack-sync.ts). */
export function mergeSyncedIndex(remoteMetas: readonly unknown[]): Promise<PackIndexMergeResult> {
  return mergeSyncedPackIndex(i18nPackSync, remoteMetas)
}

/** See `bundlePackIndex` (pack-sync.ts). */
export function bundleSyncedIndex(): Promise<SyncBundle | null> {
  return bundlePackIndex(i18nPackSync, 'i18n-index')
}

/** See `bundlePackBody` (pack-sync.ts). */
export function bundleSyncedPackBody(packId: string): Promise<SyncBundle | null> {
  return bundlePackBody(i18nPackSync, packId, 'i18n-pack')
}

/** See `applySyncedPackBody` (pack-sync.ts). */
export function applySyncedPackBody(
  packId: string,
  bundle: SyncBundle,
  remoteModifiedTime: string,
  rosterMerged: boolean,
): Promise<ApplyPackBodyOutcome> {
  return applyPackBody(i18nPackSync, packId, bundle, remoteModifiedTime, rosterMerged)
}
