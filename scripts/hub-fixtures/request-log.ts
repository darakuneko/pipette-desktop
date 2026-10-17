// SPDX-License-Identifier: GPL-2.0-or-later
// How a request the Electron Hub code sends through `fetch` is written
// into the request log of the Hub golden files. The Rust tests of
// src-tauri/crates/pipette-hub write the requests of the in-memory Hub
// the same way and compare:
//   - the method, the path (as `new URL` normalises it, which is what is
//     sent) and the query as sorted [name, value] pairs;
//   - the headers the code sets, by lower-case name, without
//     `user-agent` and `accept` (the HTTP clients differ there) and with
//     the multipart boundary taken out of `content-type`;
//   - the body: a text body as its text, with its JSON value when it is
//     JSON; a multipart body as its boundary (with `{now}` for the clock),
//     its parts and all of its bytes with the boundary written as
//     `{boundary}`; other bytes as base64.

import { FIXED_NOW } from '../sync-fixtures/harness'

export interface LoggedRequest {
  method: string
  path: string
  query: Array<[string, string]>
  headers: Record<string, string>
  body?: LoggedBody
}

export interface LoggedPart {
  /** The part's header lines, `\r\n` between them, as sent. */
  headers: string
  /** The content as UTF-8 text, or as base64 when it is not UTF-8. */
  text?: string
  base64?: string
}

export type LoggedBody =
  | { json: unknown; text: string }
  | { text: string }
  | { base64: string }
  | { multipart: { boundary: string; parts: LoggedPart[]; normalized: string } }

/** Header names the log leaves out. */
const UNCOMPARED_HEADERS = new Set(['user-agent', 'accept'])

/** `params` as sorted [name, value] pairs. */
export function queryPairs(params: URLSearchParams): Array<[string, string]> {
  return [...params.entries()].sort(([a, av], [b, bv]) => (a === b ? compare(av, bv) : compare(a, b)))
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isUtf8(bytes: Buffer): boolean {
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
}

function textOrBase64(bytes: Buffer): { text: string } | { base64: string } {
  return isUtf8(bytes) ? { text: bytes.toString('utf8') } : { base64: bytes.toString('base64') }
}

function textBody(text: string): LoggedBody {
  try {
    return { json: JSON.parse(text) as unknown, text }
  } catch {
    return { text }
  }
}

/** Every occurrence of `needle` in `haystack`, by byte offset. */
function offsetsOf(haystack: Buffer, needle: Buffer): number[] {
  const offsets: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) offsets.push(at)
  return offsets
}

/** The parts of a multipart/form-data body as the Hub client writes it:
 *  `--{boundary}\r\n{headers}\r\n\r\n{content}\r\n` per part, then
 *  `--{boundary}--\r\n`. Throws when the body has another shape. */
export function multipartParts(body: Buffer, boundary: string): LoggedPart[] {
  const delimiter = Buffer.from(`--${boundary}`)
  const offsets = offsetsOf(body, delimiter)
  if (offsets.length < 2 || offsets[0] !== 0) throw new Error('hub fixture harness: not a multipart body')
  const close = offsets[offsets.length - 1]
  if (!body.subarray(close).equals(Buffer.from(`--${boundary}--\r\n`))) {
    throw new Error('hub fixture harness: the multipart body does not end with its closing delimiter')
  }
  const parts: LoggedPart[] = []
  for (let i = 0; i < offsets.length - 1; i++) {
    const piece = body.subarray(offsets[i] + delimiter.length, offsets[i + 1])
    if (!piece.subarray(0, 2).equals(Buffer.from('\r\n')) || !piece.subarray(-2).equals(Buffer.from('\r\n'))) {
      throw new Error('hub fixture harness: a multipart part is not framed by CRLF')
    }
    const inner = piece.subarray(2, -2)
    const split = inner.indexOf('\r\n\r\n')
    if (split === -1) throw new Error('hub fixture harness: a multipart part has no blank line')
    parts.push({ headers: inner.subarray(0, split).toString('utf8'), ...textOrBase64(inner.subarray(split + 4)) })
  }
  return parts
}

function bodyBytes(body: NonNullable<RequestInit['body']>): Buffer | string {
  if (typeof body === 'string') return body
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  throw new Error('hub fixture harness: the Hub client sent a body that is not text or bytes')
}

/** The log entry of a request the Hub code sends through `fetch`. */
export function logRequest(url: URL, init: RequestInit | undefined): LoggedRequest {
  const headers: Record<string, string> = {}
  let boundary: string | undefined
  const sent = new Headers(init?.headers)
  for (const name of [...sent.keys()].sort()) {
    if (UNCOMPARED_HEADERS.has(name)) continue
    let value = sent.get(name) ?? ''
    if (name === 'content-type') {
      boundary = /;\s*boundary=([^;]+)/.exec(value)?.[1]
      value = value.replace(/;\s*boundary=[^;]+/, '')
    }
    headers[name] = value
  }
  const entry: LoggedRequest = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname, query: queryPairs(url.searchParams), headers }
  if (init?.body === undefined || init.body === null) return entry
  const bytes = bodyBytes(init.body)
  if (boundary !== undefined) {
    const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
    const normalized = Buffer.from(buffer.toString('latin1').split(boundary).join('{boundary}'), 'latin1')
    entry.body = {
      multipart: {
        boundary: boundary.split(String(FIXED_NOW)).join('{now}'),
        parts: multipartParts(buffer, boundary),
        normalized: normalized.toString('base64'),
      },
    }
  } else if (typeof bytes === 'string') {
    entry.body = textBody(bytes)
  } else {
    entry.body = isUtf8(bytes) ? textBody(bytes.toString('utf8')) : { base64: bytes.toString('base64') }
  }
  return entry
}

/** `log` in a fixed order, for requests sent in parallel. */
export function sortedLog(log: readonly LoggedRequest[]): LoggedRequest[] {
  return [...log].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))
}
