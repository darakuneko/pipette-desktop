// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the files of src-tauri/crates/pipette-typing-analytics
// that the TypeScript code writes and reads, recorded from the real code on
// userData directories built in a temp directory.
//
// - jsonl_rows.json — the composite row ids (jsonl-row.ts), the line
//   `serializeRow` writes for rows built the way the recorder builds them
//   (number forms V8 writes differently, NaN / Infinity / -0, undefined
//   fields, lone surrogates, array-index keys), and what `parseRow` makes
//   of each line (null, or the line `serializeRow` writes back for it).
// - jsonl_files.json — `appendRowsToFile` on each starting file, `readRows`
//   on file bytes, the UTC days (utc-day.ts) and the day and deleted-range
//   listings of a userData tree (paths.ts).
// - deleted_ranges.json — the deleted-ranges store (deleted-ranges-store.ts)
//   on each starting file: the strict and lenient reads, the bundle text and
//   a union update; `clipToUtcDay`; the applied-ids record
//   (`recordOwnDeletedRangeApplied`, deleted-ranges-apply.ts).
// - keymap_snapshots.json — the three keymap-snapshot IPC handlers
//   (typing-analytics-ipc-analyze.ts) run in order on one userData
//   directory: each response as JSON text, then the tree they left.
//
// Run: pnpm run generate:analytics-db-fixtures

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { buildTree, recordTree, type Tree } from '../keyboard-store-fixtures/fixture-tree'
import { ANALYTICS_FIXTURES_DIR } from './paths'
import { tagged } from './tagged'

const pinned = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({ app: { getPath: () => pinned.userData } }))
vi.mock('../../src/main/logger', () => ({ log: () => undefined }))
vi.mock('../../src/main/typing-analytics/app-monitor', () => ({ getCurrentAppName: async () => null }))
vi.mock('../../src/main/typing-analytics/machine-hash', () => ({ getMachineHash: async () => OWN_HASH }))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    pinned.handlers.set(channel, handler)
  },
}))

import {
  bigramMinuteRowId,
  charMinuteRowId,
  matrixMinuteRowId,
  minuteStatsRowId,
  parseRow,
  scopeRowId,
  serializeRow,
  sessionRowId,
  trigramMinuteRowId,
  type JsonlRow,
} from '../../src/main/typing-analytics/jsonl/jsonl-row'
import { appendRowsToFile } from '../../src/main/typing-analytics/jsonl/jsonl-writer'
import { readRows } from '../../src/main/typing-analytics/jsonl/jsonl-reader'
import { isUtcDay, utcDayBoundaryMs, utcDayFromMs } from '../../src/main/typing-analytics/jsonl/utc-day'
import {
  listAllDeviceDayJsonlFiles,
  listDeletedRangesHashes,
  listDeviceDays,
} from '../../src/main/typing-analytics/jsonl/paths'
import {
  bundleDeletedRanges,
  readDeletedRanges,
  readDeletedRangesSync,
  updateDeletedRanges,
} from '../../src/main/typing-analytics/deleted-ranges-store'
import {
  clipToUtcDay,
  serializeDeletedRanges,
  unionDeletedRanges,
  type DeletedRangeEntry,
} from '../../src/main/typing-analytics/deleted-ranges'
import { recordOwnDeletedRangeApplied } from '../../src/main/typing-analytics/deleted-ranges-apply'
import { registerAnalyzeIpc } from '../../src/main/typing-analytics/typing-analytics-ipc-analyze'
import { IpcChannels } from '../../src/shared/ipc/channels'

const OWN_HASH = 'hash-own'
const NOW = Date.UTC(2026, 9, 16, 12, 34, 56, 789)

function freshUserData(): string {
  pinned.userData = mkdtempSync(join(tmpdir(), 'pipette-ta-jsonl-'))
  return pinned.userData
}

afterEach(() => {
  if (pinned.userData) rmSync(pinned.userData, { recursive: true, force: true })
  pinned.userData = ''
})

/** A path under the userData directory with `/` separators. */
function rel(userData: string, path: string): string {
  return relative(userData, path).split(sep).join('/')
}

async function outcome<T>(run: () => Promise<T> | T): Promise<{ value: T } | { error: true }> {
  try {
    return { value: await run() }
  } catch {
    return { error: true }
  }
}

// --- rows ---------------------------------------------------------------

const H = [1, 0, 0, 2, 3, 1, 2, 1]

/** Rows the way typing-analytics-rows.ts and the day delete build them. */
function sampleRows(): JsonlRow[] {
  const scope: JsonlRow = {
    id: scopeRowId('hash-a|linux|6.8.0|x64|0xAABB'),
    kind: 'scope',
    updated_at: 1_000,
    payload: {
      id: 'hash-a|linux|6.8.0|x64|0xAABB',
      machineHash: 'hash-a',
      osPlatform: 'linux',
      osRelease: '6.8.0',
      osArch: 'x64',
      keyboardUid: '0xAABB',
      keyboardVendorId: 0xfeed,
      keyboardProductId: 1,
      keyboardProductName: 'Pipette "60" \\ 日本 😀 \u2028',
    },
  }
  const chars: JsonlRow[] = ['a', '|', '%', ' ', '日', '😀'].map((char, i) => ({
    id: charMinuteRowId('s|1', 60_000, i % 2 === 0 ? '' : 'run 1', char),
    kind: 'char-minute',
    updated_at: 2_000 + i,
    payload: { scopeId: 's|1', minuteTs: 60_000, char, count: i + 1, appName: undefined, typingTest: null, runId: '' },
  }))
  const loneSurrogate: JsonlRow = {
    id: 'char|s|60000||lone',
    kind: 'char-minute',
    updated_at: 2_100,
    payload: { scopeId: 's', minuteTs: 60_000, char: '\ud800', count: 1, appName: 'App \udc00', typingTest: 'words (english)', runId: 'r' },
  }
  const matrix: JsonlRow = {
    id: matrixMinuteRowId('s', 60_000, 'run-1', 2, 3, 1),
    kind: 'matrix-minute',
    updated_at: 3_000,
    payload: {
      scopeId: 's',
      minuteTs: 60_000,
      row: 2,
      col: 3,
      layer: 1,
      keycode: 0x5100,
      count: 5,
      tapCount: 3,
      holdCount: 2,
      ...{ dh: [0, 1, 1e21, 1e-7, 0.1 + 0.2, -0, 123e-20, 999999999999999900000], ds: 1e21, dq: 1.5e-7 },
      appName: 'Editor',
      typingTest: undefined,
      runId: 'run-1',
    },
  }
  const stats: JsonlRow = {
    id: minuteStatsRowId('s', 60_000, ''),
    kind: 'minute-stats',
    updated_at: 4_000,
    payload: {
      scopeId: 's',
      minuteTs: 60_000,
      keystrokes: 10,
      activeMs: 0.1 + 0.2,
      intervalAvgMs: Number.NaN,
      intervalMinMs: -0,
      intervalP25Ms: 1e-6,
      intervalP50Ms: 1e-7,
      intervalP75Ms: 2 ** 53 + 2,
      intervalMaxMs: Infinity,
      ...{ pollP50Ms: 5e-324, pollP95Ms: 1.7976931348623157e308 },
      appName: null,
      typingTest: null,
      runId: '',
    },
  }
  const bigram: JsonlRow = {
    id: bigramMinuteRowId('s', 60_000, ''),
    kind: 'bigram-minute',
    updated_at: 5_000,
    payload: {
      scopeId: 's',
      minuteTs: 60_000,
      bigrams: {
        '4_11': { c: 10, h: H, s: 1_200.5, sq: 1e21, oc: 1, on: 2 },
        '10_2': { c: 2, h: H },
        '2': { c: 1, h: H, s: -Infinity, sq: Number.NaN },
        '0': { c: 1, h: H },
      },
      appName: null,
      typingTest: null,
      runId: '',
    },
  }
  const trigram: JsonlRow = {
    id: trigramMinuteRowId('s', 60_000, 'run-1'),
    kind: 'trigram-minute',
    updated_at: 5_001,
    payload: {
      scopeId: 's',
      minuteTs: 60_000,
      trigrams: { '4_11_7': { c: 6, h: H, s: 720, sq: 96_000 } },
      appName: null,
      typingTest: null,
      runId: 'run-1',
    },
  }
  const session: JsonlRow = {
    id: sessionRowId('uuid|1'),
    kind: 'session',
    updated_at: 6_000,
    payload: { id: 'uuid|1', scopeId: 's', startMs: 1_000, endMs: 2_000 },
  }
  // A delete mark: the row copied with the flag added and updated_at
  // replaced in place.
  const mark = { ...chars[0], is_deleted: true, updated_at: 9_000.5 } as JsonlRow
  return [scope, ...chars, loneSurrogate, matrix, stats, bigram, trigram, session, mark]
}

const ID_CALLS: Array<[string, unknown[]]> = [
  ['scope', ['hash|linux|uid']],
  ['scope', ["a b%c/d?e#f&g=h+i;j,k:l@m$n!o'p(q)r*s~t-u_v.w"]],
  ['scope', ['日本 😀 é']],
  ['char', ['s', 60_000, '', 'a']],
  ['char', ['s', 60_000, 'run-1', '|']],
  ['char', ['s', 60_000, 'run 1', '😀']],
  ['char', ['s', 1e21, '', 'a']],
  ['char', ['s', 1.5, '', 'a']],
  ['char', ['s', -0, '', 'a']],
  ['char', ['s', 0.1 + 0.2, '', 'a']],
  ['matrix', ['s', 60_000, '', 2, 3, 1]],
  ['matrix', ['s', 60_000, 'run|1', 1.5, -0, 1e-7]],
  ['stats', ['s', 60_000, '']],
  ['stats', ['s', 60_000, 'run/1']],
  ['session', ['uuid|1']],
  ['bigram', ['s', 60_000, 'run-1']],
  ['trigram', ['s', 999999999999999900000, '']],
]

const ID_FUNCTIONS: Record<string, (...args: never[]) => string> = {
  scope: scopeRowId,
  char: charMinuteRowId,
  matrix: matrixMinuteRowId,
  stats: minuteStatsRowId,
  session: sessionRowId,
  bigram: bigramMinuteRowId,
  trigram: trigramMinuteRowId,
}

const HIST = '[0,2,0,0,0,0,0,0]'
const STATS = '"scopeId":"s","minuteTs":60000,"keystrokes":1,"activeMs":1,"intervalAvgMs":null,"intervalMinMs":null,"intervalP25Ms":null,"intervalP50Ms":null,"intervalP75Ms":null,"intervalMaxMs":null'
const MATRIX = '"scopeId":"s","minuteTs":60000,"row":0,"col":0,"layer":0,"keycode":4,"count":1,"tapCount":0,"holdCount":0'
const SESSION = '"payload":{"id":"s","scopeId":"x","startMs":1,"endMs":2}'
const bigramLine = (entries: string, extra = ''): string =>
  `{"id":"bigram|s|60000","kind":"bigram-minute","updated_at":1,"payload":{"scopeId":"s","minuteTs":60000,"bigrams":${entries}${extra}}}`
const statsLine = (extra: string): string => `{"id":"stats|s|60000","kind":"minute-stats","updated_at":1,"payload":{${STATS}${extra}}}`
const matrixLine = (extra: string): string => `{"id":"m","kind":"matrix-minute","updated_at":1,"payload":{${MATRIX}${extra}}}`

const PARSE_LINES = [
  '', ' ', '{ not json', 'null', '5', '"x"', '[]', '﻿{"id":"s","kind":"session","updated_at":1,' + SESSION + '}',
  JSON.stringify({ id: 'x|1', kind: 'mystery', updated_at: 1, payload: {} }),
  JSON.stringify({ id: 'char|s|60000|a', kind: 'char-minute', updated_at: 1, payload: { scopeId: 's', minuteTs: 60_000 } }),
  `{"id":"s","kind":"session","updated_at":"soon",${SESSION}}`,
  `{"id":"s","kind":"session","updated_at":1e400,${SESSION}}`,
  `{"id":"s","kind":"session","updated_at":-0,${SESSION}}`,
  `{"id":5,"kind":"session","updated_at":1,${SESSION}}`,
  `{"id":"\\ud800","kind":"session","updated_at":1,${SESSION}}`,
  `{"id":"s","kind":"session","updated_at":1,"is_deleted":"true",${SESSION}}`,
  `{"id":"s","kind":"session","updated_at":1,"is_deleted":false,${SESSION}}`,
  `{"id":"s","kind":"session","updated_at":1,"payload":[]}`,
  `{"id":"s","kind":"session","updated_at":1,"payload":null}`,
  `  {"id":"s","kind":"session","updated_at":1,${SESSION}}  `,
  `{"z":{"b":1,"1":2},"id":"s","kind":"session","updated_at":1,${SESSION},"0":true}`,
  `{"id":"a","kind":"session","updated_at":1,${SESSION},"id":"b","updated_at":2}`,
  `{"id":"s","kind":"session","updated_at":1,"payload":{"__proto__":1,"id":"s","scopeId":"x","startMs":1,"endMs":2}}`,
  `{"id":"s","kind":"session","updated_at":1,"payload":{"id":"s","scopeId":"x","startMs":1,"endMs":"2"}}`,
  `{"id":"s","kind":"scope","updated_at":1,"payload":{"id":"s","machineHash":"h","osPlatform":"linux","osRelease":"6","osArch":"x64","keyboardUid":"u","keyboardVendorId":1,"keyboardProductId":2,"keyboardProductName":"n"}}`,
  `{"id":"s","kind":"scope","updated_at":1,"payload":{"id":"s","machineHash":"h","osPlatform":"linux","osRelease":"6","osArch":"x64","keyboardUid":"u","keyboardVendorId":"1","keyboardProductId":2,"keyboardProductName":"n"}}`,
  `{"id":"c","kind":"char-minute","updated_at":1,"payload":{"scopeId":"s","minuteTs":1,"char":"\\ud800","count":1}}`,
  `{"id":"c","kind":"char-minute","updated_at":1,"payload":{"scopeId":"s","minuteTs":1,"char":"a","count":1,"appName":5}}`,
  `{"id":"c","kind":"char-minute","updated_at":1,"payload":{"scopeId":"s","minuteTs":1,"char":"a","count":1,"appName":null,"typingTest":null,"runId":null}}`,
  `{"id":"c","kind":"char-minute","updated_at":1,"payload":{"scopeId":"s","minuteTs":1,"char":"a","count":1,"runId":7}}`,
  `{"id":"c","kind":"char-minute","updated_at":1,"payload":{"scopeId":"s","minuteTs":1,"char":"a","count":1e400}}`,
  statsLine(''),
  statsLine(',"pollP50Ms":20,"pollP95Ms":45'),
  statsLine(',"pollP50Ms":null,"pollP95Ms":null'),
  statsLine(',"pollP50Ms":null,"pollP95Ms":5'),
  statsLine(',"pollP50Ms":20'),
  statsLine(',"pollP95Ms":"x","pollP50Ms":1'),
  `{"id":"stats","kind":"minute-stats","updated_at":1,"payload":{"scopeId":"s","minuteTs":60000,"keystrokes":1,"activeMs":1}}`,
  matrixLine(''),
  matrixLine(',"dh":[0,1,0,0,0,0,0,0],"ds":65,"dq":4225'),
  matrixLine(',"dh":[0,1,0,0,0,0,0,0]'),
  matrixLine(',"ds":65,"dq":4225'),
  matrixLine(',"dh":[0,1,0],"ds":65,"dq":4225'),
  matrixLine(',"dh":[0,1,0,0,0,0,0,"0"],"ds":65,"dq":4225'),
  matrixLine(',"dh":{"0":0},"ds":65,"dq":4225'),
  matrixLine(',"dh":[0,1,0,0,0,0,0,0],"ds":null,"dq":4225'),
  bigramLine(`{"4_11":{"c":1,"h":[1,0,0]}}`),
  bigramLine(`{"4_11":{"c":1,"h":[1,0,0,0,0,0,0,null]}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"s":240,"sq":28800}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST}}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"s":240}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"sq":28800}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"s":"240","sq":28800}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"s":null,"sq":28800}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"oc":1,"on":2}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"oc":-0,"on":0}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"oc":1}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"on":2}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"oc":1.5,"on":2}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"oc":1,"on":-1}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"oc":3,"on":2}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"oc":"1","on":2}}`),
  bigramLine(`{"4_11":{"c":2,"h":${HIST},"oc":1e21,"on":1e22}}`),
  bigramLine(`{"4_11":{"c":"2","h":${HIST}}}`),
  bigramLine(`{"4_11":[2]}`),
  bigramLine(`{"4_11":null}`),
  bigramLine('{}'),
  bigramLine(`[{"c":1,"h":${HIST}}]`),
  bigramLine('[1]'),
  bigramLine('[]'),
  bigramLine('null'),
  bigramLine('"x"'),
  bigramLine(`{"b":{"c":1,"h":${HIST}},"10":{"c":2,"h":${HIST}},"a\\ud800":{"c":3,"h":${HIST}}}`, ',"appName":"x","runId":""'),
  `{"id":"bigram","kind":"bigram-minute","updated_at":1,"payload":{"minuteTs":60000,"bigrams":{}}}`,
  `{"id":"t","kind":"trigram-minute","updated_at":1,"payload":{"scopeId":"s","minuteTs":60000,"trigrams":{"4_11_7":{"c":1,"h":${HIST},"s":150}}}}`,
  `{"id":"t","kind":"trigram-minute","updated_at":1,"payload":{"scopeId":"s","minuteTs":60000,"trigrams":{"4_11_7":{"c":1,"h":${HIST},"oc":0,"on":1}}}}`,
  `{"id":"t","kind":"trigram-minute","updated_at":1,"payload":{"scopeId":"s","minuteTs":60000,"bigrams":{}}}`,
]

// --- files --------------------------------------------------------------

const enc = (s: string): Tree[string] => s
const hex = (...parts: Array<string | number[]>): Tree[string] => ({
  hex: Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p)))).toString('hex'),
})

const sessionRow = (id: string, updatedAt = 1): JsonlRow => ({
  id,
  kind: 'session',
  updated_at: updatedAt,
  payload: { id, scopeId: 's', startMs: 1, endMs: 2 },
})
const line = (id: string): string => serializeRow(sessionRow(id))

const APPEND_CASES: Array<{ name: string; start: Tree[string] | 'missing' | 'blocked'; appends: string[][] }> = [
  { name: 'nothing to a missing file', start: 'missing', appends: [[]] },
  { name: 'to a missing file', start: 'missing', appends: [['a', 'b'], ['c']] },
  { name: 'to an empty file', start: enc(''), appends: [['a']] },
  { name: 'after a newline', start: enc(line('x')), appends: [['a'], [], ['b']] },
  { name: 'after a truncated line', start: enc(line('x') + '{"id":"char|trunc'), appends: [['a'], ['b']] },
  { name: 'after a carriage return', start: enc(line('x').trimEnd() + '\r'), appends: [['a']] },
  { name: 'after a multibyte character', start: hex(line('x'), '日'), appends: [['a']] },
  { name: 'after invalid UTF-8', start: hex([0xe6, 0x97]), appends: [['a']] },
  { name: 'under a file', start: 'blocked', appends: [['a']] },
]

const READ_CASES: Array<{ name: string; file: Tree[string] | 'missing' | 'dir'; afterId?: string; mustExist?: boolean }> = [
  { name: 'missing', file: 'missing' },
  { name: 'missing after an id', file: 'missing', afterId: 'prev' },
  { name: 'missing that must exist', file: 'missing', mustExist: true },
  { name: 'a directory', file: 'dir' },
  { name: 'empty', file: enc('') },
  { name: 'rows', file: enc(line('a') + line('b') + line('c')) },
  { name: 'rows after the first', file: enc(line('a') + line('b') + line('c')), afterId: 'a' },
  { name: 'rows after the last', file: enc(line('a') + line('b')), afterId: 'b' },
  { name: 'rows after an absent id', file: enc(line('a')), afterId: 'zz' },
  { name: 'rows after a repeated id', file: enc(line('a') + line('b') + line('a') + line('c')), afterId: 'a' },
  { name: 'rows after the id of a dropped line', file: enc(line('a') + '{"id":"x","kind":"mystery","updated_at":1,"payload":{}}\n' + line('b')), afterId: 'x' },
  { name: 'a partial last line', file: enc(line('a') + line('b').trimEnd()) },
  { name: 'a partial last line after an id', file: enc(line('a') + line('b').trimEnd()), afterId: 'a' },
  { name: 'malformed lines', file: enc(line('a') + '{ garbled\n' + '\n' + '   \n' + line('b')) },
  { name: 'CRLF lines', file: enc(line('a').trimEnd() + '\r\n' + line('b').trimEnd() + '\r\n') },
  { name: 'lone CR lines', file: enc(line('a').trimEnd() + '\r' + line('b').trimEnd() + '\r' + line('c')) },
  { name: 'ending with CR', file: enc(line('a') + line('b').trimEnd() + '\r') },
  { name: 'a byte order mark', file: enc('﻿' + line('a') + line('b')) },
  { name: 'invalid UTF-8 in a string', file: hex(line('a'), '{"id":"b', [0xff, 0xe6, 0x97], 'c', [0xf0, 0x9f], '","kind":"session","updated_at":1,"payload":{"id":"s","scopeId":"x","startMs":1,"endMs":2}}\n') },
  { name: 'a lone surrogate id', file: enc('{"id":"\\udc00","kind":"session","updated_at":1,"payload":{"id":"s","scopeId":"x","startMs":1,"endMs":2}}\n' + line('b')), afterId: '\udc00' },
]

const UTC_MS = [
  0, -1, 1, 1_776_643_199_999, 1_776_643_200_000, 8.64e15, -8.64e15, 8.64e15 + 1, -8.64e15 - 1, Number.NaN, Infinity,
  -Infinity, -62_198_755_200_000, -62_135_596_800_001, 253_402_300_800_000, 1.5, -0.5, -0, -86_400_000.5, 1e21,
]

const UTC_DAYS = [
  '2026-04-19', '2024-02-29', '2026-02-29', '2026-13-01', '2026-00-15', '2026-04-31', '2026-4-19', '20260419',
  'abcd-ef-gh', '', '0050-01-01', '0099-12-31', '0100-01-01', '9999-12-31', '1970-01-01', '２０２６-04-19',
  '2026-04-19 ', '+002026-04-19',
]

const PATHS_TREE: Tree = {
  'sync/keyboards/0xAABB/devices/hash-a/2026-04-19.jsonl': '',
  'sync/keyboards/0xAABB/devices/hash-a/2026-04-17.jsonl': '',
  'sync/keyboards/0xAABB/devices/hash-a/2026-04-18.jsonl': '',
  'sync/keyboards/0xAABB/devices/hash-a/README.txt': '',
  'sync/keyboards/0xAABB/devices/hash-a/not-a-day.jsonl': '',
  'sync/keyboards/0xAABB/devices/hash-a/2026-13-01.jsonl': '',
  'sync/keyboards/0xAABB/devices/hash-a/2026-02-29.jsonl': '',
  'sync/keyboards/0xAABB/devices/hash-a/0050-01-01.jsonl': '',
  'sync/keyboards/0xAABB/devices/hash-a/2026-04-16.JSONL': '',
  'sync/keyboards/0xAABB/devices/hash-a/2026-04-15.jsonl.tmp': '',
  'sync/keyboards/0xAABB/devices/hash-a/deleted-ranges.json': '{}',
  'sync/keyboards/0xAABB/devices/hash-a/2026-04-20.jsonl': null,
  'sync/keyboards/0xAABB/devices/hash-b/2026-04-19.jsonl': '',
  'sync/keyboards/0xAABB/devices/hash-c/deleted-ranges.json': null,
  'sync/keyboards/0xAABB/devices/Hash-D/2026-01-01.jsonl': '',
  'sync/keyboards/0xAABB/devices/hash-e/': null,
  'sync/keyboards/0xAABB/devices/stray.jsonl': '',
  'sync/keyboards/0xCCDD/devices/hash-a/2026-04-19.jsonl': '',
  'sync/keyboards/～/devices/h/2026-01-01.jsonl': '',
  'sync/keyboards/😀/devices/h/2026-01-01.jsonl': '',
  'sync/keyboards/Zed/devices/h/2026-01-01.jsonl': '',
  'sync/keyboards/file-not-dir': '',
  'sync/keyboards/no-devices/': null,
}

// --- deleted ranges -----------------------------------------------------

const UID = 'kb'
const HASH = 'hash-r'

const entry = (id: string, cutoffMs = 100, startMs = 0, endMs = 50): DeletedRangeEntry => ({ id, startMs, endMs, cutoffMs })
const rangesFile = (entries: unknown): string => JSON.stringify({ version: 1, entries })

const RANGE_FILES: Array<{ name: string; file: Tree[string] | 'missing' | 'dir' }> = [
  { name: 'missing', file: 'missing' },
  { name: 'a directory', file: 'dir' },
  { name: 'valid', file: enc(rangesFile([entry('b', 5), entry('a')])) },
  {
    name: 'invalid entries',
    file: enc(rangesFile([
      entry('ok'), null, 5, 'x', [], { startMs: 0, endMs: 1, cutoffMs: 1 }, { id: '', startMs: 0, endMs: 1, cutoffMs: 1 },
      { id: 'x'.repeat(129), startMs: 0, endMs: 1, cutoffMs: 1 }, { id: 'y'.repeat(128), startMs: 0, endMs: 1, cutoffMs: 1 },
      { id: '😀'.repeat(64), startMs: 0, endMs: 1, cutoffMs: 1 }, { id: '😀'.repeat(65), startMs: 0, endMs: 1, cutoffMs: 1 },
      { id: 'eq', startMs: 5, endMs: 5, cutoffMs: 1 }, { id: 'rev', startMs: 6, endMs: 5, cutoffMs: 1 },
      { id: 'neg', startMs: -1, endMs: 5, cutoffMs: 1 }, { id: 'frac', startMs: 0.5, endMs: 5, cutoffMs: 1 },
      { id: 'str', startMs: '0', endMs: 5, cutoffMs: 1 }, { id: 'safe', startMs: 0, endMs: 9007199254740991, cutoffMs: 9007199254740991 },
      { id: 'unsafe', startMs: 0, endMs: 9007199254740992, cutoffMs: 1 }, { id: 'negcut', startMs: 0, endMs: 5, cutoffMs: -1 },
      { id: 7, startMs: 0, endMs: 5, cutoffMs: 1 }, { id: 'extra', startMs: 0, endMs: 5, cutoffMs: 2, note: 'x', id2: 1 },
    ])),
  },
  { name: 'odd numbers', file: enc('{"version":1.0,"entries":[{"id":"z","startMs":-0,"endMs":1e3,"cutoffMs":1E2},{"id":"inf","startMs":0,"endMs":1,"cutoffMs":1e400}]}') },
  { name: 'duplicate ids', file: enc(rangesFile([entry('a', 9), entry('b', 1), entry('a', 2)])) },
  { name: 'ids in UTF-16 order', file: enc(rangesFile([entry('～'), entry('😀'), entry('Z'), entry('a'), entry('\ud800x'), entry('é')])) },
  { name: 'equal cutoffs and a duplicate key', file: enc('{"version":1,"entries":[{"id":"b","startMs":0,"endMs":1,"cutoffMs":3}],"entries":[{"id":"c","startMs":0,"endMs":1,"cutoffMs":3},{"id":"a","startMs":2,"endMs":3,"cutoffMs":3}]}') },
  { name: 'invalid UTF-8 in an id', file: hex('{"version":1,"entries":[{"id":"a', [0xff], '","startMs":0,"endMs":1,"cutoffMs":1}]}') },
  { name: 'no entries', file: enc('{"version":1,"entries":[]}') },
  { name: 'version 2', file: enc('{"version":2,"entries":[]}') },
  { name: 'version as text', file: enc('{"version":"1","entries":[]}') },
  { name: 'entries not an array', file: enc('{"version":1,"entries":{}}') },
  { name: 'no version', file: enc('{"entries":[]}') },
  { name: 'an array', file: enc('[]') },
  { name: 'null', file: enc('null') },
  { name: 'a byte order mark', file: enc('﻿{"version":1,"entries":[]}') },
  { name: 'not JSON', file: enc('{not json') },
  { name: 'empty', file: enc('') },
]

/** The entries another device holds in the union step. */
const OTHER: DeletedRangeEntry[] = [entry('a', 1, 0, 10), entry('c', 2), entry('ok', 100)]

const CLIP_CASES: Array<{ entries: Array<{ startMs: number; endMs: number; cutoffMs: number }>; day: string }> = [
  { entries: [{ startMs: 0, endMs: 1_776_643_200_000 + 3_600_000, cutoffMs: 7 }], day: '2026-04-20' },
  { entries: [{ startMs: 1_776_643_200_000 - 1, endMs: 1_776_643_200_000, cutoffMs: 1 }, { startMs: 1_776_729_600_000, endMs: 1_776_729_600_001, cutoffMs: 2 }], day: '2026-04-20' },
  { entries: [{ startMs: 1_776_643_200_000 + 10, endMs: 1_776_643_200_000 + 20, cutoffMs: 3 }, { startMs: 0, endMs: 9e15, cutoffMs: 4 }], day: '2026-04-20' },
  { entries: [], day: '2026-04-20' },
  { entries: [{ startMs: 0, endMs: 1, cutoffMs: 1 }], day: '2026-02-30' },
]

const APPLIED_CASES: Array<{ name: string; file: Tree[string] | 'missing' | 'no-dir'; id: string }> = [
  { name: 'missing', file: 'missing', id: 'b' },
  { name: 'ids', file: enc('["c","a"]'), id: 'b' },
  { name: 'the id already there', file: enc('["b"]'), id: 'b' },
  { name: 'other values', file: enc('["a","a",1,null,{"id":"x"},"c"]'), id: 'b' },
  { name: 'UTF-16 order', file: enc('["～","😀","Z","a","é","\\ud800"]'), id: '\udc00' },
  { name: 'an object', file: enc('{"0":"a"}'), id: 'b' },
  { name: 'not JSON', file: enc('[not json'), id: 'b' },
  { name: 'no device directory', file: 'no-dir', id: 'b' },
]

// --- keymap snapshots ---------------------------------------------------

const SNAPSHOT_DIR = (uid: string): string => `typing-analytics/keymaps/${uid}/${OWN_HASH}`

const snapshot = (savedAt: number, extra: object = {}): string => JSON.stringify({
  uid: 'kb-raw', machineHash: OWN_HASH, productName: 'Raw', savedAt, layers: 2,
  matrix: { rows: 1, cols: 2 }, keymap: [[['KC_A', 'KC_B']]], layout: null, ...extra,
})

const KEYMAP_TREE: Tree = {
  [`${SNAPSHOT_DIR('kb-raw')}/1000.json`]: snapshot(1000),
  [`${SNAPSHOT_DIR('kb-raw')}/007.json`]: snapshot(7),
  [`${SNAPSHOT_DIR('kb-raw')}/2000.json`]: 'not json',
  [`${SNAPSHOT_DIR('kb-raw')}/3000.json`]: 'null',
  [`${SNAPSHOT_DIR('kb-raw')}/4000.json`]: '5',
  [`${SNAPSHOT_DIR('kb-raw')}/5000.json`]: '"text"',
  [`${SNAPSHOT_DIR('kb-raw')}/5500.json`]: '[1,2]',
  [`${SNAPSHOT_DIR('kb-raw')}/6000.json`]: null,
  [`${SNAPSHOT_DIR('kb-raw')}/6500.json`]: '{"productName":7,"extra":1,"matrix":"wide","uid":"other"}',
  [`${SNAPSHOT_DIR('kb-raw')}/1234567890123456789012345.json`]: snapshot(1),
  [`${SNAPSHOT_DIR('kb-raw')}/abc.json`]: snapshot(2),
  [`${SNAPSHOT_DIR('kb-raw')}/-5.json`]: snapshot(-5),
  [`${SNAPSHOT_DIR('kb-raw')}/8000.JSON`]: snapshot(8000),
  [`${SNAPSHOT_DIR('kb-throw')}/9000.json`]: '{"layers":4,"matrix":null}',
  [`${SNAPSHOT_DIR('kb-array')}/9000.json`]: '[4]',
  [`${SNAPSHOT_DIR('kb-order')}/9000.json`]: JSON.stringify({ layers: 1, matrix: { rows: 1, cols: 1 }, keymap: [], layout: { a: 1, b: 2 } }),
  [`${SNAPSHOT_DIR('kb-number')}/9000.json`]: JSON.stringify({ layers: 1, matrix: { rows: 1, cols: 1 }, keymap: [[['KC_A']]], layout: null }),
  'typing-analytics/keymaps/kb-file': 'not a directory',
}

const base = { uid: 'kb-1', productName: 'Tester', savedAt: 1000, layers: 4, matrix: { rows: 5, cols: 12 }, keymap: [[['KC_A']]], layout: null }

type Step = ['save', unknown] | ['get', unknown, unknown, unknown] | ['list', unknown]

const KEYMAP_STEPS: Step[] = [
  ['list', 'kb-raw'],
  ['list', 'kb-none'],
  ['list', ''],
  ['list', 5],
  ['get', 'kb-raw', 500, 1500],
  ['get', 'kb-raw', 1000, 1000],
  ['get', 'kb-raw', 1500, 2500],
  ['get', 'kb-raw', 2500, 3500],
  ['get', 'kb-raw', 3500, 4500],
  ['get', 'kb-raw', 5100, 5200],
  ['get', 'kb-raw', 5500, 5501],
  ['get', 'kb-raw', 6000, 6001],
  ['get', 'kb-raw', 6500, 6501],
  ['get', 'kb-raw', 0, 1e30],
  ['get', 'kb-raw', -10, -1],
  ['get', 'kb-raw', 1e30, 1e31],
  ['get', 'kb-none', 0, 10],
  ['get', '', 0, 10],
  ['get', 'kb-raw', null, 10],
  ['get', 'kb-raw', 0, '10'],
  ['save', base],
  ['save', { ...base, productName: 'Renamed', savedAt: 2000, vialProtocol: 6 }],
  ['save', { ...base, savedAt: 3000, keymap: [[['KC_B']]] }],
  ['save', { savedAt: 4000, keymap: [[['KC_B']]], layers: 4, uid: 'kb-1', matrix: { cols: 12, rows: 5 }, layout: null }],
  ['save', { ...base, savedAt: 5000, matrix: { rows: 5, cols: 12, extra: true } }],
  ['save', { ...base, savedAt: 1.5, keymap: [[['KC_C']]] }],
  ['save', { ...base, savedAt: 6000, keymap: [[['KC_C']]], vialProtocol: '6', extra: 'dropped' }],
  ['save', { uid: 'kb-2' }],
  ['save', { uid: 'kb-2', savedAt: '7000', layers: '4', matrix: null, keymap: 'x', layout: undefined, vialProtocol: 6.5 }],
  ['save', { uid: 'kb-2', productName: 5, savedAt: 1e21, layers: -0, matrix: 3, keymap: [], layout: { b: 1, a: [null, true] } }],
  ['save', { uid: 'kb-2', savedAt: -5, layers: 1 }],
  ['save', { uid: 'kb-2', savedAt: 8000, layers: 1 }],
  ['save', null],
  ['save', 5],
  ['save', []],
  ['save', { uid: '' }],
  ['save', { uid: 5 }],
  ['save', { ...base, uid: 'kb-throw', layers: 4 }],
  ['save', { ...base, uid: 'kb-throw', layers: 3 }],
  ['save', { ...base, uid: 'kb-array' }],
  ['save', { ...base, uid: 'kb-order', layers: 1, matrix: { rows: 1, cols: 1 }, keymap: [], layout: { b: 2, a: 1 } }],
  ['save', { ...base, uid: 'kb-order', layers: 1, matrix: { rows: 1, cols: 1 }, keymap: [], layout: { a: 1, b: 2 } }],
  ['save', { ...base, uid: 'kb-number', layers: 1.0, matrix: { rows: '1', cols: 1 }, keymap: [[['KC_A']]] }],
  ['save', { ...base, uid: 'kb-file' }],
  ['list', 'kb-1'],
  ['list', 'kb-2'],
  ['list', 'kb-file'],
  ['get', 'kb-1', 0, 1e30],
  ['get', 'kb-1', 1.5, 2],
]

describe('typing-analytics JSONL fixtures', () => {
  it('records the rows', () => {
    const ids = ID_CALLS.map(([fn, args]) => ({ fn, args: tagged(args), id: ID_FUNCTIONS[fn](...(args as never[])) }))
    const rows = sampleRows().map((row) => ({ row: tagged(row), line: serializeRow(row) }))
    const parsed = PARSE_LINES.map((text) => {
      const row = parseRow(text)
      return { line: text, parsed: row === null ? null : serializeRow(row) }
    })
    expect(parsed.filter((p) => p.parsed !== null).length).toBeGreaterThan(20)
    writeJsonFixture(join(ANALYTICS_FIXTURES_DIR, 'jsonl_rows.json'), { ids, rows, parsed })
  })

  it('records the files', async () => {
    const rowsById = (ids: string[]): JsonlRow[] => ids.map((id) => sessionRow(id, 7))
    const appends = []
    for (const c of APPEND_CASES) {
      const userData = freshUserData()
      const path = join(userData, 'd', 'day.jsonl')
      if (c.start === 'blocked') buildTree(userData, { d: 'a file' })
      else if (c.start !== 'missing') buildTree(userData, { 'd/day.jsonl': c.start })
      const result = await outcome(async () => {
        for (const ids of c.appends) await appendRowsToFile(path, rowsById(ids))
      })
      appends.push({ ...c, error: 'error' in result, after: recordTree(userData) })
      rmSync(userData, { recursive: true, force: true })
    }

    const reads = []
    for (const c of READ_CASES) {
      const userData = freshUserData()
      const path = join(userData, 'day.jsonl')
      if (c.file === 'dir') buildTree(userData, { 'day.jsonl': null })
      else if (c.file !== 'missing') buildTree(userData, { 'day.jsonl': c.file })
      const result = await outcome(() => readRows(path, { afterId: c.afterId, mustExist: c.mustExist }))
      reads.push({
        ...c,
        afterId: c.afterId ?? null,
        mustExist: c.mustExist ?? false,
        result: 'error' in result
          ? null
          : { rows: result.value.rows.map(serializeRow), lastId: result.value.lastId, partialLineSkipped: result.value.partialLineSkipped },
      })
      rmSync(userData, { recursive: true, force: true })
    }

    const utcDaysFromMs = UTC_MS.map((ms) => ({ ms: tagged(ms), day: utcDayFromMs(ms) }))
    const utcDays = UTC_DAYS.map((day) => {
      let range: { startMs: number; endMs: number } | null = null
      try {
        range = utcDayBoundaryMs(day)
      } catch {
        range = null
      }
      return { day, isUtcDay: isUtcDay(day), range }
    })

    const userData = freshUserData()
    buildTree(userData, PATHS_TREE)
    const listings = {
      tree: PATHS_TREE,
      deviceDays: {
        'hash-a': await listDeviceDays(userData, '0xAABB', 'hash-a'),
        missing: await listDeviceDays(userData, '0xAABB', 'missing'),
      },
      allDays: (await listAllDeviceDayJsonlFiles(userData)).map((ref) => ({ ...ref, path: rel(userData, ref.path) })),
      deletedRangesHashes: {
        '0xAABB': await listDeletedRangesHashes(userData, '0xAABB'),
        missing: await listDeletedRangesHashes(userData, 'missing'),
      },
    }
    writeJsonFixture(join(ANALYTICS_FIXTURES_DIR, 'jsonl_files.json'), {
      rows: Object.fromEntries(['a', 'b', 'c'].map((id) => [id, serializeRow(sessionRow(id, 7))])),
      appends,
      reads,
      utcDaysFromMs,
      utcDays,
      listings,
    })
  })

  it('records the deleted ranges', async () => {
    const files = []
    for (const c of RANGE_FILES) {
      const userData = freshUserData()
      const path = `sync/keyboards/${UID}/devices/${HASH}/deleted-ranges.json`
      if (c.file === 'dir') buildTree(userData, { [path]: null })
      else if (c.file !== 'missing') buildTree(userData, { [path]: c.file })
      const read = await outcome(() => readDeletedRanges(userData, UID, HASH))
      const lenient = readDeletedRangesSync(userData, UID, HASH)
      const bundle = await bundleDeletedRanges(userData, UID, HASH)
      const update = await outcome(() => updateDeletedRanges(userData, UID, HASH, (local) => unionDeletedRanges(local, OTHER)))
      const unchanged = await outcome(() => updateDeletedRanges(userData, UID, HASH, (local) => unionDeletedRanges(local, local)))
      files.push({
        ...c,
        read: 'error' in read ? null : serializeDeletedRanges(read.value),
        lenient: serializeDeletedRanges(lenient),
        bundle,
        update: 'error' in update
          ? null
          : { ...update.value, entries: serializeDeletedRanges(update.value.entries) },
        unchangedError: 'error' in unchanged,
        after: recordTree(userData),
      })
      rmSync(userData, { recursive: true, force: true })
    }

    const clips = CLIP_CASES.map((c) => {
      try {
        return { ...c, clipped: clipToUtcDay(c.entries, c.day) }
      } catch {
        return { ...c, clipped: null }
      }
    })

    const applied = []
    for (const c of APPLIED_CASES) {
      const userData = freshUserData()
      const path = `sync/keyboards/${UID}/devices/${OWN_HASH}/deleted-ranges-applied.json`
      if (c.file === 'missing') buildTree(userData, { [`sync/keyboards/${UID}/devices/${OWN_HASH}`]: null })
      else if (c.file !== 'no-dir') buildTree(userData, { [path]: c.file })
      const result = await outcome(() => recordOwnDeletedRangeApplied(UID, c.id))
      applied.push({ ...c, error: 'error' in result, after: recordTree(userData) })
      rmSync(userData, { recursive: true, force: true })
    }

    writeJsonFixture(join(ANALYTICS_FIXTURES_DIR, 'deleted_ranges.json'), {
      uid: UID,
      hash: HASH,
      ownHash: OWN_HASH,
      other: serializeDeletedRanges(OTHER),
      files,
      clips,
      applied,
    })
  })

  it('records the keymap snapshots', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    try {
      registerAnalyzeIpc()
      const handler = (channel: string): ((...args: unknown[]) => Promise<unknown>) => {
        const found = pinned.handlers.get(channel)
        if (!found) throw new Error(`no handler for ${channel}`)
        return async (...args) => found(undefined, ...args)
      }
      const save = handler(IpcChannels.TYPING_ANALYTICS_SAVE_KEYMAP_SNAPSHOT)
      const get = handler(IpcChannels.TYPING_ANALYTICS_GET_KEYMAP_SNAPSHOT_FOR_RANGE)
      const list = handler(IpcChannels.TYPING_ANALYTICS_LIST_KEYMAP_SNAPSHOTS)
      const userData = freshUserData()
      buildTree(userData, KEYMAP_TREE)
      const steps = []
      for (const step of KEYMAP_STEPS) {
        const [kind, ...args] = step
        const run = kind === 'save' ? save : kind === 'get' ? get : list
        const result = await outcome(() => run(...args))
        steps.push({ kind, args: tagged(args), response: 'error' in result ? null : JSON.stringify(result.value) ?? null })
      }
      expect(steps.filter((s) => s.kind === 'save' && s.response?.startsWith('{"saved":true')).length).toBeGreaterThan(5)
      writeJsonFixture(join(ANALYTICS_FIXTURES_DIR, 'keymap_snapshots.json'), {
        machineHash: OWN_HASH,
        nowMs: NOW,
        tree: KEYMAP_TREE,
        steps,
        after: recordTree(join(userData, 'typing-analytics')),
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
