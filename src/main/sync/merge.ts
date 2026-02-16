// SPDX-License-Identifier: GPL-2.0-or-later
// Entry-level merge for sync — per-entry LWW with tombstone support

import type { SavedFavoriteMeta } from '../../shared/types/favorite-store'
import type { SnapshotMeta } from '../../shared/types/snapshot-store'

type EntryMeta = SavedFavoriteMeta | SnapshotMeta

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface MergeResult<T extends EntryMeta> {
  entries: T[]
  remoteFilesToCopy: string[]
  remoteNeedsUpdate: boolean
}

export function effectiveTime(entry: EntryMeta): number {
  const t = new Date(entry.updatedAt ?? entry.savedAt).getTime()
  return Number.isNaN(t) ? 0 : t
}

export function mergeEntries<T extends EntryMeta>(local: T[], remote: T[]): MergeResult<T> {
  const localMap = new Map<string, T>()
  for (const entry of local) {
    localMap.set(entry.id, entry)
  }

  const remoteMap = new Map<string, T>()
  for (const entry of remote) {
    remoteMap.set(entry.id, entry)
  }

  const entries: T[] = []
  const remoteFilesToCopy: string[] = []
  let remoteNeedsUpdate = false

  const allIds = new Set([...localMap.keys(), ...remoteMap.keys()])

  for (const id of allIds) {
    const localEntry = localMap.get(id)
    const remoteEntry = remoteMap.get(id)

    if (localEntry && !remoteEntry) {
      // Local only — remote needs to know about it
      entries.push(localEntry)
      remoteNeedsUpdate = true
    } else if (!localEntry && remoteEntry) {
      // Remote only — copy data file from remote (skip for tombstones)
      entries.push(remoteEntry)
      if (!remoteEntry.deletedAt) {
        remoteFilesToCopy.push(remoteEntry.filename)
      }
    } else if (localEntry && remoteEntry) {
      const localTime = effectiveTime(localEntry)
      const remoteTime = effectiveTime(remoteEntry)

      if (remoteTime > localTime) {
        // Remote wins
        entries.push(remoteEntry)
        if (!remoteEntry.deletedAt) {
          remoteFilesToCopy.push(remoteEntry.filename)
        }
      } else if (localTime > remoteTime) {
        // Local wins
        entries.push(localEntry)
        remoteNeedsUpdate = true
      } else {
        // Tie — local wins, no update needed
        entries.push(localEntry)
      }
    }
  }

  // Sort newest-first to preserve UI order after merge
  entries.sort((a, b) => effectiveTime(b) - effectiveTime(a))

  return { entries, remoteFilesToCopy, remoteNeedsUpdate }
}

export function gcTombstones<T extends EntryMeta>(entries: T[]): T[] {
  const now = Date.now()
  return entries.filter((entry) => {
    if (!entry.deletedAt) return true
    const deletedTime = new Date(entry.deletedAt).getTime()
    return now - deletedTime < TOMBSTONE_TTL_MS
  })
}
