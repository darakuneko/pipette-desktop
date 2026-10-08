// SPDX-License-Identifier: GPL-2.0-or-later
// Shared pieces of the sync merges: the tombstone TTL, the malformed-bundle
// error and timestamp parsing. The entry merge itself is `mergeEntries`
// (`entry-merge.ts`).

export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/** Thrown when a downloaded bundle doesn't have the shape its merge
 * requires (an `entries` array for favorites / snapshots / analyze-filter /
 * key-label / typing-test-text / run-log — every generic index-based sync
 * unit — or a `metas` array for the pack rosters). A remote bundle is
 * attacker-reachable data (anyone who can write to this sync unit's Drive
 * file), so this guards the merge's input contract rather than letting a
 * malformed shape throw an opaque TypeError deep inside it.
 * The message intentionally carries only the sync unit name — never
 * bundle content — so logs never leak ciphertext-derived payloads. */
export class MalformedSyncBundleError extends Error {
  constructor(syncUnit: string) {
    super(`malformed sync bundle index for ${syncUnit}`)
    this.name = 'MalformedSyncBundleError'
  }
}

/** Parses an ISO timestamp to epoch ms, treating a missing/invalid value
 *  as 0 (oldest possible) so a corrupt or absent timestamp always loses
 *  a comparison rather than throwing. */
export function safeTimestamp(value: string | undefined): number {
  if (!value) return 0
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}
