// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-keyboard-stores: runs the
// real KEYBOARD_META_NAME_IF_MISSING and LIST_STORED_KEYBOARDS handlers of
// src/main/sync/sync-ipc.ts, and upsertKeyboardMeta of
// src/main/sync/keyboard-meta.ts, on a userData directory built in a temp
// directory, at fixed times. It records each step's response (or that it
// threw), the sync units reported to notifyChange, and every file,
// directory and symlink left behind (path → content), so the crate can
// replay each scenario and compare the bytes.
//
// The handlers' other dependencies are stubbed: every export of those
// modules is a function resolving to undefined.
//
// Run: pnpm run generate:keyboard-store-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const { handlers, notified, paths, stub } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const notified: string[] = []
  const paths = { userData: '' }
  /** A module whose exports are `extra`, and a function resolving to
   *  undefined for any other name. */
  function stub(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const resolved = (): Promise<undefined> => Promise.resolve(undefined)
    return new Proxy(extra, {
      has: () => true,
      get: (target, key) => {
        if (typeof key === 'symbol' || key === 'then') return undefined
        return key in target ? target[key] : resolved
      },
    })
  }
  return { handlers, notified, paths, stub }
})

vi.mock('electron', () => ({
  app: { getPath: () => paths.userData },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: {},
}))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
  secureOn: () => {},
}))
vi.mock('../../src/main/sync/sync-service', () => stub({ notifyChange: (unit: string) => notified.push(unit) }))
vi.mock('../../src/main/app-config', () => stub())
vi.mock('../../src/main/utils/broadcast', () => stub())
vi.mock('../../src/main/sync/sync-crypto', () => stub())
vi.mock('../../src/main/sync/google-auth', () => stub())
vi.mock('../../src/main/sync/google-drive', () => stub())
vi.mock('../../src/main/sync/sync-reset-ipc', () => stub())
vi.mock('../../src/main/sync/local-data-import', () => stub())
vi.mock('../../src/main/typing-analytics/import-export', () => stub())
vi.mock('../../src/main/typing-analytics/machine-hash', () => stub())
vi.mock('../../src/main/typing-analytics/deleted-ranges-apply', () => stub())
vi.mock('../../src/main/typing-analytics/cache-rebuild', () => stub())
vi.mock('../../src/main/typing-analytics/db/typing-analytics-db', () => stub())
vi.mock('../../src/main/typing-analytics/typing-analytics-service', () => stub())

import { setupSyncIpc } from '../../src/main/sync/sync-ipc'
import { upsertKeyboardMeta } from '../../src/main/sync/keyboard-meta'
import { IpcChannels } from '../../src/shared/ipc/channels'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-keyboard-stores/tests/fixtures/ts_keyboard_store_scenarios.json')

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8), `{ symlink }` for a symlink, or null for a directory. Built in
 *  key order. */
type Tree = Record<string, string | { hex: string } | { symlink: string } | null>

type Step =
  /** KEYBOARD_META_NAME_IF_MISSING with these arguments. */
  | { op: 'nameIfMissing'; uid: unknown; name: unknown }
  /** LIST_STORED_KEYBOARDS. */
  | { op: 'list' }
  /** upsertKeyboardMeta, as a snapshot save calls it. */
  | { op: 'upsert'; uid: string; name: string }
  /** The clock moves to this time. */
  | { op: 'at'; time: string }

interface Scenario {
  name: string
  time: string
  tree: Tree
  steps: Step[]
}

/** A step's response as JSON text (null for undefined), or that it threw. */
type Outcome = { out: string | null } | { throws: true }

const T0 = '2026-10-16T12:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const t = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const META = 'sync/meta/keyboard-names.json'
const KB = 'sync/keyboards'

const meta = (entries: unknown[]): string => JSON.stringify({ type: 'keyboard-meta', version: 1, entries }, null, 2)
const snapshots = (entries: unknown[]): string => JSON.stringify({ uid: 'x', entries }, null, 2)
const snapshot = (filename: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'id', label: '', filename, savedAt: T0, updatedAt: T0, ...extra,
})
const name = (uid: unknown, value: unknown): Step => ({ op: 'nameIfMissing', uid, name: value })
const LIST: Step = { op: 'list' }

const SCENARIOS: Scenario[] = [
  {
    name: 'keyboards named on connect',
    time: T0,
    tree: {},
    steps: [
      name('0xA1', '  GPK60-63R  '),
      name('0xA1', 'Other name'),
      { op: 'at', time: t(60_000) },
      name('0xB2', '日本語キーボード 😀'),
      name('0xC3', 'Ctrl\u0001\nName\t'),
      name('0xD4', 'K'.repeat(60) + 'é'.repeat(40) + '🎹'.repeat(10)),
      name('0xE5', '﻿　Wide '),
      // Ignored.
      name('bad uid', 'x'),
      name('../x', 'x'),
      name('é', 'x'),
      name('', 'x'),
      name('0xF6', '   '),
      name('0xF6', ''),
      name(5, 'x'),
      name('0xF6', 7),
      name('0xF6', null),
      name(null, null),
    ],
  },
  {
    name: 'an active entry is left as it is, old tombstones included',
    time: T0,
    tree: {
      [META]: meta([
        { uid: '0xA', deviceName: 'User Renamed', updatedAt: t(-10 * DAY) },
        { uid: '0xC', deviceName: 'C', updatedAt: t(-31 * DAY), deletedAt: t(-31 * DAY) },
      ]),
    },
    steps: [name('0xA', 'Firmware A')],
  },
  {
    name: 'a tombstone revived on connect; expired tombstones dropped, invalid deletedAt kept',
    time: T0,
    tree: {
      [META]: '{\n  "type": "keyboard-meta",\n  "comment": "unknown",\n  "version": 1,\n  "entries": [\n'
        + [
          `{"uid":"0xA","deviceName":"User Renamed","updatedAt":"${t(-10 * DAY)}","note":"keep me"}`,
          `{"extra":[1,2.50,1e21],"uid":"0xB","deviceName":"Old B","deletedAt":"${t(-DAY)}","updatedAt":"${t(-DAY)}"}`,
          `{"uid":"0xC","deviceName":"C","updatedAt":"${t(-31 * DAY)}","deletedAt":"${t(-31 * DAY)}"}`,
          `{"uid":"0xD","deviceName":"D","updatedAt":"${t(-30 * DAY)}","deletedAt":"${t(-30 * DAY)}"}`,
          `{"uid":"0xE","deviceName":"E","updatedAt":"${t(-30 * DAY + 1)}","deletedAt":"${t(-30 * DAY + 1)}"}`,
          `{"uid":"0xF","deviceName":"F","updatedAt":"x","deletedAt":"not a date"}`,
          `{"uid":"0xG","deviceName":"G","updatedAt":"x","deletedAt":${Date.parse(T0) - 40 * DAY}}`,
          `{"uid":"0xH","deviceName":"H","updatedAt":"x","deletedAt":true}`,
          `{"uid":"0xI","deviceName":"Empty deletedAt","updatedAt":"x","deletedAt":""}`,
          `{"uid":"0xJ","deviceName":"J","updatedAt":"x","deletedAt":["2020-01-01"]}`,
          `{"uid":"0xK","deviceName":"K","updatedAt":"x","deletedAt":{}}`,
          `{"uid":"0xL","deviceName":"L","updatedAt":"x","deletedAt":"${t(DAY)}"}`,
          `{"uid":"0xM","deviceName":"\\ud800 lone","updatedAt":"x","deletedAt":"${t(-60 * DAY)}"}`,
          `{"uid":"0xN","deviceName":"\\udc00 kept","updatedAt":"x","deletedAt":0}`,
          `{"deviceName":"no uid"}`,
          `"a string entry"`,
          `42`,
          `[]`,
          `{"uid":7,"deviceName":"numeric uid"}`,
        ].map((line) => `    ${line}`).join(',\n')
        + '\n  ],\n  "after": 1.0\n}\n',
    },
    steps: [
      name('0xA', 'Firmware A'),
      name('0xB', ' Firmware B '),
      name('0xI', 'Not used'),
      name('7', 'Seven'),
    ],
  },
  {
    name: 'upserts',
    time: T0,
    tree: {
      [META]: meta([
        { uid: '0xA', deviceName: 'Name', updatedAt: t(-DAY) },
        { deviceName: 'B', uid: '0xB', deletedAt: t(-DAY), updatedAt: t(-DAY) },
        { uid: '0xC', deviceName: 'C', deletedAt: t(-40 * DAY), updatedAt: t(-40 * DAY) },
        { uid: '0xD' },
      ]),
    },
    steps: [
      { op: 'upsert', uid: '0xA', name: 'Name' },
      { op: 'upsert', uid: '0xA', name: '\tName ' },
      { op: 'at', time: t(60_000) },
      { op: 'upsert', uid: '0xA', name: 'New Name' },
      { op: 'upsert', uid: '0xB', name: 'B' },
      { op: 'upsert', uid: '0xD', name: 'D' },
      { op: 'upsert', uid: '0xN', name: 'N' },
      { op: 'upsert', uid: '', name: 'x' },
      { op: 'upsert', uid: '0xQ', name: '　' },
    ],
  },
  {
    name: 'stored keyboards: names filled from snapshots, in byte order',
    time: T0,
    tree: {
      [META]: meta([
        { uid: '0xA', deviceName: 'First A', updatedAt: t(-DAY) },
        { uid: '0x10', deviceName: '0x10', updatedAt: t(-DAY) },
        { uid: '_x', deviceName: 'Gone X', updatedAt: t(-DAY), deletedAt: t(-DAY) },
        { uid: 'kb-8', deviceName: 5, updatedAt: t(-DAY) },
        { uid: 'kb-13', deviceName: '', updatedAt: t(-DAY) },
        { uid: '0xA', deviceName: 'Meta A', updatedAt: t(-DAY) },
        { uid: 'kb-old', deviceName: 'Old', updatedAt: t(-50 * DAY), deletedAt: t(-50 * DAY) },
      ]),
      [`${KB}/zz-last/`]: null,
      [`${KB}/0xb/snapshots/index.json`]: snapshots([
        snapshot('Deleted_2026-01-01T00-00-00.000Z_id.pipette', { deletedAt: T0 }),
        snapshot('Board b_2026-01-02T00-00-00.000Z_id.pipette'),
      ]),
      [`${KB}/0xA/snapshots/index.json`]: snapshots([snapshot('Snap A_2026-01-02T00-00-00.000Z_id.pipette')]),
      [`${KB}/0x10/snapshots/index.json`]: snapshots([snapshot('Snap 10_2026-01-02T00-00-00.000Z_id.pipette')]),
      [`${KB}/_x/snapshots/index.json`]: snapshots([snapshot('Revived X_2026-01-02T00-00-00.000Z_id.pipette')]),
      [`${KB}/kb-2/snapshots/index.json`]: snapshots([snapshot('All deleted_2026-01-02T00-00-00.000Z.pipette', { deletedAt: T0 })]),
      [`${KB}/kb-3/snapshots/index.json`]: snapshots([snapshot('no-date.pipette')]),
      [`${KB}/kb-4/snapshots/index.json`]: '{"entries":[',
      [`${KB}/kb-5/snapshots/index.json`]: snapshots([null, snapshot('After null_2026-01-02T00-00-00.000Z.pipette')]),
      [`${KB}/kb-6/snapshots/index.json`]: snapshots([snapshot('  Spaced  _2026-01-02T00-00-00.000Z.pipette')]),
      [`${KB}/kb-7/snapshots/index.json`]: '{"entries":[{"filename":"Lone \\ud800_2026-01-02T00-00-00.000Z.pipette"}]}',
      [`${KB}/kb-8/`]: null,
      [`${KB}/kb-9/snapshots/index.json`]: snapshots([snapshot(`${'鍵盤'.repeat(20)}🎹_2026-01-02T00-00-00.000Z.pipette`)]),
      [`${KB}/kb-10/snapshots/index.json`]: '{"entries":{"0":{"filename":"Object_2026-01-02T00-00-00.000Z.pipette"}}}',
      [`${KB}/kb-11/snapshots/index.json`]: snapshots([snapshot(20260102)]),
      [`${KB}/kb-12/snapshots/index.json`]: snapshots(['a string', snapshot('After string_2026-01-02T00-00-00.000Z.pipette')]),
      [`${KB}/kb-13/snapshots/index.json`]: snapshots([snapshot('Filled 13_2026-01-02T00-00-00.000Z.pipette')]),
      [`${KB}/kb-14/snapshots/index.json`]: { hex: Buffer.concat([Buffer.from('{"entries":[{"filename":"Bad '), Buffer.from([0xff]), Buffer.from('_2026-01-02T00-00-00.000Z.pipette"}]}')]).toString('hex') },
      [`${KB}/kb-15/snapshots/index.json`]: snapshots([{ filename: 'Ctrl\u0001\nName_2026-01-02T00-00-00.000Z.pipette' }]),
      [`${KB}/kb-16/snapshots/index.json`]: snapshots([{ filename: 'Ctrl\u0001Name_2026-01-02T00-00-00.000Z.pipette' }]),
      [`${KB}/bad.uid/`]: null,
      [`${KB}/é/`]: null,
      [`${KB}/a-file`]: 'not a directory',
      [`${KB}/link`]: { symlink: 'zz-last' },
      [`${KB}/0xB/`]: null,
      [`${KB}/-1/`]: null,
    },
    steps: [LIST, { op: 'at', time: t(60_000) }, LIST],
  },
  {
    name: 'stored keyboards with every name in the index',
    time: T0,
    tree: {
      [META]: meta([{ uid: 'kb', deviceName: 'Named', updatedAt: t(-DAY) }]),
      [`${KB}/kb/snapshots/index.json`]: snapshots([snapshot('Snapshot name_2026-01-02T00-00-00.000Z.pipette')]),
      [`${KB}/none/`]: null,
    },
    steps: [LIST],
  },
  { name: 'no keyboards directory', time: T0, tree: {}, steps: [LIST] },
  { name: 'a keyboards path that is a file', time: T0, tree: { [`${KB}`]: 'file' }, steps: [LIST] },
  {
    name: 'a names file that is not JSON',
    time: T0,
    tree: { [META]: '{"type":"keyboard-meta","entries":[' },
    steps: [name('0xA', 'A')],
  },
  {
    name: 'a names file of another type',
    time: T0,
    tree: { [META]: '{"type":"keyboard-metas","version":1,"entries":[{"uid":"0xZ","deviceName":"Z","updatedAt":"x"}]}' },
    steps: [name('0xA', 'A')],
  },
  {
    name: 'a names file whose entries are not a list',
    time: T0,
    tree: { [META]: '{"type":"keyboard-meta","version":1,"entries":{"0":{"uid":"0xA"}}}' },
    steps: [name('0xA', 'A')],
  },
  {
    name: 'a names file with a byte order mark',
    time: T0,
    tree: { [META]: '﻿{"type":"keyboard-meta","version":1,"entries":[]}' },
    steps: [name('0xA', 'A')],
  },
  {
    name: 'a names file that is an array',
    time: T0,
    tree: { [META]: '[{"type":"keyboard-meta","entries":[]}]' },
    steps: [name('0xA', 'A')],
  },
  {
    name: 'invalid UTF-8 in the names file',
    time: T0,
    tree: {
      [META]: { hex: Buffer.concat([Buffer.from('{"type":"keyboard-meta","version":1,"entries":[{"uid":"0xZ","deviceName":"Bad '), Buffer.from([0xff, 0xe6, 0x97]), Buffer.from('","updatedAt":"x"}]}')]).toString('hex') },
    },
    steps: [name('0xA', 'A')],
  },
  {
    name: 'a null entry',
    time: T0,
    tree: {
      [META]: meta([{ uid: '0xZ', deviceName: 'Z', updatedAt: t(-DAY) }, null]),
      [`${KB}/0xZ/`]: null,
    },
    steps: [name('0xZ', 'Other'), name('0xA', 'A'), { op: 'upsert', uid: '0xZ', name: 'New Z' }, LIST],
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
    if (typeof content === 'string') writeFileSync(target, content)
    else if ('hex' in content) writeFileSync(target, Buffer.from(content.hex, 'hex'))
    else symlinkSync(content.symlink, target)
  }
}

/** Every file, symlink and directory (`path/` → null) under `dir`. */
function record(dir: string, prefix = ''): Tree {
  const tree: Tree = {}
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      tree[`${prefix}${name}`] = { symlink: readlinkSync(path) }
    } else if (stat.isDirectory()) {
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

async function outcome(run: () => unknown): Promise<Outcome> {
  try {
    return { out: JSON.stringify(await run()) ?? null }
  } catch {
    return { throws: true }
  }
}

function handler(channel: string): (...args: unknown[]) => unknown {
  const found = handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found
}

interface Played {
  outcomes: Outcome[]
  notified: string[]
  after: Tree
}

async function play(scenario: Scenario, dir: string): Promise<Played> {
  paths.userData = dir
  notified.length = 0
  build(dir, scenario.tree)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(scenario.time))
  try {
    const outcomes: Outcome[] = []
    for (const step of scenario.steps) {
      if (step.op === 'at') {
        vi.setSystemTime(new Date(step.time))
        outcomes.push({ out: null })
      } else if (step.op === 'list') {
        outcomes.push(await outcome(() => handler(IpcChannels.LIST_STORED_KEYBOARDS)({})))
      } else if (step.op === 'upsert') {
        outcomes.push(await outcome(() => upsertKeyboardMeta(step.uid, step.name)))
      } else {
        outcomes.push(await outcome(() => handler(IpcChannels.KEYBOARD_META_NAME_IF_MISSING)({}, step.uid, step.name)))
      }
    }
    return { outcomes, notified: [...notified], after: record(dir) }
  } finally {
    vi.useRealTimers()
  }
}

describe('keyboard store fixtures', () => {
  it('records each scenario’s responses, notified units and files', async () => {
    setupSyncIpc()
    root = mkdtempSync(join(tmpdir(), 'keyboard-store-fixtures-'))
    const results: (Scenario & Played)[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(scenario, dir)) })
    }
    writeJsonFixture(OUT, results)
    // A list that records names reports the unit once.
    const listed = results.find((r) => r.name.startsWith('stored keyboards: names filled'))
    expect(listed?.notified).toEqual(['meta/keyboard-names'])
  })
})
