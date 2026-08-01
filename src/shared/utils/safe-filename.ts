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
// logs). `isSafePathSegment` is the separator-denylist form used for uids,
// runIds, and stored filenames; `isSafePackId` is a stricter allowlist for
// i18n/theme pack ids. `hub-ipc.ts`'s own `isSafeExportFilename` is
// deliberately kept separate rather than folded into `isSafePathSegment`:
// it's an ASCII allowlist enforced at the Hub-upload boundary, a stricter
// contract than the general path-safety check below.

/** True when `segment` is safe to use as a single path segment (a uid,
 *  runId, or filename) — rejects empty, '.', '..', and anything
 *  containing a path separator, so a caller can never escape its own
 *  store directory via a crafted value. */
export function isSafePathSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false
  return !/[/\\]/.test(segment)
}

/** True when `id` is a safe i18n/theme pack id — UUID-like form. Rejects
 *  anything that could escape the packs directory. */
export function isSafePackId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

/** ISO timestamp with colons replaced by `-`, safe to splice into a
 *  filename (`:` is reserved on Windows). Defaults to the current time. */
export function tsForFilename(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, '-')
}

/** Compact ISO timestamp for export filenames — strips colons, the
 *  sub-second fraction, and the `T` separator, e.g. `2026-07-31-153045`.
 *  Defaults to the current time. */
export function tsForExportFilename(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, '').replace(/\.\d+Z$/, '').replace('T', '-')
}
