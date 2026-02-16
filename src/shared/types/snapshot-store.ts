// SPDX-License-Identifier: GPL-2.0-or-later

export interface SnapshotMeta {
  id: string // UUID v4
  label: string // User label (may be empty)
  filename: string // Internal filename: {deviceName}_{ISO_timestamp}
  savedAt: string // ISO 8601
  updatedAt?: string // ISO 8601 — last update time
  deletedAt?: string // ISO 8601 — tombstone timestamp
  hubPostId?: string // Pipette Hub post ID (set after upload)
}

export interface SnapshotIndex {
  uid: string
  entries: SnapshotMeta[]
}
