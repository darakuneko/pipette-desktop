// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for src-tauri/crates/pipette-hub: the requests the
// Electron Hub API functions send and how they read each kind of answer,
// run in the Hub fixture harness (hub-harness.ts) against a scripted Hub
// that never connects.
//
// - ts_hub_request_log.json: every call of api-calls.ts answered with a
//   success, with the request it sent (written as request-log.ts
//   describes) and its result.
// - ts_hub_answers.json: one call per function against each kind of
//   answer in ANSWERS: the number of requests, the waits, and the result
//   or the error (its message and class, and `retryAfterSeconds` of a
//   429). A `TypeError` / `SyntaxError` (a body that is not the JSON the
//   code expects) is written by its class only: the Rust client's wording
//   of such failures is its own.
//
// Run: pnpm run generate:hub-fixtures

import { afterEach, describe, expect, it } from 'vitest'
import { writeJsonFixture } from '../fixture-files'
import { tagged } from '../analytics-db-fixtures/tagged'
import { FIXED_NOW } from '../sync-fixtures/harness'
import { CALLS, onePerFunction, runCall, type ApiCall } from './api-calls'
import { scriptedFetch, setRules, takeRecorded, unusedRules, withRecordedHubSleeps, type ScriptedResponse } from './hub-harness'
import { hubFixturePath } from './paths'

const guarded = globalThis.fetch

afterEach(() => {
  globalThis.fetch = guarded
})

/** The successful answer of `call`. */
function success(call: ApiCall): ScriptedResponse {
  return { status: 200, json: call.reader === 'download' ? call.data : { ok: true, data: call.data } }
}

const TOO_MANY: ScriptedResponse = { status: 429, text: 'Too Many Requests' }

/** Kinds of answers; each maps a call to the answers its rule gives. */
const ANSWERS: Array<{ name: string; responses: (call: ApiCall) => ScriptedResponse[] }> = [
  { name: 'success', responses: (c) => [success(c)] },
  { name: 'ok false with an error', responses: () => [{ status: 200, json: { ok: false, error: 'Name already taken' } }] },
  { name: 'ok false without an error', responses: () => [{ status: 200, json: { ok: false } }] },
  { name: 'ok false with a null error', responses: () => [{ status: 200, json: { ok: false, error: null } }] },
  { name: 'ok true without data', responses: () => [{ status: 200, json: { ok: true } }] },
  { name: 'bare data', responses: (c) => [{ status: 200, json: c.data }] },
  { name: 'bare object with ok', responses: () => [{ status: 200, json: { ok: 'yes', data: 1 } }] },
  { name: 'bare array', responses: () => [{ status: 200, json: [1, 2] }] },
  { name: 'json null', responses: () => [{ status: 200, json: null }] },
  { name: 'not json', responses: () => [{ status: 200, text: '<html>oops</html>' }] },
  { name: 'empty body', responses: () => [{ status: 200, text: '' }] },
  { name: '201 created', responses: (c) => [{ ...success(c), status: 201 }] },
  { name: '400', responses: () => [{ status: 400, text: '{"ok":false,"error":"Invalid title"}' }] },
  { name: '401', responses: () => [{ status: 401, text: '{"ok":false,"error":"Unauthorized"}' }] },
  { name: '403', responses: () => [{ status: 403, text: 'Forbidden' }] },
  { name: '404', responses: () => [{ status: 404, text: 'Not Found' }] },
  { name: '409', responses: () => [{ status: 409, text: '{"ok":false,"error":"Conflict"}' }] },
  { name: '413', responses: () => [{ status: 413, text: 'Payload Too Large' }] },
  { name: '500 empty', responses: () => [{ status: 500, text: '' }] },
  { name: '503', responses: () => [{ status: 503, text: 'Service Unavailable\nretry later' }] },
  { name: '429 without Retry-After', responses: () => [TOO_MANY, TOO_MANY] },
  { name: '429 Retry-After 2 then success', responses: (c) => [{ ...TOO_MANY, headers: { 'Retry-After': '2' } }, success(c)] },
  {
    name: '429 Retry-After 2 twice',
    responses: () => [
      { ...TOO_MANY, headers: { 'Retry-After': '2' } },
      { ...TOO_MANY, text: 'still', headers: { 'Retry-After': '3' } },
    ],
  },
  { name: '429 Retry-After 2 then 401', responses: () => [{ ...TOO_MANY, headers: { 'Retry-After': '2' } }, { status: 401, text: 'expired' }] },
  { name: '429 daily limit', responses: () => [{ status: 429, text: '{"ok":false,"error":"Daily upload limit"}', headers: { 'Retry-After': '43200' } }] },
]

function errorRecord(err: unknown): Record<string, unknown> {
  if (err instanceof TypeError || err instanceof SyntaxError) return { errorClass: err.name }
  if (!(err instanceof Error)) return { error: String(err) }
  const record: Record<string, unknown> = { error: err.message, errorClass: err.name }
  if ('retryAfterSeconds' in err) record.retryAfterSeconds = tagged((err as { retryAfterSeconds: unknown }).retryAfterSeconds)
  return record
}

async function record(call: ApiCall, responses: ScriptedResponse[]): Promise<Record<string, unknown>> {
  globalThis.fetch = scriptedFetch()
  setRules([{ method: call.method, path: call.path, responses }])
  const outcome = await withRecordedHubSleeps(async () => {
    try {
      return { result: tagged(await runCall(call)) }
    } catch (err) {
      return errorRecord(err)
    }
  })
  const { requests, sleeps } = takeRecorded()
  return { requests, sleeps, ...outcome }
}

describe('hub request log fixtures', () => {
  it('records the request of every API call', async () => {
    const calls = []
    for (const call of CALLS) {
      const { requests, sleeps, ...outcome } = await record(call, [success(call)])
      expect(unusedRules(), call.fn).toEqual([])
      expect(sleeps).toEqual([])
      calls.push({ ...call, answer: success(call), requests, ...outcome })
    }
    // The same requests on a second run.
    expect((await record(CALLS[11], [success(CALLS[11])])).requests).toEqual(calls[11].requests)
    writeJsonFixture(hubFixturePath('ts_hub_request_log.json'), {
      about:
        'The request each Hub API function of the Electron code sends (scripts/hub-fixtures/api-calls.ts) when the Hub answers with success, and its result. Requests are written as scripts/hub-fixtures/request-log.ts describes: method, path, sorted query, headers without user-agent / accept and without the multipart boundary, the body (JSON as value and text; multipart as the boundary with {now}, the parts and the whole body in base64 with the boundary written {boundary}). File arguments are {name, base64}. Generated by scripts/hub-fixtures/record-hub-request-log-fixtures.test.ts; do not edit.',
      hubBase: 'http://127.0.0.1:9',
      nowMs: FIXED_NOW,
      calls,
    })
  })

  it('records how every API function reads each kind of answer', async () => {
    const functions = []
    for (const call of onePerFunction()) {
      const answers = []
      for (const answer of ANSWERS) {
        const responses = answer.responses(call)
        const { requests, ...outcome } = await record(call, responses)
        answers.push({ answer: answer.name, responses, requests: (requests as unknown[]).length, ...outcome })
      }
      functions.push({ fn: call.fn, reader: call.reader, args: call.args, method: call.method, path: call.path, answers })
    }
    writeJsonFixture(hubFixturePath('ts_hub_answers.json'), {
      about:
        'One call per Hub API function of the Electron code against each kind of answer (scripts/hub-fixtures/record-hub-request-log-fixtures.test.ts ANSWERS): responses are the answers in order, requests the number sent, sleeps the waits in ms, then the result or the error (message, class, retryAfterSeconds of a Hub429Error). TypeError / SyntaxError are written by class only. Generated by that file; do not edit.',
      nowMs: FIXED_NOW,
      functions,
    })
  })
})
