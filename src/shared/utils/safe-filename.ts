// SPDX-License-Identifier: GPL-2.0-or-later
//
// Sanitise a user-supplied label into a filesystem-safe filename
// stem. Allows any Unicode letter / digit plus `_` and `-`; runs of
// other characters collapse to a single `_` and leading / trailing
// underscores are trimmed. Returns the supplied `fallback` when the
// scrubbed string is empty so the caller never has to deal with an
// empty stem.

const SAFE_FILENAME_REGEX = /[^\p{L}\p{N}_-]+/gu

export function safeFilename(name: string, fallback: string): string {
  return name.replace(SAFE_FILENAME_REGEX, '_').replace(/^_+|_+$/g, '') || fallback
}

// Path-safety helpers shared across the index-based main-process stores
// (favorites, snapshots, analyze-filter, key-label, typing-test-text, run
// logs). Several of those stores still carry their own verbatim copy of
// `isSafePathSegment` — see
// .claude/tasks/backlog/Task-store-path-helper-dedup.md for consolidating
// them here too; new call sites should import from here rather than add
// another copy.

/** True when `segment` is safe to use as a single path segment (a uid,
 *  runId, or filename) — rejects empty, '.', '..', and anything
 *  containing a path separator, so a caller can never escape its own
 *  store directory via a crafted value. */
export function isSafePathSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false
  return !/[/\\]/.test(segment)
}

/** ISO timestamp with colons replaced by `-`, safe to splice into a
 *  filename (`:` is reserved on Windows). Defaults to the current time. */
export function tsForFilename(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, '-')
}
