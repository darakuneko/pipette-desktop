// SPDX-License-Identifier: GPL-2.0-or-later
// The request-log scenarios of the Drive client and how a request is
// written into the log, for the generator (record-drive-fixtures.test.ts).
// The Rust test of src-tauri/crates/pipette-drive (tests/request_log.rs)
// runs the same steps on the in-memory Drive and writes its requests the
// same way:
//   - the method, the path, the query as sorted [name, value] pairs;
//   - the Content-Type without the multipart boundary;
//   - the body: JSON as a value, a multipart body as its parts (each with
//     its Content-Type and its content as JSON or text), anything else as
//     text.
// Header order and the boundary are left out.

import { errorBody } from '../fake-drive/drive-state'

/** One step of a scenario; the ops are the functions of google-drive.ts. */
export type Step =
  /** The next requests fail (drive-state.ts `Fault`). */
  | { op: 'fault'; status: number; count: number; retryAfter?: string; body?: string; only?: string }
  /** The access token the next requests get; null for signed out. */
  | { op: 'token'; value: string | null }
  /** Quitting begins during the next wait between attempts. */
  | { op: 'quitOnNextWait' }
  | { op: 'list'; nameContains?: string }
  | { op: 'download'; id: string }
  | { op: 'upload'; name: string; content: string; id?: string; createIfMissing?: boolean }
  | { op: 'createRaw'; name: string; content: string }
  | { op: 'rename'; id: string; name: string }
  | { op: 'delete'; id: string }
  | { op: 'deleteById'; ids: string[] }
  | { op: 'deleteByPrefix'; prefix: string }

/** A file put into the Drive before the steps, or `count` of them named
 *  `{namePrefix}{index, 4 digits}.enc`. */
export type SeedFile = { name: string; content: string } | { namePrefix: string; count: number; content: string }

export function seedFiles(seed: readonly SeedFile[]): Array<{ name: string; content: string }> {
  return seed.flatMap((file) =>
    'name' in file
      ? [file]
      : Array.from({ length: file.count }, (_, i) => ({ name: `${file.namePrefix}${String(i).padStart(4, '0')}.enc`, content: file.content })),
  )
}

export interface Scenario {
  name: string
  /** Files put into the Drive before the steps, without requests. */
  seed?: SeedFile[]
  steps: Step[]
  /** The requests run 5 at a time, so the log is compared sorted. */
  unordered?: boolean
}

export interface LoggedRequest {
  method: string
  path: string
  query: Array<[string, string]>
  contentType?: string
  body?: LoggedBody
}

export type LoggedBody =
  | { json: unknown }
  | { text: string }
  | { parts: Array<{ contentType: string; json?: unknown; text?: string }> }

/** A list result longer than this is written as its count and its ends. */
export const LIST_SUMMARY_OVER = 20

const ENVELOPE = JSON.stringify({
  version: 1,
  syncUnit: 'favorites/macro',
  updatedAt: '2026-10-16T00:00:00.000Z',
  salt: 'c2FsdA==',
  iv: 'aXY=',
  ciphertext: 'Y2lwaGVy',
})
const ENVELOPE_2 = ENVELOPE.replace('Y2lwaGVy', 'Y2lwaGVyMg==')
const USER_RATE_LIMIT = errorBody(403, 'User Rate Limit Exceeded', 'userRateLimitExceeded')
const FORBIDDEN = errorBody(403, 'Insufficient Permission', 'insufficientPermissions')

export const SCENARIOS: Scenario[] = [
  {
    name: 'list without and with nameContains',
    seed: [
      { name: 'favorites_macro.enc', content: ENVELOPE },
      { name: "weird'name.enc", content: '{}' },
      { name: 'keyboards_0x1_settings.enc', content: '{}' },
    ],
    steps: [
      { op: 'list' },
      { op: 'list', nameContains: '' },
      { op: 'list', nameContains: 'keyboards_0x1_' },
      { op: 'list', nameContains: "weird'" },
    ],
  },
  { name: 'list follows the pages', seed: [{ namePrefix: 'favorites_p', count: 1001, content: '{}' }], steps: [{ op: 'list' }, { op: 'list', nameContains: 'favorites_p1000' }] },
  {
    name: 'download, upload, update and the raw files',
    seed: [{ name: 'favorites_macro.enc', content: ENVELOPE }],
    steps: [
      { op: 'download', id: 'fake-1' },
      { op: 'upload', name: 'favorites_combo.enc', content: ENVELOPE },
      { op: 'upload', name: 'favorites_macro.enc', content: ENVELOPE_2, id: 'fake-1' },
      { op: 'download', id: 'fake-1' },
      { op: 'upload', name: 'favorites_macro.enc', content: ENVELOPE, id: '' },
      { op: 'createRaw', name: 'password-change-lock.json', content: '{"lockId":"l1","machineHash":"h"}' },
      { op: 'download', id: 'fake-4' },
      { op: 'download', id: 'missing' },
    ],
  },
  {
    name: 'update of a missing file',
    steps: [
      { op: 'upload', name: 'key-labels.enc', content: ENVELOPE, id: 'gone', createIfMissing: true },
      { op: 'upload', name: 'key-labels.enc', content: ENVELOPE, id: 'gone' },
      { op: 'list' },
    ],
  },
  {
    name: 'rename and delete',
    seed: [
      { name: 'favorites_macro.enc', content: ENVELOPE },
      { name: 'favorites_macro.enc', content: ENVELOPE_2 },
    ],
    steps: [
      { op: 'rename', id: 'fake-2', name: 'favorites_macro.enc.trash.1792108800000.1767225601000.fake-2' },
      { op: 'rename', id: 'missing', name: "it's.enc" },
      { op: 'delete', id: 'fake-1' },
      { op: 'delete', id: 'fake-1' },
      { op: 'list' },
    ],
  },
  {
    name: 'rate limits are retried, a create too',
    seed: [{ name: 'favorites_macro.enc', content: ENVELOPE }],
    steps: [
      { op: 'fault', status: 429, count: 1, retryAfter: '3' },
      { op: 'fault', status: 429, count: 1, retryAfter: '120' },
      { op: 'list' },
      { op: 'fault', status: 429, count: 1, retryAfter: 'Fri, 16 Oct 2026 00:00:05 GMT' },
      { op: 'fault', status: 429, count: 1, retryAfter: 'Thu, 15 Oct 2026 23:59:55 GMT' },
      { op: 'fault', status: 429, count: 1, retryAfter: 'later' },
      { op: 'download', id: 'fake-1' },
      { op: 'fault', status: 403, count: 1, body: USER_RATE_LIMIT, only: 'create' },
      { op: 'fault', status: 429, count: 1, only: 'create' },
      { op: 'upload', name: 'favorites_combo.enc', content: ENVELOPE },
      { op: 'fault', status: 429, count: 1, only: 'create' },
      { op: 'createRaw', name: 'sync-format-v1.json', content: '{}' },
      { op: 'fault', status: 403, count: 1, body: USER_RATE_LIMIT, only: 'delete' },
      { op: 'delete', id: 'fake-1' },
    ],
  },
  {
    name: '5xx is retried except for a create',
    seed: [{ name: 'favorites_macro.enc', content: ENVELOPE }],
    steps: [
      { op: 'fault', status: 503, count: 1 },
      { op: 'list' },
      { op: 'fault', status: 500, count: 2, only: 'update' },
      { op: 'upload', name: 'favorites_macro.enc', content: ENVELOPE_2, id: 'fake-1' },
      { op: 'fault', status: 502, count: 1, only: 'rename' },
      { op: 'rename', id: 'fake-1', name: 'favorites_combo.enc' },
      { op: 'fault', status: 500, count: 1, only: 'create' },
      { op: 'upload', name: 'favorites_tapDance.enc', content: ENVELOPE },
      { op: 'fault', status: 503, count: 1, only: 'create' },
      { op: 'createRaw', name: 'sync-format-v1.json', content: '{}' },
      { op: 'list' },
    ],
  },
  {
    name: 'the attempts run out',
    steps: [
      { op: 'fault', status: 503, count: 5 },
      { op: 'list' },
      { op: 'fault', status: 429, count: 6 },
      { op: 'delete', id: 'x' },
      { op: 'fault', status: 429, count: 1 },
      { op: 'list' },
    ],
  },
  {
    name: 'other failures are not retried',
    seed: [{ name: 'favorites_macro.enc', content: ENVELOPE }],
    steps: [
      { op: 'fault', status: 403, count: 1, body: FORBIDDEN },
      { op: 'list' },
      { op: 'fault', status: 403, count: 1, body: 'forbidden' },
      { op: 'download', id: 'fake-1' },
      { op: 'fault', status: 400, count: 1, body: 'bad' },
      { op: 'upload', name: 'favorites_macro.enc', content: ENVELOPE, id: 'fake-1' },
      { op: 'fault', status: 401, count: 1 },
      { op: 'rename', id: 'fake-1', name: 'b.enc' },
    ],
  },
  {
    name: 'quitting ends the retries',
    steps: [
      { op: 'quitOnNextWait' },
      { op: 'fault', status: 503, count: 2 },
      { op: 'list' },
      { op: 'list' },
    ],
  },
  {
    name: 'no request without an access token',
    steps: [{ op: 'token', value: null }, { op: 'list' }, { op: 'createRaw', name: 'x.json', content: '{}' }, { op: 'token', value: 'fixture-token-2' }, { op: 'list' }],
  },
  {
    name: 'bulk deletes',
    seed: [
      { name: 'keyboards_0x1_settings.enc', content: '{}' },
      { name: 'keyboards_0x1_settings.enc.trash.1.2.fake-2', content: '{}' },
      { name: 'password-change-lock.json', content: '{}' },
      { name: 'sync-format-v1.json', content: '{}' },
      { name: 'keyboards_0x1_snapshots.enc', content: '{}' },
      { name: 'keyboards_0x2_settings.enc', content: '{}' },
      { name: 'keyboards_0x2_runs.enc', content: '{}' },
      { namePrefix: 'keyboards_0x3_runs_', count: 7, content: '{}' },
      { name: 'favorites_macro.enc', content: '{}' },
    ],
    steps: [
      { op: 'deleteByPrefix', prefix: 'keyboards_0x1_' },
      { op: 'deleteById', ids: ['fake-6', 'missing', 'fake-7'] },
      { op: 'deleteByPrefix', prefix: 'keyboards_' },
      { op: 'fault', status: 400, count: 1, only: 'delete' },
      { op: 'deleteById', ids: ['fake-15'] },
      { op: 'list' },
      { op: 'fault', status: 500, count: 1, only: 'list' },
      { op: 'fault', status: 400, count: 1, only: 'list' },
      { op: 'deleteByPrefix', prefix: 'favorites_' },
    ],
    unordered: true,
  },
]

/** `query` as sorted [name, value] pairs. */
export function queryPairs(params: URLSearchParams): Array<[string, string]> {
  return [...params.entries()].sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
}

function jsonOrText(text: string): { json: unknown } | { text: string } {
  try {
    return { json: JSON.parse(text) as unknown }
  } catch {
    return { text }
  }
}

/** The parts of a multipart/related body with the `\r\n` lines
 *  google-drive.ts writes. */
function multipartParts(body: string, boundary: string): LoggedBody {
  const pieces = body.split(`--${boundary}`)
  const parts = pieces.slice(1, -1).map((piece) => {
    const split = piece.indexOf('\r\n\r\n')
    const headers = piece.slice(2, split)
    const contentType = /^content-type:\s*(.*)$/im.exec(headers)?.[1] ?? ''
    return { contentType, ...jsonOrText(piece.slice(split + 4, -2)) }
  })
  return { parts }
}

/** The log entry of a request google-drive.ts sends through `fetch`. */
export function logRequest(url: URL, init: RequestInit | undefined): LoggedRequest {
  const headers = new Headers(init?.headers)
  const entry: LoggedRequest = { method: init?.method ?? 'GET', path: url.pathname, query: queryPairs(url.searchParams) }
  const contentType = headers.get('Content-Type')
  if (contentType !== null) entry.contentType = contentType.replace(/;\s*boundary=.*$/, '')
  const body = init?.body
  if (typeof body === 'string') {
    const boundary = contentType === null ? undefined : /boundary=([^;]+)/.exec(contentType)?.[1]
    entry.body = boundary === undefined ? jsonOrText(body) : multipartParts(body, boundary)
  } else if (body !== undefined && body !== null) {
    throw new Error('the Drive client sent a body that is not text')
  }
  return entry
}
