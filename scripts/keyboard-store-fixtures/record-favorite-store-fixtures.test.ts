// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the favorite store of
// src-tauri/crates/pipette-keyboard-stores: runs the real FAVORITE_STORE_*
// handlers of src/main/favorite-store.ts on a userData directory built in a
// temp directory, at fixed times and with a fixed sequence of new ids. The
// file dialogs answer a path under userData (or are cancelled). It records
// each step's response, the sync units reported to notifyChange, and every
// file and directory left behind (path → content).
//
// The Tauri build splits the export and the import between the backend,
// which reads and writes the store, and a worker, which converts the
// keycodes (src/shared/favorite-transfer.ts). For those steps the fixture
// also records what crosses that split:
// - export: the stored favorites the handler read (`bodies`, what the
//   backend's read must answer) and the file the shared helpers build of
//   them (`built`; the crate writes it and compares it with the file the
//   handler wrote);
// - export of the current value: the file built of the value the handler
//   converted;
// - import: the plan of the file (`plan`, the batches the backend writes).
// The crate replays the store side and compares the bytes; the shim's tests
// (src/tauri-shim/__tests__/favorite-transfer-worker.test.ts) run the
// worker on the same inputs and compare its answers.
//
// A file-system error's text is the OS's and Node's, which the crate does
// not copy: such an error is recorded as `<os error>`.
//
// Run: pnpm run generate:keyboard-store-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const { handlers, notified, paths, ids, dialogs, transfers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  notified: [] as string[],
  paths: { userData: '' },
  ids: { next: 1 },
  /** The path the next dialog answers, under userData; null cancels it. */
  dialogs: { answer: null as string | null, defaultPath: undefined as string | undefined },
  /** What the handler of the current step handed the shared helpers. */
  transfers: { bodies: [] as { label: unknown; savedAt: unknown; body: string }[], current: null as [unknown, unknown, unknown] | null },
}))

vi.mock('electron', () => {
  const chosen = (): string | undefined => (dialogs.answer === null ? undefined : `${paths.userData}/${dialogs.answer}`)
  return {
    app: { getPath: () => paths.userData },
    BrowserWindow: { fromWebContents: () => ({}) },
    dialog: {
      showSaveDialog: (_win: unknown, options: { defaultPath?: string }) => {
        dialogs.defaultPath = options.defaultPath
        const filePath = chosen()
        return Promise.resolve({ canceled: filePath === undefined, filePath })
      },
      showOpenDialog: () => {
        const filePath = chosen()
        return Promise.resolve({ canceled: filePath === undefined, filePaths: filePath === undefined ? [] : [filePath] })
      },
    },
  }
})
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}))
vi.mock('../../src/main/sync/sync-service', () => ({ notifyChange: (unit: string) => notified.push(unit) }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  /** The ids the crate's tests hand out: `00000000-0000-4000-8000-{n:012}`. */
  const randomUUID = (): string => `00000000-0000-4000-8000-${String(ids.next++).padStart(12, '0')}`
  return { ...actual, default: { ...actual, randomUUID }, randomUUID }
})
vi.mock('../../src/shared/favorite-transfer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/favorite-transfer')>()
  return {
    ...actual,
    favoriteExportEntry: (...args: Parameters<typeof actual.favoriteExportEntry>) => {
      const [, , label, savedAt, body] = args
      transfers.bodies.push({ label, savedAt, body })
      return actual.favoriteExportEntry(...args)
    },
    currentFavoriteExportData: (...args: Parameters<typeof actual.currentFavoriteExportData>) => {
      const converted = actual.currentFavoriteExportData(...args)
      transfers.current = args
      return converted
    },
  }
})

import { setupFavoriteStore } from '../../src/main/favorite-store'
import {
  buildCurrentFavoriteExport,
  buildFavoriteExport,
  planFavoriteImport,
  readFavoriteExportFile,
} from '../../src/shared/favorite-transfer'
import type { FavoriteType } from '../../src/shared/types/favorite-store'
import { IpcChannels } from '../../src/shared/ipc/channels'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-keyboard-stores/tests/fixtures/ts_favorite_store_scenarios.json')

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8), or null for a directory. */
type Tree = Record<string, string | { hex: string } | null>

type Step =
  | { op: 'list'; type: unknown }
  | { op: 'save'; type: unknown; json: string; label: string }
  | { op: 'load'; type: unknown; id: string }
  | { op: 'rename'; type: unknown; id: string; label: string }
  | { op: 'delete'; type: unknown; id: string }
  | { op: 'hubPostId'; type: unknown; id: string; hubPostId: string | null }
  | { op: 'hubPrivate'; type: unknown; id: string; link: unknown }
  /** The dialogs answer `dialog` (under userData), or are cancelled. */
  | { op: 'export'; type: unknown; vialProtocol: unknown; entryId?: unknown; dialog: string | null }
  | { op: 'exportCurrent'; type: unknown; vialProtocol: unknown; dataJson: unknown; dialog: string | null }
  | { op: 'importToCurrent'; type: unknown; dialog: string | null }
  | { op: 'import'; dialog: string | null }
  /** The clock moves to this time. */
  | { op: 'at'; time: string }

interface Scenario {
  name: string
  time: string
  tree: Tree
  steps: Step[]
}

const T0 = '2026-10-16T12:00:00.000Z'
const MIN = 60_000
const t = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const at = (ms: number): Step => ({ op: 'at', time: t(ms) })
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const dirOf = (type: string): string => `sync/favorites/${type}`
const index = (type: string, entries: unknown[]): string => JSON.stringify({ type, entries }, null, 2)
const v1 = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({
  id, label: `Label ${id}`, filename, savedAt: t(-60 * MIN), ...extra,
})

const TD = { onTap: 4, onHold: 0x7c00, onDoubleTap: 0, onTapHold: 0x5c00, tappingTerm: 200 }
const COMBO = { key1: 4, key2: 5, key3: 0, key4: 0, output: 0x0204 }
const KO = { triggerKey: 0x7c00, replacementKey: 0x4004, layers: 3, triggerMods: 1, negativeMods: 0, suppressedMods: 0, options: 7, enabled: true }
const ARK = { lastKey: 4, altKey: 0x7c00, allowedMods: 0, options: 1, enabled: false }
const MACRO = [['text', 'hello'], ['tap', 'KC_A']]
const body = (type: string, data: unknown): string => JSON.stringify({ type, data })

const list = (type: unknown = 'tapDance'): Step => ({ op: 'list', type })
const save = (label: string, json: string = body('tapDance', TD), type: unknown = 'tapDance'): Step => ({ op: 'save', type, json, label })
const load = (id: string, type: unknown = 'tapDance'): Step => ({ op: 'load', type, id })
const rename = (id: string, label: string, type: unknown = 'tapDance'): Step => ({ op: 'rename', type, id, label })
const del = (id: string, type: unknown = 'tapDance'): Step => ({ op: 'delete', type, id })
const exportAll = (dialog: string | null, type: unknown = 'tapDance', vialProtocol: unknown = 6): Step =>
  ({ op: 'export', type, vialProtocol, dialog })
const exportOne = (entryId: unknown, dialog: string | null, type: unknown = 'tapDance', vialProtocol: unknown = 6): Step =>
  ({ op: 'export', type, vialProtocol, entryId, dialog })
const exportCurrent = (dataJson: unknown, dialog: string | null, type: unknown = 'tapDance', vialProtocol: unknown = 6): Step =>
  ({ op: 'exportCurrent', type, vialProtocol, dataJson, dialog })
const importFile = (dialog: string | null): Step => ({ op: 'import', dialog })
const importToCurrent = (type: unknown, dialog: string | null): Step => ({ op: 'importToCurrent', type, dialog })

const EXPORTS: Tree = { 'exports/': null }

/** An export file as text. */
const exportFile = (categories: Record<string, unknown>, extra: Record<string, unknown> = { version: 3, vial_protocol: 6 }): string =>
  JSON.stringify({ app: 'pipette', scope: 'fav', exportedAt: t(-MIN), ...extra, categories })

const SCENARIOS: Scenario[] = [
  {
    name: 'save, list, load, rename, hub links and delete',
    time: T0,
    tree: {},
    steps: [
      save('First'),
      save('名前 😀', body('tapDance', { ...TD, onTap: 5 })),
      save('Macro', body('macro', MACRO), 'macro'),
      at(MIN),
      list(),
      list('macro'),
      list('combo'),
      load(uuid(1)),
      rename(uuid(1), 'Renamed'),
      { op: 'hubPostId', type: 'tapDance', id: uuid(2), hubPostId: ' post-1 ' },
      { op: 'hubPrivate', type: 'tapDance', id: uuid(2), link: { id: 'p1', url: '/files/p1?token=t', expiresAt: null } },
      { op: 'hubPostId', type: 'tapDance', id: uuid(2), hubPostId: '　' },
      { op: 'hubPostId', type: 'tapDance', id: uuid(1), hubPostId: 'post-2' },
      { op: 'hubPostId', type: 'tapDance', id: uuid(1), hubPostId: null },
      { op: 'hubPrivate', type: 'tapDance', id: uuid(1), link: null },
      at(2 * MIN),
      del(uuid(2)),
      at(3 * MIN),
      del(uuid(2)),
      list(),
      load(uuid(2)),
      load('missing'),
      rename('missing', 'x'),
      del('missing'),
      { op: 'hubPostId', type: 'tapDance', id: 'missing', hubPostId: 'p' },
      load(uuid(3)),
    ],
  },
  {
    name: 'types that are not favorite types',
    time: T0,
    tree: {},
    steps: ['', 'tapdance', '../x', 'constructor', 5, null].flatMap((type) => [
      list(type),
      save('L', '{}', type),
      load('x', type),
      rename('x', 'y', type),
      del('x', type),
      { op: 'hubPostId', type, id: 'x', hubPostId: 'p' } as Step,
      { op: 'hubPrivate', type, id: 'x', link: null } as Step,
      exportAll('exports/x.json', type),
      exportCurrent(body('tapDance', TD), 'exports/x.json', type),
      importToCurrent(type, 'exports/x.json'),
    ]),
  },
  {
    name: 'a v1 index with legacy names, future clocks and unknown fields',
    time: T0,
    tree: {
      [`${dirOf('combo')}/index.json`]: '{\n  "before": [1, 2.50, 1e21],\n  "type": "combo",\n  "entries": [\n'
        + [
          JSON.stringify(v1('a', 'combo_2026-10-16T11-00-00.000Z.json', { updatedAt: t(-30 * MIN), extra: { keep: true } })),
          JSON.stringify(v1('b', 'combo_2026-10-16T11-00-00.000Z.json')),
          JSON.stringify({
            note: 'first', id: 'future', label: 'Future', filename: 'combo_2030-01-01T00-00-00.000Z_future.json',
            savedAt: '2030-01-01T00:00:00.000Z',
            clocks: { created: '2030-01-01T00:00:00.000Z', body: '2030-01-01T00:00:00.000Z', name: '2030-01-02T00:00:00.000Z', hub: 'nonsense' },
            updatedAt: '2031-01-01T00:00:00.000Z',
          }),
          JSON.stringify(v1('gone', 'combo_2026-10-16T10-00-00.000Z.json', { deletedAt: t(-10 * MIN) })),
          '"a string entry"', 'null', '42', '{"label":"no id"}', '{"id":7,"label":"numeric id"}',
        ].map((line) => `    ${line}`).join(',\n')
        + '\n  ],\n  "after": "kept"\n}\n',
      [`${dirOf('combo')}/combo_2026-10-16T11-00-00.000Z.json`]: body('combo', COMBO),
      [`${dirOf('combo')}/combo_2030-01-01T00-00-00.000Z_future.json`]: body('combo', { ...COMBO, key2: 6 }),
      [`${dirOf('combo')}/combo_2026-10-16T10-00-00.000Z.json`]: body('combo', COMBO),
      ...EXPORTS,
    },
    steps: [
      list('combo'),
      load('a', 'combo'),
      load('gone', 'combo'),
      exportAll('exports/legacy.json', 'combo'),
      rename('future', 'Renamed future', 'combo'),
      list('combo'),
      load('a', 'combo'),
      load('b', 'combo'),
      rename('gone', 'Renamed gone', 'combo'),
      del('a', 'combo'),
      list('combo'),
    ],
  },
  {
    name: 'an index that is not JSON is replaced by the next save',
    time: T0,
    tree: { [`${dirOf('tapDance')}/index.json`]: 'not json!!!' },
    steps: [list(), load('x'), save('L'), list()],
  },
  {
    name: 'an index of another type is replaced by the next save',
    time: T0,
    tree: {
      [`${dirOf('tapDance')}/index.json`]: index('macro', [v1('other', 'macro_2026-01-01T00-00-00.000Z_other.json')]),
      [`${dirOf('tapDance')}/macro_2026-01-01T00-00-00.000Z_other.json`]: body('macro', MACRO),
    },
    steps: [list(), load('other'), rename('other', 'x'), save('L')],
  },
  { name: 'an index that is an array', time: T0, tree: { [`${dirOf('tapDance')}/index.json`]: '[{"type":"tapDance","entries":[]}]' }, steps: [list(), save('L')] },
  { name: 'an index that is null', time: T0, tree: { [`${dirOf('tapDance')}/index.json`]: 'null' }, steps: [list(), save('L')] },
  { name: 'an index without an entries list', time: T0, tree: { [`${dirOf('tapDance')}/index.json`]: '{"type":"tapDance","entries":{"0":{"id":"x"}}}' }, steps: [list(), save('L')] },
  { name: 'an index with a byte order mark', time: T0, tree: { [`${dirOf('tapDance')}/index.json`]: '﻿{"type":"tapDance","entries":[]}' }, steps: [list(), save('L')] },
  {
    name: 'invalid UTF-8 in the index and a body',
    time: T0,
    tree: {
      [`${dirOf('tapDance')}/index.json`]: { hex: Buffer.concat([Buffer.from('{"type":"tapDance","entries":[{"id":"x","label":"Bad '), Buffer.from([0xff, 0xe6, 0x97]), Buffer.from('","filename":"x_x.json","savedAt":"2026-01-01T00:00:00.000Z"}]}')]).toString('hex') },
      [`${dirOf('tapDance')}/x_x.json`]: { hex: Buffer.concat([Buffer.from('{"type":"tapDance","note":"'), Buffer.from([0xc3]), Buffer.from(`","data":${JSON.stringify(TD)}}`)]).toString('hex') },
      ...EXPORTS,
    },
    steps: [list(), load('x'), exportAll('exports/bad.json'), rename('x', 'Good')],
  },
  {
    name: 'body filenames that are not safe',
    time: T0,
    tree: {
      [`${dirOf('tapDance')}/index.json`]: index('tapDance', [
        { id: 'up', label: 'up', savedAt: t(0), filename: '../escape.json' },
        { id: 'none', label: 'none', savedAt: t(0) },
        { id: 'null', label: 'null', savedAt: t(0), filename: null },
        { id: 'empty', label: 'empty', savedAt: t(0), filename: '' },
        { id: 'dot', label: 'dot', savedAt: t(0), filename: '..' },
      ]),
      'sync/favorites/escape.json': body('tapDance', TD),
      ...EXPORTS,
    },
    steps: [
      ...['up', 'none', 'null', 'empty', 'dot'].flatMap((id) => [load(id), exportOne(id, 'exports/one.json')]),
      exportAll('exports/all.json'),
    ],
  },
  {
    name: 'exports of stored favorites',
    time: T0,
    tree: {
      [`${dirOf('tapDance')}/index.json`]: index('tapDance', [
        v1('a', 'tapDance_a.json', { label: 'With data', extra: 1 }),
        v1('no-data', 'tapDance_no-data.json'),
        v1('not-json', 'tapDance_not-json.json'),
        v1('missing', 'tapDance_missing.json'),
        v1('dead', 'tapDance_dead.json', { deletedAt: t(-MIN) }),
        { id: 'odd', label: 42, filename: 'tapDance_odd.json' },
        v1('a', 'tapDance_a2.json', { label: 'Same id' }),
      ]),
      [`${dirOf('tapDance')}/tapDance_a.json`]: body('tapDance', TD),
      [`${dirOf('tapDance')}/tapDance_a2.json`]: JSON.stringify({ type: 'tapDance', data: { ...TD, onTap: 'KC_B', extra: [1e21, -0] } }),
      [`${dirOf('tapDance')}/tapDance_no-data.json`]: '{"type":"tapDance","data":null}',
      [`${dirOf('tapDance')}/tapDance_not-json.json`]: '{',
      [`${dirOf('tapDance')}/tapDance_dead.json`]: body('tapDance', TD),
      [`${dirOf('tapDance')}/tapDance_odd.json`]: '"just a string"',
      [`${dirOf('keyOverride')}/index.json`]: index('keyOverride', [v1('ko', 'keyOverride_ko.json')]),
      [`${dirOf('keyOverride')}/keyOverride_ko.json`]: body('keyOverride', KO),
      [`${dirOf('altRepeatKey')}/index.json`]: index('altRepeatKey', [v1('ark', 'altRepeatKey_ark.json')]),
      [`${dirOf('altRepeatKey')}/altRepeatKey_ark.json`]: body('altRepeatKey', ARK),
      [`${dirOf('macro')}/index.json`]: index('macro', [v1('m', 'macro_m.json')]),
      [`${dirOf('macro')}/macro_m.json`]: body('macro', MACRO),
      ...EXPORTS,
    },
    steps: [
      exportAll('exports/all.json'),
      at(MIN + 1234),
      exportAll('exports/all-v5.json', 'tapDance', 5),
      exportOne('a', 'exports/a.json'),
      exportOne('no-data', 'exports/no-data.json'),
      exportOne('not-json', 'exports/not-json.json'),
      exportOne('missing', 'exports/missing.json'),
      exportOne('dead', 'exports/dead.json'),
      exportOne('nowhere', 'exports/nowhere.json'),
      exportOne('odd', 'exports/odd.json'),
      exportOne(5, 'exports/x.json'),
      exportAll('exports/x.json', 'tapDance', '6'),
      exportAll('exports/x.json', 'tapDance', Number.NaN),
      exportAll(null),
      exportAll('exports/ko.json', 'keyOverride', 5),
      exportAll('exports/ark.json', 'altRepeatKey', 9),
      exportAll('exports/macro.json', 'macro'),
      exportAll('exports/empty.json', 'combo'),
      exportAll('missing-dir/x.json'),
    ],
  },
  {
    name: 'exports of the current value',
    time: T0,
    tree: { ...EXPORTS },
    steps: [
      exportCurrent(body('tapDance', TD), 'exports/td.json'),
      exportCurrent(body('keyOverride', KO), 'exports/ko5.json', 'keyOverride', 5),
      exportCurrent(body('macro', MACRO), 'exports/macro.json', 'macro'),
      exportCurrent('{"type":"tapDance"}', 'exports/x.json'),
      exportCurrent('{"type":"tapDance","data":null}', 'exports/x.json'),
      exportCurrent('not json', 'exports/x.json'),
      exportCurrent(5, 'exports/x.json'),
      exportCurrent(body('tapDance', TD), 'exports/x.json', 'tapDance', 'x'),
      exportCurrent(body('tapDance', TD), null),
      exportCurrent('"text"', 'exports/text.json'),
    ],
  },
  {
    name: 'imports into the current value',
    time: T0,
    tree: {
      'imports/v3.json': exportFile({ td: [{ label: 'a', savedAt: 's', data: { onTap: 'KC_A', onHold: 'RAG_T(KC_NO)', onDoubleTap: 7, onTapHold: 'MY_KEY', tappingTerm: 200 } }, { label: 'b', savedAt: 's', data: {} }] }, { version: 3, vial_protocol: 5 }),
      'imports/v2.json': exportFile({ ko: [{ label: 'k', savedAt: 's', data: { ...KO, triggerKey: 'QK_BOOT' } }], macro: [{ label: 'm', savedAt: 's', data: 'anything' }] }, { version: 2 }),
      'imports/empty.json': exportFile({ td: [] }),
      'imports/v1.json': exportFile({ td: [] }, { version: 1 }),
      'imports/bad.json': '{"app":"pipette"',
      'imports/array.json': '[]',
    },
    steps: [
      importToCurrent('tapDance', 'imports/v3.json'),
      importToCurrent('keyOverride', 'imports/v2.json'),
      importToCurrent('macro', 'imports/v2.json'),
      importToCurrent('combo', 'imports/v2.json'),
      importToCurrent('tapDance', 'imports/empty.json'),
      importToCurrent('tapDance', 'imports/v1.json'),
      importToCurrent('tapDance', 'imports/bad.json'),
      importToCurrent('tapDance', 'imports/array.json'),
      importToCurrent('tapDance', 'imports/none.json'),
      importToCurrent('tapDance', null),
    ],
  },
  {
    name: 'imports with duplicates, invalid data and legacy names',
    time: T0,
    tree: {
      [`${dirOf('tapDance')}/index.json`]: index('tapDance', [
        v1('live', 'tapDance_2026-01-01T00-00-00.000Z.json', { label: 'Dup', savedAt: '2026-01-01T00:00:00.000Z' }),
        v1('dead', 'tapDance_dead.json', { label: 'Dead', savedAt: '2026-01-02T00:00:00.000Z', deletedAt: t(-MIN) }),
      ]),
      [`${dirOf('tapDance')}/tapDance_2026-01-01T00-00-00.000Z.json`]: body('tapDance', TD),
      'imports/mixed.json': exportFile({
        combo: [{ label: 'bad combo', savedAt: 's', data: { key1: 'KC_A' } }],
        td: [
          { label: 'Dup', savedAt: '2026-01-01T00:00:00.000Z', data: { ...TD, onTap: 'KC_A' } },
          { label: 'Dead', savedAt: '2026-01-02T00:00:00.000Z', data: { ...TD, onTap: 'KC_B' } },
          { label: 'New', savedAt: '2026-01-03T00:00:00.000Z', data: { ...TD, onTap: 'KC_C', onHold: 'QK_BOOT' } },
          { label: 'New', savedAt: '2026-01-03T00:00:00.000Z', data: { ...TD, onTap: 'KC_D' } },
          { label: 'Bad', savedAt: 's', data: { onTap: 'KC_A' } },
          { label: '\uD800 lone', savedAt: '2026-01-04T00:00:00.000Z', extra: true, data: TD },
        ],
        macro: [{ label: 'Macro', savedAt: '2026-01-05T00:00:00.000Z', data: MACRO }, { label: 'Not a macro', savedAt: 's', data: [[1]] }],
        ark: [],
        ko: [{ label: 'KO v5', savedAt: '2026-01-06T00:00:00.000Z', data: { ...KO, triggerKey: 'RAG_T(KC_NO)', replacementKey: 'KC_ESCAPE' } }],
      }, { version: 3, vial_protocol: 5 }),
      'imports/v2.json': exportFile({ ark: [{ label: 'ARK', savedAt: 's', data: { ...ARK, lastKey: 'KC_A', altKey: 'KC_B' } }] }, { version: 2 }),
      'imports/v1.json': exportFile({ td: [] }, { version: 1 }),
      'imports/unknown.json': exportFile({ zz: [] }),
      'imports/bad-entry.json': exportFile({ td: [{ label: 'x', savedAt: 5, data: TD }] }),
      'imports/not-json.json': 'nope',
      'imports/protocol.json': exportFile({ td: [] }, { version: 3, vial_protocol: '6' }),
    },
    steps: [
      importFile('imports/mixed.json'),
      at(MIN),
      importFile('imports/mixed.json'),
      importFile('imports/v2.json'),
      importFile('imports/v1.json'),
      importFile('imports/unknown.json'),
      importFile('imports/bad-entry.json'),
      importFile('imports/not-json.json'),
      importFile('imports/protocol.json'),
      importFile('imports/none.json'),
      importFile(null),
      list(),
      list('macro'),
      list('keyOverride'),
      list('altRepeatKey'),
      list('combo'),
    ],
  },
  {
    name: 'an import over a store whose index is not JSON',
    time: T0,
    tree: {
      [`${dirOf('tapDance')}/index.json`]: 'oops',
      'imports/one.json': exportFile({ td: [{ label: 'One', savedAt: 's', data: TD }] }),
    },
    steps: [importFile('imports/one.json'), list()],
  },
]

let root = ''
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function build(dir: string, tree: Tree): void {
  for (const [path, content] of Object.entries(tree)) {
    const target = join(dir, path)
    if (content === null) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, typeof content === 'string' ? content : Buffer.from(content.hex, 'hex'))
  }
}

/** Every file and directory (`path/` → null) under `dir`. */
function record(dir: string, prefix = ''): Tree {
  const tree: Tree = {}
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (lstatSync(path).isDirectory()) {
      tree[`${prefix}${name}/`] = null
      Object.assign(tree, record(path, `${prefix}${name}/`))
    } else {
      const bytes = readFileSync(path)
      const text = bytes.toString('utf-8')
      tree[`${prefix}${name}`] = Buffer.from(text, 'utf-8').equals(bytes) ? text : { hex: bytes.toString('hex') }
    }
  }
  return tree
}

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const found = handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found as (...args: unknown[]) => Promise<unknown>
}

async function run(step: Exclude<Step, { op: 'at' }>): Promise<unknown> {
  const ev = { sender: {} }
  switch (step.op) {
    case 'list': return handler(IpcChannels.FAVORITE_STORE_LIST)(ev, step.type)
    case 'save': return handler(IpcChannels.FAVORITE_STORE_SAVE)(ev, step.type, step.json, step.label)
    case 'load': return handler(IpcChannels.FAVORITE_STORE_LOAD)(ev, step.type, step.id)
    case 'rename': return handler(IpcChannels.FAVORITE_STORE_RENAME)(ev, step.type, step.id, step.label)
    case 'delete': return handler(IpcChannels.FAVORITE_STORE_DELETE)(ev, step.type, step.id)
    case 'hubPostId': return handler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)(ev, step.type, step.id, step.hubPostId)
    case 'hubPrivate': return handler(IpcChannels.FAVORITE_STORE_SET_HUB_PRIVATE)(ev, step.type, step.id, step.link)
    case 'export': {
      const args = 'entryId' in step ? [step.type, step.vialProtocol, step.entryId] : [step.type, step.vialProtocol]
      return handler(IpcChannels.FAVORITE_STORE_EXPORT)(ev, ...args)
    }
    case 'exportCurrent': return handler(IpcChannels.FAVORITE_STORE_EXPORT_CURRENT)(ev, step.type, step.vialProtocol, step.dataJson)
    case 'importToCurrent': return handler(IpcChannels.FAVORITE_STORE_IMPORT_TO_CURRENT)(ev, step.type)
    case 'import': return handler(IpcChannels.FAVORITE_STORE_IMPORT)(ev)
  }
}

/** The response as JSON text, with a file-system error's text replaced. */
function outcome(response: unknown): string | null {
  const r = response as { error?: unknown }
  if (typeof r?.error === 'string' && /^Error: E[A-Z]+:/.test(r.error)) {
    return JSON.stringify({ ...r, error: '<os error>' })
  }
  return JSON.stringify(response) ?? null
}

/** Errors an export answers before it reads the stored favorites. */
const BEFORE_READ = ['Invalid scope', 'Invalid vialProtocol', 'Invalid entryId', 'Entry not found']

/** What the export or import of `step` handed across the split, if any;
 *  `response` is the handler's. */
function transfer(step: Step, dir: string, response: unknown): Record<string, unknown> | null {
  const { bodies, current } = transfers
  transfers.bodies = []
  transfers.current = null
  const shown = dialogs.defaultPath !== undefined ? { defaultPath: dialogs.defaultPath } : {}
  if (step.op === 'export') {
    if (BEFORE_READ.includes((response as { error?: string }).error ?? '')) return null
    const single = 'entryId' in step
    const built = buildFavoriteExport(step.type as FavoriteType, step.vialProtocol as number, bodies, single, new Date())
    return { bodies, built, ...shown }
  }
  if (step.op === 'exportCurrent') {
    if (!current) return null
    const [type, vialProtocol, dataJson] = current
    const built = buildCurrentFavoriteExport(type as FavoriteType, vialProtocol as number, dataJson as string, new Date())
    return { built, ...shown }
  }
  if (step.op === 'import' && step.dialog !== null) {
    try {
      const file = readFavoriteExportFile(readFileSync(join(dir, step.dialog), 'utf-8'))
      return file ? { plan: planFavoriteImport(file) } : null
    } catch {
      return null
    }
  }
  return null
}

interface Played {
  outcomes: (string | null)[]
  transfers: (Record<string, unknown> | null)[]
  notified: string[]
  after: Tree
}

async function play(scenario: Scenario, dir: string): Promise<Played> {
  paths.userData = dir
  notified.length = 0
  transfers.bodies = []
  transfers.current = null
  ids.next = 1
  build(dir, scenario.tree)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(scenario.time))
  try {
    const outcomes: (string | null)[] = []
    const crossed: (Record<string, unknown> | null)[] = []
    for (const step of scenario.steps) {
      if (step.op === 'at') {
        vi.setSystemTime(new Date(step.time))
        outcomes.push(null)
        crossed.push(null)
        continue
      }
      dialogs.answer = 'dialog' in step ? step.dialog : null
      dialogs.defaultPath = undefined
      // The plan reads the import file as it is before the step.
      const plan = step.op === 'import' ? transfer(step, dir, null) : null
      const response = await run(step)
      outcomes.push(outcome(response))
      crossed.push(step.op === 'import' ? plan : transfer(step, dir, response))
    }
    return { outcomes, transfers: crossed, notified: [...notified], after: record(dir) }
  } finally {
    vi.useRealTimers()
  }
}

describe('favorite store fixtures', () => {
  it('records each scenario’s responses, transfers, notified units and files', async () => {
    setupFavoriteStore()
    root = mkdtempSync(join(tmpdir(), 'favorite-store-fixtures-'))
    const results: (Scenario & Played)[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(scenario, dir)) })
    }
    writeJsonFixture(OUT, results)
    const imported = results.find((r) => r.name.startsWith('imports with duplicates'))
    expect(imported?.outcomes[0]).toBe('{"success":true,"imported":5,"skipped":5}')
  })
})
