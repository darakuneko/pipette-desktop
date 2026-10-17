// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-notification: boots
// Electron's src/main/index.ts on the harness and calls the
// NOTIFICATION_FETCH handler (`fetchNotifications` of notification-store.ts)
// against scripted answers. Nothing is sent: the harness's `net.fetch`
// records the request — the method, the endpoint written in Electron, the
// headers and the body bytes — and answers from the script.
//
// Each case is a scripted answer and the handler's result. `compare` says
// how much of the result the Rust port must match: `exact`, or `success`
// when the result is a failure whose `error` text is the JavaScript
// engine's (a JSON parse failure, a TypeError, a RangeError, a network
// error); `error` is compared only for `HTTP <status>` and
// `Invalid response format`.
//
// Run: pnpm run generate:resident-fixtures

import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { boot } from './boot'
import { FIXED_NOW, harnessState, invoke, scriptResponses, type RecordedRequest, type ScriptedResponse } from './harness'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-notification/tests/fixtures/notification.json')

const ok = (data: unknown): ScriptedResponse => ({ status: 200, body: JSON.stringify(data), contentType: 'application/json' })

const item = (publishedAt: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Title',
  body: 'Body',
  type: 'info',
  publishedAt,
  ...extra,
})

const firestore = (seconds: unknown, nanoseconds: unknown = 0): Record<string, unknown> => ({ _seconds: seconds, _nanoseconds: nanoseconds })

const COMPARED_ERROR = /^(HTTP \d+|Invalid response format)$/

interface Case {
  name: string
  response: ScriptedResponse
  result: unknown
  compare: 'exact' | 'success'
}

async function fetchCase(name: string, response: ScriptedResponse): Promise<Case & { request: RecordedRequest }> {
  harnessState().requests = []
  scriptResponses(response)
  const result = (await invoke(IpcChannels.NOTIFICATION_FETCH)) as { success: boolean; error?: string }
  const [request] = harnessState().requests
  expect(harnessState().requests).toHaveLength(1)
  const compare = result.success || COMPARED_ERROR.test(result.error ?? '') ? 'exact' : 'success'
  return { name, response, result, compare, request }
}

const RESPONSE_CASES: [string, ScriptedResponse][] = [
  [
    'two notices, an ISO date and a Firestore timestamp',
    ok({
      notifications: [
        item('2026-10-17T09:00:00.000Z', { title: 'Release 1.2', body: 'Line 1\nLine 2', type: 'release' }),
        item(firestore(1760000000, 123456789), { title: 'お知らせ', body: '本文 😀', type: 'info' }),
      ],
    }),
  ],
  ['an empty list', ok({ notifications: [] })],
  ['twelve notices kept in the order given', ok({ notifications: Array.from({ length: 12 }, (_, i) => item(`2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`, { title: `N${i}` })) })],
  [
    'items that are not notices are dropped',
    ok({
      notifications: [
        null, 1, 'x', [], {},
        item('2026-10-01T00:00:00Z'),
        { body: 'b', type: 't', publishedAt: '2026-10-01T00:00:00Z' },
        { title: 't', type: 't', publishedAt: '2026-10-01T00:00:00Z' },
        { title: 't', body: 'b', publishedAt: '2026-10-01T00:00:00Z' },
        { title: 't', body: 'b', type: 't' },
        item('2026-10-01T00:00:00Z', { title: 1 }),
        item('2026-10-01T00:00:00Z', { body: null }),
        item('2026-10-01T00:00:00Z', { type: false }),
        item(1760000000000),
        item(null),
        item({}),
        item(firestore('1760000000')),
        item(firestore(1760000000, '0')),
        item({ _seconds: 1760000000 }),
        item({ _nanoseconds: 0 }),
        item(''),
        item('not a date'),
        item('2026-10-02T00:00:00Z', { title: '', body: '', type: '', extra: 'dropped', id: 7 }),
      ],
    }),
  ],
  ['a Firestore timestamp with extra fields', ok({ notifications: [item({ _seconds: 0, _nanoseconds: 999999999, other: true })] })],
  [
    'Firestore seconds: fractions, negatives and the ends of the Date range',
    ok({
      notifications: [
        item(firestore(1760000000.5)),
        item(firestore(1760000000.0001)),
        item(firestore(1760000000.9999)),
        item(firestore(0)),
        item(firestore(-1)),
        item(firestore(-62198755200)),
        item(firestore(253402300800)),
        item(firestore(8640000000000)),
        item(firestore(-8640000000000)),
        item(firestore(1e-300)),
      ],
    }),
  ],
  ['Firestore seconds past the end of the Date range', ok({ notifications: [item(firestore(8640000000000.001)), item('2026-10-01T00:00:00Z')] })],
  ['Firestore seconds before the start of the Date range', ok({ notifications: [item(firestore(-8640000000001))] })],
  ['Firestore seconds of 1e300', ok({ notifications: [item(firestore(1e300))] })],
  ['notifications is an object', ok({ notifications: {} })],
  ['notifications is null', ok({ notifications: null })],
  ['notifications is a string', ok({ notifications: 'x' })],
  ['notifications is missing', ok({})],
  ['the body is an array', ok([item('2026-10-01T00:00:00Z')])],
  ['the body is a string', ok('notifications')],
  ['the body is a number', ok(1)],
  ['the body is null', ok(null)],
  ['the body is not JSON', { status: 200, body: 'not json', contentType: 'text/plain' }],
  ['the body is empty', { status: 200, body: '' }],
  ['the body starts with a byte order mark', { status: 200, body: '﻿{"notifications":[]}' }],
  ['the body has trailing whitespace', { status: 200, body: '{"notifications":[]}\n\t ' }],
  ['the content type is text/plain', { status: 200, body: '{"notifications":[]}', contentType: 'text/plain' }],
  ['201', { status: 201, body: '{"notifications":[]}' }],
  ['299', { status: 299, body: '{"notifications":[]}' }],
  ['204 without a body', { status: 204, body: null }],
  ['300', { status: 300, body: '{"notifications":[]}' }],
  ['304 without a body', { status: 304, body: null }],
  ['404', { status: 404, body: 'Not Found' }],
  ['429', { status: 429, body: '{"notifications":[]}' }],
  ['500', { status: 500, body: '{"error":"internal"}' }],
  ['503 without a body', { status: 503, body: null }],
  ['a network error', { networkError: 'fetch failed' }],
]

type DateCategory = 'es' | 'rfc2822' | 'other'

/** `publishedAt` strings: the notice is kept when `Date.parse` reads the
 *  string. `es` are strings in ECMAScript's date-time string format with
 *  every field in range, whose reading the standard fixes; `rfc2822` are
 *  RFC 2822 dates; `other` are strings outside the standard format or with
 *  a field out of range, which only V8's fallback parser decides. Strings
 *  without a zone are read as local time, so none sits at the ends of the
 *  Date range (where the local zone would decide). */
const DATES: [DateCategory, string][] = [
  ['es', '2026-10-18T00:00:00Z'],
  ['es', '2026-10-18T00:00:00.000Z'],
  ['es', '2026-10-18T00:00:00.1Z'],
  ['es', '2026-10-18T00:00:00.123456Z'],
  ['es', '2026-10-18T09:00:00+09:00'],
  ['es', '2026-10-18T09:00:00-09:30'],
  ['es', '2026-10-18T00:00Z'],
  ['es', '2026-10-18T00:00:00'],
  ['es', '2026-10-18T00:00'],
  ['es', '2026-10-18'],
  ['es', '2026-10'],
  ['es', '2026'],
  ['es', '+002026-10-18T00:00:00Z'],
  ['es', '-000001-01-01T00:00:00Z'],
  ['es', '+275760-09-13T00:00:00.000Z'],
  ['es', '+275760-09-13T00:00:00.001Z'],
  ['es', '-271821-04-20T00:00:00.000Z'],
  ['es', '-271821-04-19T23:59:59.999Z'],
  ['es', '-000000-01-01T00:00:00Z'],
  ['es', '2026-10-18T24:00:00Z'],
  ['other', '2026-10-18T24:00:01Z'],
  ['other', '2026-10-18T23:59:60Z'],
  ['es', '2026-02-29T00:00:00Z'],
  ['other', '2026-02-30T00:00:00Z'],
  ['other', '2026-02-31T00:00:00Z'],
  ['other', '2026-04-31T00:00:00Z'],
  ['other', '2026-13-01T00:00:00Z'],
  ['other', '2026-00-01T00:00:00Z'],
  ['other', '2026-10-32T00:00:00Z'],
  ['other', '2026-10-00T00:00:00Z'],
  ['other', '2026-10-18T25:00:00Z'],
  ['other', '2026-10-18T00:60:00Z'],
  ['other', '2026-10-18t00:00:00z'],
  ['other', '2026-10-18T00:00:00+0900'],
  ['other', '2026-10-18T00:00:00+09'],
  ['other', '20261018T000000Z'],
  ['other', ' 2026-10-18T00:00:00Z'],
  ['other', '2026-10-18T00:00:00Z '],
  ['rfc2822', 'Sun, 18 Oct 2026 00:00:00 GMT'],
  ['rfc2822', 'Sun, 18 Oct 2026 00:00:00 +0900'],
  ['rfc2822', 'Sun, 18 Oct 2026 00:00:00 -0000'],
  ['rfc2822', '18 Oct 2026 00:00:00 GMT'],
  ['rfc2822', 'Sun, 18 Oct 2026 00:00 GMT'],
  ['rfc2822', 'Mon, 18 Oct 2026 00:00:00 GMT'],
  ['rfc2822', 'Sun, 18 Oct 26 00:00:00 GMT'],
  ['rfc2822', 'Sun, 32 Oct 2026 00:00:00 GMT'],
  ['rfc2822', 'Sun, 18 Foo 2026 00:00:00 GMT'],
  ['other', '2026/10/18'],
  ['other', '2026/10/18 12:34:56'],
  ['other', '10/18/2026'],
  ['other', 'Oct 18 2026'],
  ['other', 'October 18, 2026 10:00'],
  ['other', '2026-10-18 00:00:00'],
  ['other', '2026-10-18 00:00:00Z'],
  ['other', 'Sun Oct 18 2026 09:00:00 GMT+0900 (Japan Standard Time)'],
  ['other', '0'],
  ['other', '1'],
  ['other', '12'],
  ['other', '13'],
  ['other', '32'],
  ['other', '2026-10-18T00:00:00 Z'],
  ['other', 'tomorrow'],
  ['other', 'not a date'],
  ['other', ' '],
  ['other', ''],
]

describe('startup notice', () => {
  it('records the notice fetch of index.ts', async () => {
    await boot()
    const cases: (Case & { request: RecordedRequest })[] = []
    for (const [name, response] of RESPONSE_CASES) cases.push(await fetchCase(name, response))

    const dates: { input: string; category: DateCategory; kept: boolean }[] = []
    for (const [category, input] of DATES) {
      const c = await fetchCase(`date ${input}`, ok({ notifications: [item(input)] }))
      const result = c.result as { success: boolean; notifications: { publishedAt: string }[] }
      expect(result.success).toBe(true)
      if (result.notifications.length > 0) expect(result.notifications[0].publishedAt).toBe(input)
      dates.push({ input, category, kept: result.notifications.length > 0 })
    }

    // The request: the same on every call but for the clock in `value`.
    const requests: { now: number; request: RecordedRequest }[] = []
    for (const now of [FIXED_NOW, 0, 1, 8640000000000, Date.UTC(2030, 0, 1, 12, 34, 56, 789)]) {
      vi.setSystemTime(now)
      const c = await fetchCase('request', ok({ notifications: [] }))
      requests.push({ now, request: c.request })
    }
    for (const c of cases) expect(c.request).toEqual({ ...requests[0].request })

    writeJsonFixture(OUT, {
      source: 'fetchNotifications of src/main/notification-store.ts through src/main/index.ts booted on scripts/resident-fixtures; nothing was sent',
      requests,
      cases: cases.map(({ request: _request, ...rest }) => rest),
      dates,
    })
  })
})
