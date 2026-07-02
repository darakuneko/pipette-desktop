// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared fetch-and-verify helper for the two IPC paths that download a
// file from a Hub-provided URL and check it against a manifest-declared
// byte size: LANG_DOWNLOAD (language-store.ts, one JSON pack file) and the
// Aozora importer (aozora-import.ts, one ZIP archive).

import { net } from 'electron'

export type FetchVerifiedBytesResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'http'; status: number }
  | { ok: false; reason: 'size-mismatch'; expected: number; actual: number }
  | { ok: false; reason: 'network'; error: unknown }

/** Fetches `url` and verifies both the HTTP status and that the response's
 *  byte length matches `expectedSize`, returning the raw bytes on success.
 *  Callers own the context-specific error code/message and logging — this
 *  only centralizes the fetch → ok-check → size-check sequence. */
export async function fetchVerifiedBytes(url: string, expectedSize: number): Promise<FetchVerifiedBytesResult> {
  try {
    const response = await net.fetch(url)
    if (!response.ok) {
      return { ok: false, reason: 'http', status: response.status }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength !== expectedSize) {
      return { ok: false, reason: 'size-mismatch', expected: expectedSize, actual: bytes.byteLength }
    }
    return { ok: true, bytes }
  } catch (error) {
    return { ok: false, reason: 'network', error }
  }
}
