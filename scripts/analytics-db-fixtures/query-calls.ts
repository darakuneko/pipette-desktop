// SPDX-License-Identifier: GPL-2.0-or-later
// The IPC member fixtures of the query layer of src-tauri/crates/
// pipette-typing-analytics (src/queries/): a seed and a userData tree, the
// member calls made on them, and how a recorder runs a call through the
// registered handler.
//
// The seed is the DB method seed (db-methods.ts) with n-gram rows whose
// rankings tie, so the order falls to `localeCompare`. The tree holds
// keymap snapshots for the Layout Comparison and day files for the local
// day listing.
//
// The calls run each handler with every scope it takes, the filters on the
// members whose SQL takes them, and the arguments it rejects or defaults.
// record-analytics-query-fixtures.test.ts records the calls whose answer
// does not depend on the time zone; tz-analytics-queries.test.ts records
// the ones that go through local days, once per zone of time-zones.ts.

import { join } from 'node:path'
import type { Tree } from '../keyboard-store-fixtures/fixture-tree'
import { buildMethodsSeed, OWN, REMOTE, UID_A, UID_B } from './db-methods'
import { ANALYTICS_FIXTURES_DIR } from './paths'
import { tagged } from './tagged'

export const QUERY_SEED_PATH = join(ANALYTICS_FIXTURES_DIR, 'queries-seed.jsonl')
export const QUERIES_FIXTURE_PATH = join(ANALYTICS_FIXTURES_DIR, 'queries.json')
export const QUERIES_TZ_FIXTURES_DIR = join(ANALYTICS_FIXTURES_DIR, 'queries_tz')
export const COLLATION_FIXTURE_PATH = join(ANALYTICS_FIXTURES_DIR, 'collation.json')

/** `os.platform()` and `os.release()` as the recorders pin them. */
export const OS = { platform: 'linux', release: '6.8.0-test' } as const

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = Date.UTC(2026, 9, 15)
const t = (h: number, m: number): number => DAY + h * HOUR + m * MINUTE
const MAX = Number.MAX_SAFE_INTEGER

const hist = (...values: number[]): number[] => [...values, ...new Array<number>(8 - values.length).fill(0)]

/** The ids of the recorder's characters that tie on count (and on average
 * interval), and ids with other characters on counts of their own. */
function ngramLines(): string[] {
  const tied = ['4_10', '4_1', '10_4', '1e+21_4', '-1_4', '1.5_4', '_4', '4_1_']
  const bigrams: Record<string, unknown> = {}
  for (const id of tied) bigrams[id] = { c: 6, h: hist(0, 0, 6), s: 720, sq: 86_400, oc: 1, on: 3 }
  bigrams['a_B'] = { c: 9, h: hist(0, 9) }
  bigrams['A_b'] = { c: 8, h: hist(0, 0, 0, 0, 0, 0, 0, 8) }
  bigrams['44_4'] = { c: 7, h: hist(0, 0, 0, 0, 0, 0, 7), s: 4_000.5, sq: 2_400_000 }
  const line = (scopeId: string, minuteTs: number, kind: string, payload: Record<string, unknown>): string =>
    JSON.stringify({ id: kind, kind, updated_at: 1_000, payload: { scopeId, minuteTs, ...payload } })
  return [
    line('scope-own-a', t(10, 6), 'bigram-minute', { appName: 'Code', bigrams }),
    line('scope-remote-a', t(10, 6), 'bigram-minute', { bigrams: { '4_10': { c: 6, h: hist(0, 0, 6), oc: 2, on: 2 } } }),
    line('scope-own-a', t(10, 6), 'trigram-minute', {
      appName: 'Code',
      trigrams: { '4_5_6': { c: 3, h: hist(0, 3) }, '6_5_4': { c: 3, h: hist(0, 3) }, '10_4_5': { c: 5, h: hist(5), s: 100, sq: 2_100 } },
    }),
  ]
}

export function buildQuerySeed(): string {
  return buildMethodsSeed() + ngramLines().join('\n') + '\n'
}

const SNAPSHOT_DIR = `typing-analytics/keymaps/${UID_A}/${OWN}`

function snapshot(savedAt: number, keymap: string[][]): string {
  const keys = []
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) keys.push({ x: col + (row === 3 ? 0.5 : 0), y: row, width: 1, height: 1, row, col })
  }
  return JSON.stringify({
    uid: UID_A, machineHash: OWN, productName: 'Alpha', savedAt, layers: 2, matrix: { rows: 4, cols: 4 },
    keymap: [keymap, [['KC_1']]], layout: { keys }, vialProtocol: 6,
  })
}

/** Keymap snapshots of keyboard A (one before the Analyze window, one in
 * it) and day files of this device. */
export const QUERY_TREE: Tree = {
  [`${SNAPSHOT_DIR}/${t(9, 0)}.json`]: snapshot(t(9, 0), [
    ['KC_Q', 'KC_W', 'KC_E', 'KC_R'],
    ['KC_A', 'KC_S', 'KC_D', 'KC_F'],
    ['KC_Z', 'KC_X', 'KC_C', 'KC_V'],
    ['KC_NO', 'KC_NO', 'KC_SPACE', 'KC_NO'],
  ]),
  [`${SNAPSHOT_DIR}/${t(10, 2)}.json`]: snapshot(t(10, 2), [
    ['KC_Q', 'KC_A', 'KC_W', 'KC_E'],
    ['KC_S', 'KC_D', 'LSFT(KC_F)', 'KC_R'],
    ['KC_T', 'KC_G', 'KC_NO', 'KC_H'],
    ['KC_SPACE', 'MO(1)', 'KC_J', 'KC_SCOLON'],
  ]),
  [`sync/keyboards/${UID_A}/devices/${OWN}/2026-10-15.jsonl`]: '',
  [`sync/keyboards/${UID_A}/devices/${OWN}/2026-10-14.jsonl`]: '',
  [`sync/keyboards/${UID_A}/devices/${OWN}/deleted-ranges.json`]: '[]',
  [`sync/keyboards/${UID_A}/devices/${OWN}/notes.txt`]: '',
  [`sync/keyboards/${UID_A}/devices/${REMOTE}/2026-10-13.jsonl`]: '',
}

/** A member call: the VialAPI member and the handler's arguments. */
export interface QueryCall {
  member: string
  args: unknown[]
}

const c = (member: string, ...args: unknown[]): QueryCall => ({ member: `typingAnalytics${member}`, args })

const ALL_TIME = [0, MAX] as const
const WINDOW = [t(10, 0), t(10, 5)] as const
const ODD_WINDOW = [t(10, 0) + 0.5, t(10, 2) + 30_000] as const
const HASH = (machineHash: string) => ({ kind: 'hash', machineHash })
const SCOPES = ['own', 'all', HASH(REMOTE)] as const
const FILTERS: unknown[][] = [
  [['Code'], [], []],
  [[' Code ', 'Slack', 'Code', 7], [], []],
  [[], ['words (english)'], []],
  [[], [], ['run-2', '']],
  [['Code'], ['words (english)'], ['run-1']],
  ['Code', null, {}],
]

/** The windowed Analyze members (`(uid[, hash], sinceMs, untilMs, …filters)`). */
const WINDOWED = ['ListLayerUsage', 'ListMatrixCells', 'ListMinuteStats', 'ListBksMinute'] as const
const WINDOWED_LOCAL_TIME = ['ListActivityGrid', 'ListMatrixCellsByDay', 'GetPeakRecords'] as const

/** The arguments the windowed handlers reject or default. */
const BAD_WINDOWS: unknown[][] = [
  [-5, MAX],
  [t(10, 3), t(10, 1)],
  ['0', 'later'],
  [Number.NaN, Infinity],
  [undefined, undefined],
]

function windowed(name: string, filtered: boolean): QueryCall[] {
  const calls: QueryCall[] = []
  for (const [since, until] of [ALL_TIME, WINDOW, ODD_WINDOW, ...BAD_WINDOWS]) {
    calls.push(c(name, UID_A, since, until), c(`${name}Local`, UID_A, since, until), c(`${name}ForHash`, UID_A, REMOTE, since, until))
  }
  if (filtered) {
    for (const f of FILTERS) {
      calls.push(c(name, UID_A, ...ALL_TIME, ...f), c(`${name}Local`, UID_A, ...ALL_TIME, ...f), c(`${name}ForHash`, UID_A, OWN, ...ALL_TIME, ...f))
    }
  }
  calls.push(
    c(name, UID_B, ...ALL_TIME),
    c(name, '', ...ALL_TIME), c(name, 5, ...ALL_TIME), c(`${name}Local`, null, ...ALL_TIME),
    c(`${name}ForHash`, UID_A, '', ...ALL_TIME), c(`${name}ForHash`, UID_A, 7, ...ALL_TIME),
  )
  return calls
}

function rangeArgs(): unknown[][] {
  return [
    ...SCOPES.flatMap((scope) => [[UID_A, ...ALL_TIME, scope], [UID_A, ...WINDOW, scope], [UID_A, ...ODD_WINDOW, scope]]),
    [UID_A, ...WINDOW, HASH(OWN)],
    [UID_B, ...ALL_TIME, 'all'],
    ['', ...ALL_TIME, 'own'],
    [UID_A, t(10, 3), t(10, 3), 'own'],
    [UID_A, t(10, 3), t(10, 1), 'own'],
    [UID_A, 'now', t(10, 1), 'own'],
    [UID_A, 0, Infinity, 'own'],
    [UID_A, ...ALL_TIME, 'mine'],
    [UID_A, ...ALL_TIME, HASH('')],
    [UID_A, ...ALL_TIME, { kind: 'own' }],
    [UID_A, ...ALL_TIME, undefined],
  ]
}

const QWERTY = { id: 'qwerty', map: {} }
const COLEMAK = { id: 'colemak', name: 'Colemak', map: { KC_E: 'F', KC_R: 'P', KC_T: 'G', KC_S: 'R', KC_D: 'S', KC_F: 'T', KC_J: 'N', KC_K: 'E', KC_L: 'I', KC_SCOLON: 'O' } }
const SHIFTED = { id: 'shifted', map: { KC_A: 'Ä\nä    æ', KC_Q: '', KC_W: null, KC_1: '!\n1', KC_SPACE: ' ', KC_G: 'İ', KC_H: 'g' } }
const METRICS = ['fingerLoad', 'handBalance', 'rowDist', 'homeRow']

function layoutOptions(): unknown[] {
  return [
    { source: QWERTY, targets: [QWERTY, COLEMAK], metrics: METRICS },
    { source: COLEMAK, targets: [SHIFTED, QWERTY], metrics: ['rowDist', 'unknown', 'fingerLoad', 'rowDist'] },
    { source: QWERTY, targets: [COLEMAK], metrics: METRICS, fingerOverrides: { '1,1': 'right-index', '0,2': 'left-pinky', '9,9': 'left-thumb' } },
    { source: QWERTY, targets: [], metrics: [] },
    { source: QWERTY, targets: [COLEMAK], metrics: METRICS, fingerOverrides: { 'a,1': 'left-index' } },
    { source: QWERTY, targets: [COLEMAK], metrics: METRICS, fingerOverrides: { '1,1': 'left-toe' } },
    { source: QWERTY, targets: [COLEMAK], metrics: METRICS, fingerOverrides: ['left-index'] },
    { source: QWERTY, targets: [COLEMAK], metrics: METRICS, fingerOverrides: null },
    { source: { id: '', map: {} }, targets: [], metrics: [] },
    { source: QWERTY, targets: [{ id: 'x' }], metrics: [] },
    { source: QWERTY, targets: {}, metrics: [] },
    { source: QWERTY, targets: [] },
    { source: QWERTY, targets: [{ id: 'bad', map: { KC_A: 5 } }], metrics: [] },
    'options',
    null,
  ]
}

/** Calls whose answer does not depend on the time zone. */
export function independentCalls(): QueryCall[] {
  const calls: QueryCall[] = [
    c('ListKeyboards'),
    c('ListDeviceInfos', UID_A), c('ListDeviceInfos', UID_B), c('ListDeviceInfos', ''), c('ListDeviceInfos', ['x']),
    c('ListLocalDeviceDays', UID_A, OWN), c('ListLocalDeviceDays', UID_A, REMOTE), c('ListLocalDeviceDays', UID_A, 'hash-none'),
    c('ListLocalDeviceDays', UID_A, ''), c('ListLocalDeviceDays', 5, OWN),
    c('GetMatrixHeatmap', UID_A, 0, 0), c('GetMatrixHeatmap', UID_A, 1, t(10, 0) + 59_999), c('GetMatrixHeatmap', UID_A, 0.5, 0),
    c('GetMatrixHeatmap', UID_A, -1, 0), c('GetMatrixHeatmap', UID_A, '0', 0), c('GetMatrixHeatmap', UID_A, 0, Infinity),
    c('GetMatrixHeatmap', '', 0, 0),
    ...WINDOWED.flatMap((name) => windowed(name, true)),
    ...windowed('ListSessions', false),
  ]
  for (const member of ['ListAppsForRange', 'ListTypingTestsForRange', 'GetAppUsageForRange', 'GetWpmByAppForRange']) {
    calls.push(...rangeArgs().map((args) => c(member, ...args)))
  }
  calls.push(
    ...rangeArgs().map((args) => c('ListTypingTestRunsForRange', ...args, [])),
    c('ListTypingTestRunsForRange', UID_A, ...ALL_TIME, 'all', ['novel.txt']),
    c('ListTypingTestRunsForRange', UID_A, ...ALL_TIME, 'own', [' words (english) ', 'novel.txt']),
    c('ListTypingTestRunsForRange', UID_A, ...ALL_TIME, 'own', 'novel.txt'),
  )
  for (const layer of [0, 1, 0.5]) {
    calls.push(...rangeArgs().map(([uid, since, until, scope]) => c('GetMatrixHeatmapForRange', uid, layer, since, until, scope)))
  }
  calls.push(
    ...FILTERS.map((f) => c('GetMatrixHeatmapForRange', UID_A, 0, ...ALL_TIME, 'own', ...f)),
    c('GetMatrixHeatmapForRange', UID_A, -1, ...ALL_TIME, 'own'),
    c('GetMatrixHeatmapForRange', UID_A, 'zero', ...ALL_TIME, 'own'),
  )
  const views: unknown[] = ['top', 'slow']
  const bigramOptions: unknown[] = [
    undefined, {}, { gram: 3 }, { gram: 2, limit: 3 }, { limit: 5.9, minSampleCount: 0 }, { minSampleCount: 6.5 },
    { gram: 3, minSampleCount: 1, limit: 2 }, { limit: 0.5 }, { limit: -1, minSampleCount: -1, gram: '3' }, { limit: 1e300 },
  ]
  for (const view of views) {
    for (const options of bigramOptions) {
      calls.push(c('GetBigramAggregateForRange', UID_A, ...ALL_TIME, view, 'all', options))
    }
    for (const [uid, since, until, scope] of rangeArgs()) {
      calls.push(c('GetBigramAggregateForRange', uid, since, until, view, scope, { minSampleCount: 1 }))
    }
    for (const f of FILTERS) calls.push(c('GetBigramAggregateForRange', UID_A, ...ALL_TIME, view, 'own', { minSampleCount: 0 }, ...f))
  }
  calls.push(
    c('GetBigramAggregateForRange', UID_A, ...ALL_TIME, 'fast', 'all', {}),
    c('GetBigramAggregateForRange', '', ...ALL_TIME, 'slow', 'all', {}),
  )
  for (const member of ['ListRolloverMinutes', 'ListDurationCells']) {
    calls.push(...rangeArgs().map(([uid, since, until, scope]) => c(member, uid, scope, since, until)))
    calls.push(...FILTERS.map((f) => c(member, UID_A, 'all', ...ALL_TIME, ...f)))
  }
  const windows = [ALL_TIME, WINDOW, [t(9, 0), t(9, 30)], [t(8, 0), t(8, 30)], [t(10, 2), t(10, 3)]]
  for (const options of layoutOptions()) {
    calls.push(c('GetLayoutComparisonForRange', UID_A, ...WINDOW, 'own', options))
  }
  for (const [since, until] of windows) {
    for (const scope of SCOPES) calls.push(c('GetLayoutComparisonForRange', UID_A, since, until, scope, layoutOptions()[0]))
  }
  calls.push(
    ...FILTERS.map((f) => c('GetLayoutComparisonForRange', UID_A, ...ALL_TIME, 'all', layoutOptions()[0], ...f)),
    ...rangeArgs().slice(9).map(([uid, since, until, scope]) => c('GetLayoutComparisonForRange', uid, since, until, scope, layoutOptions()[0])),
  )
  return calls
}

/** Calls that go through local days (SQLite's `localtime`). */
export function localTimeCalls(): QueryCall[] {
  const calls: QueryCall[] = []
  for (const name of ['ListItems', 'ListIntervalItems']) {
    calls.push(c(name, UID_A), c(`${name}Local`, UID_A), c(`${name}ForHash`, UID_A, REMOTE), c(`${name}ForHash`, UID_A, OWN))
    calls.push(c(name, UID_B), c(name, ''), c(`${name}Local`, 5), c(`${name}ForHash`, UID_A, ''), c(`${name}ForHash`, UID_A, null))
  }
  for (const f of FILTERS) {
    calls.push(c('ListItems', UID_A, ...f), c('ListItemsLocal', UID_A, ...f), c('ListItemsForHash', UID_A, OWN, ...f))
  }
  for (const name of WINDOWED_LOCAL_TIME) calls.push(...windowed(name, true))
  calls.push(c('ListActivityGrid', UID_A, Date.UTC(2024, 0, 1), Date.UTC(2027, 0, 1)), c('GetPeakRecords', 'uid-empty', ...ALL_TIME))
  return calls
}

/** One handler run: its answer as JSON text, or that it threw. */
export interface Recorded {
  member: string
  args: unknown
  response: string | null
  error?: true
}

/** The channel of a member: `typingAnalyticsListItemsLocal` →
 * `TYPING_ANALYTICS_LIST_ITEMS_LOCAL`. */
export function channelKey(member: string): string {
  return member.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

export async function runCalls(
  calls: QueryCall[],
  handler: (member: string) => (...args: unknown[]) => unknown,
): Promise<Recorded[]> {
  const out: Recorded[] = []
  for (const { member, args } of calls) {
    const run = handler(member)
    try {
      const value = await run(...args)
      out.push({ member, args: tagged(args), response: JSON.stringify(value) ?? null })
    } catch {
      out.push({ member, args: tagged(args), response: null, error: true })
    }
  }
  return out
}

/** The characters the recorder writes, and pairs of ids from them and from
 * other characters, with what `localeCompare` answers for each pair. */
export function collationFixture(): unknown {
  const chars = [...'0123456789_-.e+']
  const order = [...chars].sort((a, b) => a.localeCompare(b)).join('')
  const sign = (a: string, b: string): number => Math.sign(a.localeCompare(b))
  // A fixed generator of ids: keycodes joined by `_`, and the odd forms.
  let state = 0x2f6b_1a3d
  const next = (n: number): number => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0
    return state % n
  }
  const id = (): string => {
    const parts = 1 + next(3)
    return Array.from({ length: parts }, () => {
      const forms = [String(next(300)), String(next(10)), `${next(9) + 1}e+${next(30)}`, `-${next(50)}`, `${next(9)}.${next(9)}`, '']
      return forms[next(forms.length)]
    }).join('_')
  }
  const recorded = Array.from({ length: 300 }, () => [id(), id()] as const).map(([a, b]) => [a, b, sign(a, b)])
  const others = [['a_B', 'A_b'], ['a', 'B'], ['x_1', '_1'], ['é_1', 'f_1'], ['Ω', 'z']].map(([a, b]) => [a, b, sign(a, b)])
  return { order, recorded, others }
}
