// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for src-tauri/crates/pipette-hub: the pure
// functions of the Electron Hub code on tables, run in the Hub fixture
// harness (hub-harness.ts).
//
// - ts_hub_pure.json: the input checks of hub-ipc-shared.ts (title,
//   display name, keyboard name, post id, clampInt, computeTotalPages,
//   sanitizeFilenameBase, buildFiles with its size limits), Node's
//   base64 decode, isValidHubVialProtocol, validatePack and
//   validateI18nExport. Values JSON cannot carry are tagged
//   (../analytics-db-fixtures/tagged.ts); long inputs are written as
//   `{ $repeat, count }` (expand.ts).
// - ts_hub_retry_after.json: how each of the three ways the Hub client
//   reads an answer treats a 429 with a `Retry-After` value: the wait
//   (in ms) before the one retry, or the error and its
//   `retryAfterSeconds`. `kind` says which rule decides: `number` (JS
//   `Number`), `rfc7231` (an IMF-fixdate or RFC 850 date with the right
//   weekday), `jsOnly` (only `Date.parse` reads it; the Rust client does
//   not) or `none`. The asctime form is left out: `Date.parse` reads it
//   in the local time zone. Header values are what an HTTP header can
//   carry (no surrounding whitespace, which HTTP strips; Latin-1 only).
//
// Run: pnpm run generate:hub-fixtures

import { afterEach, describe, expect, it } from 'vitest'
import { writeJsonFixture } from '../fixture-files'
import { tagged } from '../analytics-db-fixtures/tagged'
import { FIXED_NOW } from '../sync-fixtures/harness'
import { expand, repeat } from './expand'
import { scriptedFetch, setRules, takeRecorded, withRecordedHubSleeps, type HubRule } from './hub-harness'
import { hubFixturePath } from './paths'
import {
  buildFiles,
  clampInt,
  computeTotalPages,
  sanitizeFilenameBase,
  validateDisplayName,
  validateKeyboardName,
  validatePostId,
  validateTitle,
} from '../../src/main/hub/hub-ipc-shared'
import { validatePack } from '../../src/shared/i18n/validate'
import { validateI18nExport } from '../../src/main/hub/hub-i18n'
import { isValidHubVialProtocol } from '../../src/shared/favorite-data'
import { fetchAuthMe, Hub429Error } from '../../src/main/hub/hub-client'
import { downloadI18nPostBody, fetchI18nPackTimestamps } from '../../src/main/hub/hub-i18n'
import { fetchKeyLabelTimestamps } from '../../src/main/hub/hub-key-labels'
import type { HubUploadPostParams } from '../../src/shared/types/hub'

const guarded = globalThis.fetch

afterEach(() => {
  globalThis.fetch = guarded
})

type Outcome = { ok: unknown } | { error: string }

function outcome(run: () => unknown): Outcome {
  try {
    return { ok: tagged(run()) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

const NON_STRINGS: unknown[] = [undefined, null, 0, 5, true, {}, [], ['a']]

/** Text inputs for the length checks: JS whitespace around the text, and
 *  lengths in UTF-16 code units on both sides of each limit. */
function textInputs(limit: number): unknown[] {
  return [
    '',
    ' ',
    '\t\n\r\v\f',
    '        　﻿',
    '​',
    '\u0085',
    'a',
    '  padded  ',
    '　全角　',
    'line\nbreak',
    'x'.repeat(limit),
    'x'.repeat(limit + 1),
    ` ${'x'.repeat(limit)} `,
    '😀'.repeat(limit / 2),
    '😀'.repeat(limit / 2) + 'x',
    'x'.repeat(limit - 1) + '😀',
    'é'.repeat(limit),
    'é'.repeat(limit / 2),
    'Lone \ud800',
    '\udc00',
    ...NON_STRINGS,
  ]
}

const POST_IDS: unknown[] = [
  'abc',
  'ABC-xyz_019',
  '-',
  '_',
  '',
  ' abc',
  'abc ',
  'a b',
  'a/b',
  'a.b',
  '..',
  'a%2Fb',
  'é',
  '😀',
  'abc\n',
  'x'.repeat(500),
  ...NON_STRINGS,
]

const NUMBERS: unknown[] = [
  undefined,
  null,
  0,
  -0,
  1,
  1.9,
  -1.5,
  0.5,
  99,
  100,
  100.5,
  101,
  1e21,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  Number.MIN_SAFE_INTEGER,
  NaN,
  Infinity,
  -Infinity,
]

const PAGES: Array<[number, number]> = [
  [0, 20],
  [1, 20],
  [20, 20],
  [21, 20],
  [100, 0],
  [100, -5],
  [-10, 20],
  [NaN, 20],
  [Infinity, 20],
  [5, NaN],
  [5, Infinity],
  [5, 0.5],
  [10, 3],
  [1e21, 7],
]

const FILENAME_BASES: Array<[string, string]> = [
  ['Corne', 'uid'],
  ['My Board v2', '0x1'],
  ['', '0xABCD'],
  ['', ''],
  ['キーボード', 'uid'],
  ['😀', 'uid'],
  ['a😀b', 'uid'],
  ['é', 'uid'],
  ['a-b_c.d', 'uid'],
  ['Lone \ud800', 'uid'],
]

const BASE64: string[] = [
  '',
  'QQ==',
  'QQ',
  'QQ=',
  'QUJD',
  'QUJDRA==',
  'Q U J D',
  'QUJD\nRA==',
  'QU=JD',
  'QUJD====',
  '=QUJD',
  '-_-_',
  '+/+/',
  'QUJD!@#$',
  'data:image/jpeg;base64,QUJD',
  '////',
  'A',
  'AB',
  'ABC',
  'ABCDE',
  '日本',
  '\u0000QUJD',
]

const KEYBOARD_NAMES: string[] = ['Corne', 'My Board', 'キーボード', '😀', '', '../etc', 'a.b']

function postParams(over: Partial<HubUploadPostParams> = {}): HubUploadPostParams {
  return {
    title: 'Title',
    keyboardName: 'Corne',
    vilJson: '{"version":1}',
    pipetteJson: '{"pipette":true}',
    keymapC: 'const uint16_t keymaps[] = {};\n',
    pdfBase64: 'JVBERi0=',
    thumbnailBase64: '/9j/4A==',
    ...over,
  }
}

const MB = 1024 * 1024
/** Base64 text that decodes to exactly `bytes` bytes (`bytes` % 3 == 0). */
const b64Of = (bytes: number) => repeat('AAAA', bytes / 3)

/** buildFiles cases; long base64 and text inputs are `$repeat`s. Sizes on
 *  both sides of each limit, and several files over at once (the first
 *  in the limit table's order is reported). */
const BUILD_FILES: Array<Record<string, unknown>> = [
  {},
  { keyboardName: 'My Board/v2 😀' },
  { pdfBase64: '', thumbnailBase64: '' },
  { pdfBase64: 'not base64 !!', thumbnailBase64: 'QUJD\nRA==' },
  { thumbnailBase64: b64Of(2 * MB - 2) },
  { thumbnailBase64: b64Of(2 * MB + 1) },
  { vilJson: repeat('x', 10 * MB) },
  { vilJson: repeat('x', 10 * MB + 1) },
  { vilJson: repeat('é', 5 * MB) },
  { vilJson: repeat('é', 5 * MB + 1) },
  { pipetteJson: repeat('x', 10 * MB + 1) },
  { keymapC: repeat('x', 10 * MB + 1) },
  { pdfBase64: b64Of(10 * MB + 2) },
  { pdfBase64: b64Of(10 * MB + 2), keymapC: repeat('x', 10 * MB + 1), vilJson: repeat('x', 10 * MB + 1) },
  { pdfBase64: b64Of(10 * MB + 2), thumbnailBase64: b64Of(2 * MB + 1) },
]

const VIAL_PROTOCOLS: unknown[] = [0, 1, 6, -1, 1.5, -0, NaN, Infinity, '6', null, undefined, Number.MAX_SAFE_INTEGER, 2 ** 53]

const pack = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'Pack', version: '1.0.0', common: { save: 'Save' }, ...extra })

const PACKS: unknown[] = [
  pack(),
  { name: 'Pack', version: '1.0.0' },
  pack({ name: '  Spaced  ', version: ' 2.0.0 ' }),
  pack({ name: '' }),
  pack({ name: ' ' }),
  pack({ name: 'x'.repeat(64) }),
  pack({ name: 'x'.repeat(65) }),
  pack({ name: '😀'.repeat(32) }),
  pack({ name: '😀'.repeat(32) + 'x' }),
  pack({ name: 5 }),
  pack({ version: '1.0' }),
  pack({ version: 'v1.0.0' }),
  pack({ version: '1.0.0-beta.1' }),
  pack({ version: '1.0.0-' }),
  pack({ version: '１.0.0' }),
  pack({ version: 1 }),
  pack({ common: { save: 5 } }),
  pack({ common: { list: ['a', 'b'] } }),
  pack({ common: { list: ['a', 1, null] } }),
  pack({ 'bad key': 'x' }),
  pack({ 'ok-key_1': 'x' }),
  pack({ 'ключ': 'x' }),
  pack({ a: { b: { c: { d: { e: { f: { g: { h: 'deep' } } } } } } } }),
  pack({ a: { b: { c: { d: { e: { f: { g: { h: { i: 'too deep' } } } } } } } } }),
  pack({ a: null }),
  pack({ a: {} }),
  JSON.parse('{"name":"P","version":"1.0.0","__proto__":{"x":"y"},"constructor":"c"}'),
  JSON.parse('{"name":"P","version":"1.0.0","a":{"prototype":"p","b":"ok"}}'),
  pack({ big: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`k${i}`, 'v'])) }),
  pack({ big: Object.fromEntries(Array.from({ length: 4999 }, (_, i) => [`k${i}`, 'v'])) }),
  null,
  5,
  'pack',
  [],
  [pack()],
  {},
]

const EXPORTS: unknown[] = [
  { version: 1, kind: 'i18n', exportedAt: '2026-10-16T00:00:00.000Z', pack: pack() },
  { version: 1, kind: 'i18n', exportedAt: '', pack: { name: 'P', version: '1.0.0' } },
  { version: 1, kind: 'i18n', exportedAt: 'whenever', pack: pack({ version: 'x' }) },
  { version: 2, kind: 'i18n', exportedAt: 'x', pack: pack() },
  { version: '1', kind: 'i18n', exportedAt: 'x', pack: pack() },
  { kind: 'i18n', exportedAt: 'x', pack: pack() },
  { version: 1, kind: 'theme', exportedAt: 'x', pack: pack() },
  { version: 1, exportedAt: 'x', pack: pack() },
  { version: 1, kind: 'i18n', exportedAt: 5, pack: pack() },
  { version: 1, kind: 'i18n', exportedAt: 'x' },
  { version: 1, kind: 'i18n', exportedAt: 'x', pack: null },
  { version: 1, kind: 'i18n', exportedAt: 'x', pack: { name: '', version: '' } },
  { version: 1, kind: 'i18n', exportedAt: 'x', pack: JSON.parse('{"name":"P","version":"1.0.0","__proto__":{}}') },
  [],
  null,
  0,
  '',
  'export',
]

// --- Retry-After ---

const RFC_IMF = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/
const RFC_850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function retryAfterKind(header: string): 'number' | 'rfc7231' | 'jsOnly' | 'none' {
  if (header === '') return 'none'
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return 'number'
  const date = Date.parse(header)
  if (Number.isNaN(date)) return 'none'
  const weekday = WEEKDAYS[new Date(date).getUTCDay()]
  if ((RFC_IMF.test(header) || RFC_850.test(header)) && header.startsWith(weekday.slice(0, 3))) return 'rfc7231'
  return 'jsOnly'
}

const RETRY_AFTER: string[] = [
  '',
  '0',
  '1',
  '30',
  '60',
  '60.0001',
  '61',
  '86400',
  '1.5',
  '0.001',
  '.5',
  '5.',
  '5 0',
  '0x10',
  '0X3c',
  '0x3d',
  '0b11',
  '0o7',
  '1e1',
  '6e1',
  '6.1e1',
  '+3',
  '-0',
  '00012',
  '1_000',
  'Infinity',
  '-1',
  '-30',
  'abc',
  'NaN',
  'Fri, 16 Oct 2026 00:00:30 GMT',
  'Fri, 16 Oct 2026 00:01:00 GMT',
  'Fri, 16 Oct 2026 00:01:01 GMT',
  'Fri, 16 Oct 2026 00:00:00 GMT',
  'Thu, 15 Oct 2026 23:00:00 GMT',
  'Sat, 17 Oct 2026 00:00:00 GMT',
  'Friday, 16-Oct-26 00:00:10 GMT',
  'Thu, 16 Oct 2026 00:00:30 GMT',
  'fri, 16 oct 2026 00:00:30 gmt',
  'Fri, 16 Oct 2026 00:00:30 UTC',
  'Fri, 16 Oct 2026 00:00:30 +0000',
  '16 Oct 2026 00:00:30 GMT',
  '2026-10-16T00:00:30Z',
  '2026-10-16T00:00:30.500Z',
]

/** The three ways the Hub client reads an answer, each through one
 *  function that uses it. */
const READERS: Array<{ reader: string; via: string; rule: (responses: HubRule['responses']) => HubRule; call: () => Promise<unknown> }> = [
  {
    reader: 'strict',
    via: 'hub-client.ts fetchAuthMe',
    rule: (responses) => ({ method: 'GET', path: '/api/auth/me', responses }),
    call: () => fetchAuthMe('jwt'),
  },
  {
    reader: 'strict',
    via: 'hub-key-labels.ts fetchKeyLabelTimestamps',
    rule: (responses) => ({ method: 'POST', path: '/api/key-labels/timestamps', responses }),
    call: () => fetchKeyLabelTimestamps(['a']),
  },
  {
    reader: 'lenient',
    via: 'hub-i18n.ts fetchI18nPackTimestamps',
    rule: (responses) => ({ method: 'POST', path: '/api/i18n-packs/timestamps', responses }),
    call: () => fetchI18nPackTimestamps(['a']),
  },
  {
    reader: 'download',
    via: 'hub-i18n.ts downloadI18nPostBody',
    rule: (responses) => ({ method: 'GET', path: '/api/i18n-packs/a/download', responses }),
    call: () => downloadI18nPostBody('a'),
  },
]

describe('hub pure fixtures', () => {
  it('records the input checks and validators', () => {
    const table = <T>(inputs: readonly T[], run: (input: T) => unknown) =>
      inputs.map((input) => ({ input: tagged(input), ...outcome(() => run(input)) }))

    const buildFilesCases = BUILD_FILES.map((over) => {
      const params = expand(postParams(over as Partial<HubUploadPostParams>)) as HubUploadPostParams
      const result = outcome(() => {
        const files = buildFiles(params)
        return Object.fromEntries(
          Object.entries(files).map(([key, file]) => [
            key,
            {
              name: file.name,
              bytes: file.data.byteLength,
              // Small files are written out; large ones by size only.
              ...(file.data.byteLength <= 64 ? { base64: file.data.toString('base64') } : {}),
            },
          ]),
        )
      })
      return { input: postParams(over as Partial<HubUploadPostParams>), ...result }
    })

    writeJsonFixture(hubFixturePath('ts_hub_pure.json'), {
      about:
        'Pure functions of the Electron Hub code on tables (scripts/hub-fixtures/record-hub-pure-fixtures.test.ts; do not edit). Inputs: values JSON cannot carry are tagged ({$n} for NaN / ±Infinity / -0, {$u} for undefined); {$repeat, count} is a repeated string. Each case has `ok` (the tagged return value) or `error` (the thrown message).',
      validateTitle: table(textInputs(200), validateTitle),
      validateDisplayName: table(textInputs(50), validateDisplayName),
      validateKeyboardName: table(textInputs(100), validateKeyboardName),
      validatePostId: table(POST_IDS, (id) => {
        validatePostId(id as string)
        return null
      }),
      clampInt: [
        ...table(NUMBERS, (value) => ({ min: 1, max: Number.MAX_SAFE_INTEGER, result: clampInt(value as number, 1, Number.MAX_SAFE_INTEGER) })),
        ...table(NUMBERS, (value) => ({ min: 1, max: 100, result: clampInt(value as number, 1, 100) })),
      ],
      computeTotalPages: table(PAGES, ([total, perPage]) => computeTotalPages(total, perPage)),
      sanitizeFilenameBase: table(FILENAME_BASES, ([name, fallback]) => sanitizeFilenameBase(name, fallback)),
      base64Decode: BASE64.map((input) => ({ input, hex: Buffer.from(input, 'base64').toString('hex') })),
      keyboardFileBase: KEYBOARD_NAMES.map((keyboardName) => ({
        input: keyboardName,
        names: Object.fromEntries(Object.entries(buildFiles(postParams({ keyboardName }))).map(([key, file]) => [key, file.name])),
      })),
      buildFiles: buildFilesCases,
      isValidHubVialProtocol: table(VIAL_PROTOCOLS, isValidHubVialProtocol),
      validatePack: table(PACKS, (raw) => validatePack(raw)),
      validateI18nExport: table(EXPORTS, validateI18nExport),
    })
  })

  it('records how each reader treats Retry-After', async () => {
    const cases = []
    for (const header of RETRY_AFTER) {
      const results = []
      for (const reader of READERS) {
        globalThis.fetch = scriptedFetch()
        setRules([
          reader.rule([
            { status: 429, text: 'Too Many Requests', headers: { 'Retry-After': header } },
            { status: 200, json: { ok: true, data: { items: [] } } },
          ]),
        ])
        const result = await withRecordedHubSleeps(async () => {
          try {
            await reader.call()
            return { retried: true }
          } catch (err) {
            if (!(err instanceof Hub429Error)) throw err
            return { error: err.message, retryAfterSeconds: tagged(err.retryAfterSeconds) }
          }
        })
        const { sleeps, requests } = takeRecorded()
        results.push({ reader: reader.reader, via: reader.via, requests: requests.length, sleepsMs: sleeps, ...result })
      }
      cases.push({ header, kind: retryAfterKind(header), results })
    }
    expect(Date.now()).toBe(FIXED_NOW)
    writeJsonFixture(hubFixturePath('ts_hub_retry_after.json'), {
      about:
        'A 429 with Retry-After, then a 200, through each way the Hub client reads an answer (strict: hub-client.ts / hub-key-labels.ts hubFetch; lenient: hub-i18n.ts / hub-theme.ts hubFetchJson; download: the raw i18n / key-label download). sleepsMs is the wait before the one retry. kind: number (JS Number), rfc7231 (IMF-fixdate / RFC 850 with the right weekday), jsOnly (only Date.parse reads it; the Rust client does not), none. Generated by scripts/hub-fixtures/record-hub-pure-fixtures.test.ts; do not edit.',
      nowMs: FIXED_NOW,
      cases,
    })
  })
})
