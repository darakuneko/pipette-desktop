// SPDX-License-Identifier: GPL-2.0-or-later
// The Analyze post export cases: the typing analytics seed of the query
// fixtures (../../analytics-db-fixtures/query-calls.ts) with this device's
// hash replaced by the harness's fixed machine hash, keymap snapshots of
// that device, the saved filter conditions of one keyboard, and the
// parameters the renderer sends with each preview / upload.
//
// The cases cover the three device scopes, the category picker, the app
// filter and the per-app slices, the projection of the saved filters, the
// Layout Comparison with and without inputs (layers, names, finger
// overrides), and the conditions the preparation fails or throws on.

import { buildQuerySeed, QUERY_TREE } from '../../analytics-db-fixtures/query-calls'
import { OWN, REMOTE, UID_A } from '../../analytics-db-fixtures/db-methods'
import type { Tree } from '../../sync-fixtures/harness'
import { FIXED_MACHINE_HASH } from '../hub-harness'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = Date.UTC(2026, 9, 15)
const t = (h: number, m: number): number => DAY + h * HOUR + m * MINUTE

/** The query seed as this device: its rows of `hash-own` are the fixed
 * machine hash's. */
export function buildExportSeed(): string {
  return buildQuerySeed().split(`"${OWN}"`).join(`"${FIXED_MACHINE_HASH}"`)
}

/** The keymap snapshots of the query tree, under the fixed machine hash. */
function snapshotTree(): Tree {
  const tree: Tree = {}
  const prefix = `typing-analytics/keymaps/${UID_A}/${OWN}/`
  for (const [path, content] of Object.entries(QUERY_TREE)) {
    if (!path.startsWith(prefix) || typeof content !== 'string') continue
    const file = path.slice(prefix.length)
    tree[`typing-analytics/keymaps/${UID_A}/${FIXED_MACHINE_HASH}/${file}`] = content.split(`"${OWN}"`).join(`"${FIXED_MACHINE_HASH}"`)
  }
  return tree
}

const FILTER_DIR = `sync/keyboards/${UID_A}/analyze_filters`

/** The saved filter conditions: entry id → the file's text. */
const FILTERS: Record<string, string> = {}

function save(id: string, payload: unknown): string {
  FILTERS[id] = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return id
}

const DAY_WINDOW = { fromMs: t(9, 30), toMs: t(10, 30) }
const MONTH_WINDOW = { fromMs: Date.UTC(2026, 8, 16), toMs: Date.UTC(2026, 9, 16) }
const LONG_WINDOW = { fromMs: Date.UTC(2024, 0, 1), toMs: Date.UTC(2027, 0, 1) }
const ODD_WINDOW = { fromMs: t(10, 0) + 0.5, toMs: t(10, 5) + 30_000 }

const TAB_FILTERS = {
  heatmap: { mode: 'count', layer: 0, normalize: null },
  wpm: { granularity: 'minute', smoothing: 3 },
  interval: null,
  activity: { metric: 'keystrokes' },
  layer: { view: 'keystrokes' },
  ergonomics: { learningCurve: 'week' },
  bigrams: { pairIntervalThresholdMs: 150, topLimit: 50, view: 'slow' },
  layoutComparison: { targets: ['colemak'], metrics: ['fingerLoad'] },
  extra: { ignored: true },
}

const F = {
  own: save('f-own', { version: 1, analysisTab: 'wpm', range: DAY_WINDOW, filters: { deviceScopes: ['own'], appScopes: [], ...TAB_FILTERS } }),
  all: save('f-all', { version: 1, analysisTab: 'bigrams', range: MONTH_WINDOW, filters: { deviceScopes: ['all'], appScopes: [] } }),
  remote: save('f-remote', { version: 1, range: DAY_WINDOW, filters: { deviceScopes: [{ kind: 'hash', machineHash: REMOTE }], bigrams: { pairIntervalThresholdMs: '150' } } }),
  noScope: save('f-no-scope', { version: 1, range: ODD_WINDOW, filters: { deviceScopes: [], appScopes: ['Code', 7, 'Slack'] } }),
  badScope: save('f-bad-scope', { version: 1, range: DAY_WINDOW, filters: { deviceScopes: [{ kind: 'hash', machineHash: '' }, 'all'], appScopes: 'Code' } }),
  bogusScope: save('f-bogus-scope', { version: 1, range: DAY_WINDOW, filters: { deviceScopes: ['bogus'], appScopes: [' Code '] } }),
  code: save('f-code', { version: 1, range: DAY_WINDOW, filters: { deviceScopes: ['all'], appScopes: ['Code'] } }),
  long: save('f-long', { version: 1, range: LONG_WINDOW, filters: { deviceScopes: ['own'] } }),
  small: save('f-small', { version: 1, range: { fromMs: t(10, 6), toMs: t(10, 8) }, filters: { deviceScopes: ['own'] } }),
  inverted: save('f-inverted', { version: 1, range: { fromMs: t(10, 30), toMs: t(9, 30) }, filters: { deviceScopes: ['all'] } }),
  early: save('f-early', { version: 1, range: { fromMs: t(8, 0), toMs: t(8, 30) }, filters: { deviceScopes: ['own'] } }),
  noFilters: save('f-no-filters', { version: 1, range: DAY_WINDOW }),
  textFilters: save('f-text-filters', { version: 1, range: DAY_WINDOW, filters: 'own' }),
  nullFilters: save('f-null-filters', { version: 1, range: DAY_WINDOW, filters: null }),
  notJson: save('f-not-json', '{"version":1,'),
  v2: save('f-v2', { version: 2, range: DAY_WINDOW }),
  noRange: save('f-no-range', { version: 1, range: { fromMs: t(9, 0), toMs: '1' } }),
}

const entry = (id: string) => ({
  id,
  label: id,
  filename: `${id}.json`,
  savedAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:00:00.000Z',
})

/** The userData of every case. */
export function exportTree(): Tree {
  const ids = Object.keys(FILTERS)
  return {
    ...snapshotTree(),
    [`${FILTER_DIR}/index.json`]: JSON.stringify({
      uid: UID_A,
      entries: [
        ...ids.map(entry),
        { ...entry('f-deleted'), filename: `${F.own}.json`, deletedAt: '2026-10-15T13:00:00.000Z' },
      ],
    }, null, 2),
    ...Object.fromEntries(ids.map((id) => [`${FILTER_DIR}/${id}.json`, FILTERS[id]])),
  }
}

// --- Layout Comparison inputs ---

function gridKeys(): unknown[] {
  const keys = []
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) keys.push({ x: col + (row === 3 ? 0.5 : 0), y: row, width: 1, height: 1, row, col })
  }
  return keys
}

const QWERTY = { id: 'qwerty', name: 'QWERTY', map: {} }
const COLEMAK = { id: 'colemak', name: 'Colemak', map: { KC_E: 'F', KC_R: 'P', KC_T: 'G', KC_S: 'R', KC_D: 'S', KC_F: 'T', KC_J: 'N', KC_K: 'E', KC_L: 'I', KC_SCOLON: 'O' } }
const SHIFTED = { id: 'shifted', map: { KC_A: 'Ä\nä    æ', KC_Q: '', KC_W: null, KC_1: '!\n1', KC_SPACE: ' ', KC_G: 'İ', KC_H: 'g' } }
const ALL_METRICS = ['fingerLoad', 'handBalance', 'rowDist', 'homeRow']

const LAYOUT_FULL = { source: QWERTY, targets: [QWERTY, COLEMAK, SHIFTED], metrics: [...ALL_METRICS, 'unknown'], kleKeys: gridKeys() }
const LAYOUT_LAYER_1 = { source: QWERTY, targets: [COLEMAK], metrics: ['rowDist', 'fingerLoad'], kleKeys: gridKeys(), layer: 1 }
const LAYOUT_NAMES = {
  source: COLEMAK,
  targets: [{ ...COLEMAK, name: 'First' }, { ...COLEMAK, name: 'Second' }, { ...QWERTY, name: '' }],
  metrics: 'fingerLoad',
  kleKeys: gridKeys(),
  layer: null,
}
const LAYOUT_NO_GEOMETRY = { source: QWERTY, targets: [COLEMAK], metrics: ALL_METRICS, kleKeys: [] }
const LAYOUT_NO_TARGETS = { source: QWERTY, targets: [], metrics: ALL_METRICS, kleKeys: gridKeys() }

const KEYBOARD = { productName: 'Alpha', vendorId: 0xfeed, productId: 1 }

/** One preparation: the preview / upload parameters it is given. */
export interface ExportCase {
  name: string
  params: Record<string, unknown>
}

function params(entryId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: UID_A,
    entryId,
    title: 'preview',
    thumbnailBase64: '',
    keyboard: KEYBOARD,
    fingerOverrides: {},
    layoutComparisonInputs: null,
    ...over,
  }
}

export const EXPORT_CASES: ExportCase[] = [
  { name: 'this device, every category', params: params(F.own) },
  { name: 'every device over thirty days', params: params(F.all) },
  { name: 'another device', params: params(F.remote) },
  { name: 'no device scope is this device; the app filter keeps strings', params: params(F.noScope) },
  { name: 'an empty hash is this device; an app filter that is not a list is none', params: params(F.badScope) },
  { name: 'an unknown scope is this device; app names are not trimmed', params: params(F.bogusScope) },
  { name: 'one app', params: params(F.code, { appDataApps: ['Code', 'Slack'] }) },
  { name: 'a range longer than thirty days', params: params(F.long) },
  { name: 'too few keystrokes', params: params(F.small) },
  { name: 'an inverted range', params: params(F.inverted) },
  { name: 'no saved filters', params: params(F.noFilters) },
  { name: 'saved filters that are text', params: params(F.textFilters, { fingerOverrides: 'ab' }) },
  { name: 'saved filters that are null', params: params(F.nullFilters, { fingerOverrides: ['left-index'] }) },
  { name: 'only the heatmap', params: params(F.own, { categories: ['heatmap'] }) },
  { name: 'bigrams and the layout comparison', params: params(F.all, { categories: ['bigrams', 'layoutComparison'], layoutComparisonInputs: LAYOUT_FULL }) },
  { name: 'activity', params: params(F.all, { categories: ['activity'] }) },
  { name: 'the minute and matrix categories', params: params(F.all, { categories: ['wpm', 'ergonomics', 'layer', 'interval'] }) },
  { name: 'categories that are not text are every category', params: params(F.code, { categories: [5, null] }) },
  { name: 'an empty category list is every category', params: params(F.code, { categories: [] }) },
  { name: 'no per-app slices', params: params(F.all, { appDataApps: [] }) },
  { name: 'one app is no per-app slices', params: params(F.all, { appDataApps: ['Code'] }) },
  { name: 'two chosen apps', params: params(F.all, { appDataApps: ['Mail', 'Code', 'Idle', 7] }) },
  { name: 'an app list that is not a list is every app', params: params(F.all, { appDataApps: 'Code' }) },
  {
    name: 'the layout comparison with finger overrides',
    params: params(F.own, {
      layoutComparisonInputs: LAYOUT_FULL,
      fingerOverrides: { '1,1': 'right-index', '0,2': 'left-pinky', bad: 'left-index', '0,0': 'left-elbow', '9,9': 'left-thumb' },
    }),
  },
  { name: 'the layout comparison on layer 1', params: params(F.all, { layoutComparisonInputs: LAYOUT_LAYER_1, appDataApps: [] }) },
  { name: 'target names and a null layer', params: params(F.all, { layoutComparisonInputs: LAYOUT_NAMES, appDataApps: ['Code', 'Slack'] }) },
  { name: 'the layout comparison without geometry', params: params(F.remote, { layoutComparisonInputs: LAYOUT_NO_GEOMETRY }) },
  { name: 'the layout comparison without targets', params: params(F.noScope, { layoutComparisonInputs: LAYOUT_NO_TARGETS }) },
  { name: 'inputs but the category is off', params: params(F.own, { categories: ['heatmap'], layoutComparisonInputs: LAYOUT_FULL }) },
  { name: 'every finger override is invalid', params: params(F.own, { layoutComparisonInputs: LAYOUT_NO_GEOMETRY, fingerOverrides: { x: 'y' } }) },
  { name: 'keyboard fields left out', params: params(F.noFilters, { keyboard: {} }) },
  { name: 'keyboard fields of other types', params: params(F.noFilters, { keyboard: { productName: 7, vendorId: '1', productId: null } }) },
  { name: 'no keymap snapshot', params: params(F.early) },
  { name: 'a deleted entry', params: params('f-deleted') },
  { name: 'an unknown entry', params: params('f-unknown') },
  { name: 'a payload that is not JSON', params: params(F.notJson) },
  { name: 'another payload version', params: params(F.v2) },
  { name: 'a range without numbers', params: params(F.noRange) },
  { name: 'no uid', params: params(F.own, { uid: '' }) },
  { name: 'a uid that is not text', params: params(F.own, { uid: 5 }) },
  { name: 'no entry id', params: params(F.own, { entryId: null }) },
  { name: 'a uid that is not a path segment', params: params(F.own, { uid: '../x' }) },
  { name: 'no keyboard', params: params(F.own, { keyboard: null }) },
]
