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
