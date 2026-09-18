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
// contract than the general path-safety check below. `isSafeKey` and
// `isSafePath` are a third, stricter pair used only where the value comes
// from an untrusted import file rather than a locally-generated name —
// both use a narrower character allowlist (word chars plus `-`, or word
// chars plus `.()-`) than `isSafePathSegment`'s denylist, so neither is
// built on it (doing so would loosen them to allow spaces, unicode, and
// other characters neither currently accepts).

/** True when `segment` is safe to use as a single path segment (a uid,
 *  runId, or filename) — rejects empty, '.', '..', and anything
 *  containing a path separator, so a caller can never escape its own
 *  store directory via a crafted value. */
export function isSafePathSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false
  return !/[/\\]/.test(segment)
}

/** True when `key` is safe to use as a lock key or directory segment
 *  sourced from an untrusted import file (a keyboard uid or favorite
 *  type) — word characters and `-` only. The `typeof` check matters here
 *  even though the parameter is typed `string`: every real call site
 *  passes a JSON-parsed, untrusted value that TypeScript can't verify at
 *  runtime, and `RegExp.test` coerces a non-string argument (e.g.
 *  `undefined`) to its string form instead of failing, which would
 *  otherwise let a malformed value slip through as "safe". */
export function isSafeKey(key: string): boolean {
  return typeof key === 'string' && /^[\w-]+$/.test(key)
}

/** True when `filename` is safe to join onto a base directory as a single
 *  path segment — sourced from an untrusted import file's index entry.
 *  The character allowlist (word characters, `.`, `(`, `)`, `-`) already
 *  excludes path separators, so the only way a single segment built from
 *  it could still escape the base directory is the two literal
 *  self/parent-reference forms, rejected explicitly below (equivalent to
 *  resolving the joined path and checking it stays under the base — but
 *  without a `node:path` dependency, since this module is also imported
 *  by the renderer). Takes `unknown` (rather than `string`) and narrows
 *  via a type predicate — the same untrusted-JSON case as `isSafeKey`
 *  above, but made a compile-time guarantee here since every call site
 *  reads `filename` straight out of a JSON-parsed, untrusted index entry
 *  whose field could be missing or the wrong type. A non-string value
 *  must not pass through to a `path.join` call, which throws a raw
 *  `TypeError` on a non-string argument instead of failing cleanly. */
export function isSafePath(filename: unknown): filename is string {
  if (typeof filename !== 'string' || !/^[\w.()-]+$/.test(filename)) return false
  return filename !== '.' && filename !== '..'
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
