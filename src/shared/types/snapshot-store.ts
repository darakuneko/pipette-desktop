// SPDX-License-Identifier: GPL-2.0-or-later

import type { HubPrivateLink } from './hub-private'

export interface SnapshotMeta {
  id: string // UUID v4
  label: string // User label (may be empty)
  filename: string // Internal filename: {deviceName}_{ISO_timestamp}
  savedAt: string // ISO 8601
  updatedAt?: string // ISO 8601 — last update time
  deletedAt?: string // ISO 8601 — tombstone timestamp
  hubPostId?: string // Pipette Hub post ID (set after public upload)
  hubPrivate?: HubPrivateLink // Private (unlisted) Hub linkage — exclusive with hubPostId
  vilVersion?: number // VilFile format version (1 = legacy, 2 = current)
}

/** `SNAPSHOT_STORE_UPDATE` option for the mechanical v1 → v2 file
 *  migration (`useSnapshotMigration.ts`): `migrateFrom` is the body the
 *  migration was computed from. The write happens only when the stored
 *  body is still exactly that, and moves the body clock 1 ms past its
 *  current value instead of to now, so a real edit made on another device
 *  after that body still wins. It never brings a deleted entry back. */
export interface SnapshotUpdateOptions {
  migrateFrom?: string
}

export interface SnapshotIndex {
  uid: string
  entries: SnapshotMeta[]
}
