// SPDX-License-Identifier: GPL-2.0-or-later
// Entry-level merge for sync — per-entry LWW with tombstone support

import type { SavedFavoriteMeta } from '../../shared/types/favorite-store'
import type { SnapshotMeta } from '../../shared/types/snapshot-store'
import type { AnalyzeFilterSnapshotMeta } from '../../shared/types/analyze-filter-store'
import type { KeyLabelMeta } from '../../shared/types/key-label-store'
import type { TypingTestTextMeta } from '../../shared/types/typing-test-text-store'
import type { RunLogMeta } from '../../shared/types/typing-run-log'
import type { I18nPackMeta } from '../../shared/types/i18n-store'
import type { ThemePackMeta } from '../../shared/types/theme-store'

// I18nPackMeta / ThemePackMeta are structurally identical to every other
// member here (id / filename / savedAt / updatedAt / deletedAt?) — see
// pack-bundle-merge.ts's mergePackIndexBundle, which reuses this same
// mergeEntries/gcTombstones machinery for the i18n/theme pack roster
// instead of the file-level whole-index LWW this module used to require
// bundle-merge.ts to implement on its own.
export type EntryMeta = SavedFavoriteMeta | SnapshotMeta | AnalyzeFilterSnapshotMeta | KeyLabelMeta | TypingTestTextMeta | RunLogMeta | I18nPackMeta | ThemePackMeta

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/** Thrown when a downloaded bundle's index doesn't have the `entries`
 * array shape `mergeEntries`/`gcTombstones` require (favorites /
 * snapshots / analyze-filter / key-label / typing-test-text / run-log —
 * every generic index-based sync unit). A remote bundle is
 * attacker-reachable data (anyone who can write to this sync unit's
 * Drive file), so this guards `mergeEntries`' input contract rather than
 * letting a malformed shape throw an opaque TypeError deep inside it.
 * The message intentionally carries only the sync unit name — never
 * bundle content — so logs never leak ciphertext-derived payloads. */
export class MalformedSyncBundleError extends Error {
  constructor(syncUnit: string) {
    super(`malformed sync bundle index for ${syncUnit}`)
    this.name = 'MalformedSyncBundleError'
  }
}

export interface MergeOptions {
  preserveLocalOrder?: boolean
  /** Run-log sync unit only: after the entry-level LWW merge below,
   *  additionally retain only the newest N entries (see
   *  `applyRunLogRetention`), tombstoning the overflow. Narrow — every
   *  other sync unit type omits this and gets ordinary LWW merge with no
   *  retention cap. */
  runLogRetentionMax?: number
}

export interface MergeResult<T extends EntryMeta> {
  entries: T[]
  remoteFilesToCopy: string[]
  remoteNeedsUpdate: boolean
  /** Entries evicted by `runLogRetentionMax` retention, if that option was
   *  set — the caller unlinks their backing files. Always empty otherwise. */
  evicted: T[]
}

/** Deterministic retention trim: keep the newest {@link max} active
 *  (non-tombstoned) entries, ranked by immutable `startedAt` (id as a
 *  stable tiebreaker for an exact-same-ms collision), converting the
 *  overflow into fresh tombstones. Pure — the caller unlinks `evicted`'s
 *  files and persists `entries`. Ranking by an immutable field (never
 *  local `savedAt`/LWW-mutable `updatedAt`) is what lets two devices that
 *  independently exceeded the cap converge on the identical kept set once
 *  they sync — LWW alone would let a later `updatedAt` resurrect an entry
 *  the other device already evicted. Operates on a full entries array
 *  (active + already-tombstoned, same shape `mergeEntries` returns), so it
 *  can run standalone (typing-run-log-store's local save path) or as
 *  `mergeEntries`'s own post-merge step (`runLogRetentionMax`). */
export function applyRunLogRetention(entries: readonly RunLogMeta[], max: number): { entries: RunLogMeta[]; evicted: RunLogMeta[] } {
  const active = entries.filter((e) => !e.deletedAt)
  const tombstones = entries.filter((e) => e.deletedAt)
  if (active.length <= max) return { entries: entries.slice(), evicted: [] }

  const ranked = active.slice().sort((a, b) => {
    const byTime = new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    if (byTime !== 0) return byTime
    // Deterministic tiebreaker for an exact startedAt collision so every
    // device ranks the tie identically.
    if (a.id === b.id) return 0
    return a.id < b.id ? 1 : -1
  })
  const kept = ranked.slice(0, max)
  const evicted = ranked.slice(max)
  const now = new Date().toISOString()
  const evictedTombstones = evicted.map((e) => ({ ...e, deletedAt: now, updatedAt: now }))
  return { entries: [...kept, ...evictedTombstones, ...tombstones], evicted }
}

/** Parses an ISO timestamp to epoch ms, treating a missing/invalid value
 *  as 0 (oldest possible) so a corrupt or absent timestamp always loses
 *  an LWW comparison rather than throwing. Shared by every file-level and
 *  entry-level LWW comparison in the sync subsystem (settings, i18n/theme
 *  pack bundles, favorites/snapshots/etc. via `effectiveTime` below). */
export function safeTimestamp(value: string | undefined): number {
  if (!value) return 0
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}

/** Timestamp shape shared by every meta this module and the i18n/theme
 *  pack-bundle merge (`pack-bundle-merge.ts`) compare for LWW — the
 *  newest of `updatedAt`/`savedAt` wins. Kept structural (rather than
 *  `EntryMeta`) so non-entry meta shapes (`I18nPackMeta`, `ThemePackMeta`)
 *  can share this single comparison instead of re-implementing it. */
export interface TimestampedMeta {
  updatedAt?: string
  savedAt?: string
}

export function effectiveTime(entry: TimestampedMeta): number {
  return safeTimestamp(entry.updatedAt ?? entry.savedAt)
}

export function mergeEntries<T extends EntryMeta>(local: T[], remote: T[], options?: MergeOptions): MergeResult<T> {
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

  const active: T[] = []
  const tombstones: T[] = []
  for (const entry of entries) {
    if (entry.deletedAt) {
      tombstones.push(entry)
    } else {
      active.push(entry)
    }
  }

  if (!options?.preserveLocalOrder) {
    active.sort((a, b) => effectiveTime(b) - effectiveTime(a))
  }

  active.push(...tombstones)

  if (options?.runLogRetentionMax !== undefined) {
    const retained = applyRunLogRetention(active as unknown as readonly RunLogMeta[], options.runLogRetentionMax)
    return {
      entries: retained.entries as unknown as T[],
      remoteFilesToCopy,
      // Retention evicting entries produces fresh tombstones that remote
      // doesn't have yet (e.g. a remote-only-so-far merge where the LWW
      // pass above never had a reason to set remoteNeedsUpdate on its
      // own) — those tombstones must upload on THIS sync, not wait for a
      // later one to happen to also flip this flag for an unrelated reason.
      remoteNeedsUpdate: remoteNeedsUpdate || retained.evicted.length > 0,
      evicted: retained.evicted as unknown as T[],
    }
  }

  return { entries: active, remoteFilesToCopy, remoteNeedsUpdate, evicted: [] }
}

export function gcTombstones<T extends EntryMeta>(entries: T[]): T[] {
  const now = Date.now()
  return entries.filter((entry) => {
    if (!entry.deletedAt) return true
    const deletedTime = new Date(entry.deletedAt).getTime()
    return now - deletedTime < TOMBSTONE_TTL_MS
  })
}
