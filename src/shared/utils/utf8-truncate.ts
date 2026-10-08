// SPDX-License-Identifier: GPL-2.0-or-later
//
// UTF-8 byte counting and truncation for file names: the common file
// systems limit a name to 255 bytes (UTF-8 on Linux and macOS; 255 UTF-16
// units on Windows, never more than the UTF-8 byte count), so a multi-byte
// name hits the limit before its character count does.

/** UTF-8 bytes of one code point. A lone surrogate counts 3, the bytes of
 *  the U+FFFD it is encoded as. */
function codePointBytes(cp: number): number {
  if (cp < 0x80) return 1
  if (cp < 0x800) return 2
  if (cp < 0x10000) return 3
  return 4
}

export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const ch of text) bytes += codePointBytes(ch.codePointAt(0) ?? 0)
  return bytes
}

/** The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes,
 *  cut between code points (a surrogate pair or a multi-byte character is
 *  never split). */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const ch of text) {
    bytes += codePointBytes(ch.codePointAt(0) ?? 0)
    if (bytes > maxBytes) break
    end += ch.length
  }
  return text.slice(0, end)
}

/** `truncateUtf8` without the `_` / `.` / whitespace the cut leaves at the
 *  end of a file-name part. */
export function truncateUtf8NamePart(text: string, maxBytes: number): string {
  return truncateUtf8(text, maxBytes).replace(/[_.\s]+$/u, '')
}
