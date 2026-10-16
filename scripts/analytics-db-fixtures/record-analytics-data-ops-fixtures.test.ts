// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the data operations of
// src-tauri/crates/pipette-typing-analytics (data_ops.rs and the modules it
// documents) that do not depend on the time zone: Delete All and Reset
// Keyboard Data with their failures, the delete of another device's data,
// the export and the import, the cache rebuild at startup, the apply of this
// device's own deleted ranges and the typing-view heatmap of the minute
// being recorded. data-ops-harness.ts runs the scenarios; the deletes of
// local days are recorded per time zone by tz-data-ops.test.ts.
//
// Run: pnpm run generate:analytics-db-fixtures

import { describe, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('electron', async () => {
  const { pinned } = await import('./data-ops-pinned')
  return { app: { getPath: () => pinned.userData } }
})
vi.mock('../../src/main/logger', async () => {
  const { pinned } = await import('./data-ops-pinned')
  return { log: (level: string, message: string) => pinned.logs.push(`${level}: ${message}`) }
})
vi.mock('../../src/main/sync/sync-flush', async () => {
  const { pinned } = await import('./data-ops-pinned')
  return { notifyChange: (unit: string) => pinned.units.push(unit) }
})
vi.mock('../../src/main/typing-analytics/app-monitor', () => ({ getCurrentAppName: async () => null }))
vi.mock('../../src/main/typing-analytics/machine-hash', async () => {
  const { pinned } = await import('./data-ops-pinned')
  return { getMachineHash: async () => pinned.ownHash }
})
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, platform: () => 'linux', release: () => '6.8.0-golden', arch: () => 'x64' }
})
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  const { pinned } = await import('./data-ops-pinned')
  return {
    ...actual,
    randomUUID: () => {
      const id = pinned.ids.shift()
      if (!id) throw new Error('out of ids')
      return id
    },
  }
})
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const { pinned } = await import('./data-ops-pinned')
  return {
    ...actual,
    unlink: async (path: string) => {
      if (pinned.unlinkFailures.has(path)) {
        throw Object.assign(new Error(`EACCES: permission denied, unlink '${path}'`), { code: 'EACCES' })
      }
      return actual.unlink(path)
    },
  }
})

import { writeJsonFixture } from '../fixture-files'
import type { Tree } from '../keyboard-store-fixtures/fixture-tree'
import {
  FRESH_SYNC_STATE,
  IDS,
  INSTALLATION_ID,
  MACHINE_ID,
  OS,
  OTHER_REMOTE_HASH,
  OWN_HASH,
  REMOTE_HASH,
  dayPath,
  rangesFile,
  rangesPath,
  runScenarios,
  seedDays,
  type Scenario,
} from './data-ops-harness'
import { ANALYTICS_FIXTURES_DIR } from './paths'

const UID = '0xAABB'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** 2026-10-15 10:00 UTC. */
const T0 = Date.UTC(2026, 9, 15, 10, 0)
const KB = { uid: UID, vendorId: 0xfeed, productId: 0, productName: 'Pipette Keyboard' }
const STATE = 'local/typing-analytics/sync_state.json'
const OWN_DIR = `sync/keyboards/${UID}/devices/${OWN_HASH}`

function times(from: number, count: number, step: number): number[] {
  return Array.from({ length: count }, (_, i) => from + i * step)
}

/** This device's and another device's data on the two days before T0. */
function twoDevices(): Tree {
  return {
    [STATE]: FRESH_SYNC_STATE,
    ...seedDays(UID, OWN_HASH, times(T0 - 2 * DAY, 6, 8 * HOUR), { sessions: true }),
    ...seedDays(UID, REMOTE_HASH, times(T0 - 2 * DAY + 30 * MINUTE, 6, 8 * HOUR), { sessions: true }),
  }
}

function char(ts: number, key: string): { op: 'event'; payload: unknown } {
  return { op: 'event', payload: { kind: 'char', key, ts, keyboard: KB } }
}

function press(ts: number, row: number, col: number): { op: 'event'; payload: unknown } {
  return { op: 'event', payload: { kind: 'matrix', row, col, layer: 0, keycode: 4, ts, keyboard: KB, action: 'tap' } }
}

const DAY_1 = '2026-10-13'
const DAY_2 = '2026-10-14'

const DELETE_ALL: Scenario = {
  name: 'delete all of the local tab',
  start: T0,
  tree: twoDevices(),
  steps: [
    { op: 'rebuild' },
    char(T0 + 100, 'a'),
    press(T0 + 200, 0, 1),
    { op: 'deleteAll', uid: UID, scope: 'own' },
    { op: 'advance', ms: 61_000 },
    char(T0 + 62_000, 'b'),
    press(T0 + 62_500, 0, 2),
    { op: 'heatmap', uid: UID, layer: 0, since: T0 - 3 * DAY },
    { op: 'flush', uid: UID },
    { op: 'heatmap', uid: UID, layer: 0, since: T0 - 3 * DAY },
    { op: 'deleteAll', uid: UID, scope: 'own' },
  ],
}

const UNREADABLE_RANGES: Scenario = {
  name: 'delete all with an unreadable ranges file',
  start: T0,
  tree: { ...twoDevices(), [rangesPath(UID, OWN_HASH)]: '{not json' },
  steps: [
    { op: 'rebuild' },
    char(T0 + 100, 'a'),
    { op: 'deleteAll', uid: UID, scope: 'own' },
    { op: 'flush', uid: UID },
  ],
}

const UNLINK_FAILS: Scenario = {
  name: 'delete all leaves a day file it cannot remove',
  start: T0,
  tree: twoDevices(),
  steps: [
    { op: 'rebuild' },
    { op: 'failUnlink', path: dayPath(UID, OWN_HASH, DAY_1) },
    { op: 'deleteAll', uid: UID, scope: 'own' },
    { op: 'applyOwnRanges' },
    { op: 'applyOwnRanges' },
  ],
}

const RECORD_FAILS: Scenario = {
  name: 'delete all whose applied record cannot be written',
  start: T0,
  tree: { ...twoDevices(), [`${OWN_DIR}/deleted-ranges-applied.json/`]: null },
  steps: [
    { op: 'rebuild' },
    { op: 'deleteAll', uid: UID, scope: 'own' },
  ],
}

const RESET: Scenario = {
  name: 'reset keyboard data',
  start: T0,
  tree: twoDevices(),
  steps: [
    { op: 'rebuild' },
    char(T0 + 100, 'a'),
    { op: 'deleteAll', uid: UID, scope: 'all' },
    { op: 'deleteAll', uid: '0xNONE', scope: 'own' },
    { op: 'quit' },
  ],
}

const DEVICE_DELETE: Scenario = {
  name: 'delete another device',
  start: T0,
  tree: {
    ...twoDevices(),
    ...seedDays(UID, OTHER_REMOTE_HASH, times(T0 - DAY, 2, 4 * HOUR)),
    [rangesPath(UID, OTHER_REMOTE_HASH)]: '[]',
  },
  steps: [
    { op: 'rebuild' },
    { op: 'deleteDevice', uid: UID, hash: REMOTE_HASH, dates: 'all' },
    { op: 'deleteDevice', uid: UID, hash: OWN_HASH, dates: 'all' },
    { op: 'deleteDevice', uid: UID, hash: OTHER_REMOTE_HASH, dates: 'all' },
    { op: 'deleteDevice', uid: UID, hash: REMOTE_HASH, dates: [] },
    { op: 'advance', ms: HOUR },
    { op: 'deleteDevice', uid: UID, hash: REMOTE_HASH, dates: 'all' },
    { op: 'rebuild' },
  ],
}

function exportName(hash: string, day: string): string {
  return `keyboards_${UID}_devices_${hash}_days_${day}.jsonl`
}

const D1 = '2026-10-12'
const D2 = '2026-10-13'
const D3 = '2026-10-14'
const TODAY = '2026-10-15'
/** This device's days D1–D3 and the other device's, with a delete mark in
 *  this device's D2 file and a deleted range of this device inside D3. */
function importTree(): Tree {
  const own = seedDays(UID, OWN_HASH, times(Date.UTC(2026, 9, 12, 6), 6, 12 * HOUR), { sessions: true })
  const d2 = dayPath(UID, OWN_HASH, D2)
  const mark = JSON.stringify({
    id: 'ms|mark', kind: 'minute-stats', updated_at: 5_000, is_deleted: true,
    payload: { scopeId: `${OWN_HASH}|${UID}`, minuteTs: Date.UTC(2026, 9, 13, 6), keystrokes: 1, activeMs: 1,
      intervalAvgMs: null, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null,
      intervalMaxMs: null },
  })
  own[d2] = `${String(own[d2])}${mark}\n`
  return {
    [STATE]: FRESH_SYNC_STATE,
    ...own,
    ...seedDays(UID, REMOTE_HASH, times(Date.UTC(2026, 9, 12, 7), 6, 12 * HOUR)),
    [rangesPath(UID, OWN_HASH)]: rangesFile([
      ['r-d3', Date.UTC(2026, 9, 14, 0), Date.UTC(2026, 9, 14, 12), Date.UTC(2026, 9, 14, 23)],
    ]),
    // Exports edited by the user: more keystrokes, one more minute.
    [`incoming/${exportName(OWN_HASH, D1)}`]:
      Object.values(seedDays(UID, OWN_HASH, times(Date.UTC(2026, 9, 12, 6), 3, 4 * HOUR), { updatedAt: 9_000 }))[0],
    [`incoming2/${exportName(OWN_HASH, D1)}`]: 'x',
    [`incoming/${exportName(OWN_HASH, D2)}`]:
      Object.values(seedDays(UID, OWN_HASH, [Date.UTC(2026, 9, 13, 6)], { updatedAt: 9_000 }))[0],
    [`incoming/${exportName(OWN_HASH, D3)}`]:
      Object.values(seedDays(UID, OWN_HASH, times(Date.UTC(2026, 9, 14, 6), 3, 4 * HOUR), { updatedAt: 9_000 }))[0],
    [`incoming/${exportName(OWN_HASH, TODAY)}`]: 'x',
    [`incoming/${exportName(OWN_HASH, '2026-10-01')}`]: 'x',
    [`incoming/${exportName(REMOTE_HASH, D1)}`]: '',
    [`incoming/${exportName(REMOTE_HASH, D2)}`]:
      Object.values(seedDays(UID, REMOTE_HASH, [Date.UTC(2026, 9, 14, 7)]))[0],
    [`incoming/${exportName(REMOTE_HASH, D3)}/`]: null,
    'incoming/notes.txt': 'x',
    [`incoming/remote-ok/${exportName(REMOTE_HASH, D1)}`]:
      Object.values(seedDays(UID, REMOTE_HASH, [Date.UTC(2026, 9, 12, 9)], { updatedAt: 9_000 }))[0],
  }
}

const EXPORT_IMPORT: Scenario = {
  name: 'export and import',
  start: T0,
  tree: importTree(),
  steps: [
    { op: 'rebuild' },
    { op: 'export', uid: UID, dates: [D1, D2, '2026-10-01'], dir: 'exports/out' },
    { op: 'export', uid: UID, dates: [], dir: 'exports/none' },
    {
      op: 'import',
      files: [
        'incoming/notes.txt',
        `incoming/${exportName(OWN_HASH, TODAY)}`,
        `incoming/${exportName(OWN_HASH, D1)}`,
        `incoming2/${exportName(OWN_HASH, D1)}`,
        `incoming/${exportName(OWN_HASH, '2026-10-01')}`,
        `incoming/${exportName(REMOTE_HASH, D1)}`,
        `incoming/${exportName(REMOTE_HASH, D2)}`,
        `incoming/${exportName(REMOTE_HASH, D3)}`,
        `incoming/${exportName(OWN_HASH, D2)}`,
        `incoming/${exportName(OWN_HASH, D3)}`,
      ],
    },
    { op: 'import', files: [`incoming/${exportName(OWN_HASH, D2)}`] },
  ],
}

const IMPORT_UNREADABLE_RANGES: Scenario = {
  name: 'import with an unreadable ranges file',
  start: T0,
  tree: { ...importTree(), [rangesPath(UID, OWN_HASH)]: '{not json' },
  steps: [
    { op: 'rebuild' },
    { op: 'import', files: [`incoming/${exportName(OWN_HASH, D1)}`] },
    { op: 'import', files: [`incoming/${exportName(OWN_HASH, D3)}`, `incoming/remote-ok/${exportName(REMOTE_HASH, D1)}`] },
  ],
}

/** A launch on data of the Electron build without a usable sync state. */
function startupTree(): Tree {
  const own = seedDays(UID, OWN_HASH, times(T0 - 2 * DAY, 6, 8 * HOUR), { sessions: true })
  const d2 = dayPath(UID, OWN_HASH, DAY_2)
  own[d2] = `${String(own[d2])}{"id":"cut short","kind":"minu`
  return {
    ...own,
    ...seedDays(UID, REMOTE_HASH, times(T0 - 2 * DAY + 30 * MINUTE, 6, 8 * HOUR), { sessions: true }),
    [rangesPath(UID, REMOTE_HASH)]: rangesFile([['remote-1', T0 - 2 * DAY, T0 - DAY, T0 - DAY]]),
    ...seedDays(UID, OTHER_REMOTE_HASH, times(T0 - DAY, 2, 4 * HOUR)),
    [rangesPath(UID, OTHER_REMOTE_HASH)]: '{not json',
    [dayPath('0xCCDD', REMOTE_HASH, DAY_1)]: '',
    [rangesPath(UID, OWN_HASH)]: rangesFile([
      ['own-applied', T0 - 2 * DAY, T0 - DAY, T0],
      ['own-pending', T0 - DAY, T0 - DAY + 10 * HOUR, T0 - DAY + 9 * HOUR],
    ]),
    [`${OWN_DIR}/deleted-ranges-applied.json`]: '["own-applied"]',
    [rangesPath('0xCCDD', OWN_HASH)]: '{not json',
    [STATE]: '{"_rev":3,"my_device_id":"another device","uploaded":{},"reconciled_at":{},"last_synced_at":1}',
  }
}

const STARTUP: Scenario = {
  name: 'startup on data that needs a rebuild',
  start: T0,
  tree: startupTree(),
  steps: [
    { op: 'ensureFresh' },
    { op: 'applyOwnRanges' },
    { op: 'ensureFresh' },
    { op: 'applyOwnRanges' },
  ],
}

const HEATMAP: Scenario = {
  name: 'heatmap with the minute being recorded',
  start: T0,
  tree: { [STATE]: FRESH_SYNC_STATE },
  steps: [
    press(T0 + 1_000, 0, 1),
    press(T0 + 2_000, 0, 1),
    press(T0 + 3_000, 1, 1),
    { op: 'advance', ms: 61_000 },
    press(T0 + 62_000, 0, 1),
    press(T0 + 62_500, 2, 2),
    { op: 'advance', ms: 1_000 },
    { op: 'heatmap', uid: UID, layer: 0, since: T0 },
    { op: 'heatmap', uid: UID, layer: 0, since: T0 + 61_000 },
    { op: 'heatmap', uid: UID, layer: 1, since: T0 },
    { op: 'heatmap', uid: '0xNONE', layer: 0, since: T0 },
  ],
}

const SCENARIOS = [
  DELETE_ALL,
  UNREADABLE_RANGES,
  UNLINK_FAILS,
  RECORD_FAILS,
  RESET,
  DEVICE_DELETE,
  EXPORT_IMPORT,
  IMPORT_UNREADABLE_RANGES,
  STARTUP,
  HEATMAP,
]

describe('data operation fixtures', () => {
  it('records the data operation scenarios', async () => {
    writeJsonFixture(join(ANALYTICS_FIXTURES_DIR, 'data_ops.json'), {
      machineId: MACHINE_ID,
      installationId: INSTALLATION_ID,
      ownHash: OWN_HASH,
      os: OS,
      ids: IDS,
      scenarios: await runScenarios(SCENARIOS),
    })
  })
})
