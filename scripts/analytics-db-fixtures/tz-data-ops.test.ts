// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the data operations of
// src-tauri/crates/pipette-typing-analytics that read local calendar days,
// in the zone this process runs in (run-time-zones.ts): the Local tab's
// delete of local days (day_delete.rs) and the Sync tab's delete of another
// device's days (device_delete.rs), on days around the daylight saving
// changes, with what is being recorded at the time of the delete.
// data-ops-harness.ts runs the scenario; tests/fixtures/data_ops_local_days/
// <zone>.json gets what it left.
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
import {
  FRESH_SYNC_STATE,
  IDS,
  INSTALLATION_ID,
  MACHINE_ID,
  OS,
  OWN_HASH,
  REMOTE_HASH,
  dayPath,
  runScenarios,
  seedDays,
  type Scenario,
} from './data-ops-harness'
import { ANALYTICS_FIXTURES_DIR } from './paths'
import { recordingTimeZone, zoneSlug } from './time-zones'

const UID = '0xAABB'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const KB = { uid: UID, vendorId: 0xfeed, productId: 0, productName: 'Pipette Keyboard' }

/** Every 150 minutes from `from` for `hours` hours. */
function times(from: number, hours: number): number[] {
  return Array.from({ length: Math.floor((hours * HOUR) / (150 * MINUTE)) }, (_, i) => from + i * 150 * MINUTE)
}

/** 2026-11-01 12:00 UTC, inside the local day 2026-11-01 in every recorded
 *  zone. */
const NOW = Date.UTC(2026, 10, 1, 12, 0)

function seeds(hash: string, offset: number): ReturnType<typeof seedDays> {
  return {
    ...seedDays(UID, hash, times(Date.UTC(2026, 2, 6, 12) + offset, 96), { sessions: true }),
    ...seedDays(UID, hash, times(Date.UTC(2026, 9, 31, 12) + offset, 36), { sessions: true }),
  }
}

/** This device's and another device's days, and a delete mark of this
 *  device inside the deleted days whose cache step never ran. */
function tree(): ReturnType<typeof seedDays> {
  const own = seeds(OWN_HASH, 0)
  const day = dayPath(UID, OWN_HASH, '2026-03-08')
  const minuteTs = Date.UTC(2026, 2, 8, 12)
  own[day] = `${String(own[day])}${JSON.stringify({
    id: `ms|${minuteTs}`, kind: 'minute-stats', updated_at: 1_500, is_deleted: true,
    payload: { scopeId: `${OWN_HASH}|${UID}`, minuteTs, keystrokes: 1, activeMs: 1, intervalAvgMs: null,
      intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null },
  })}\n`
  return { 'local/typing-analytics/sync_state.json': FRESH_SYNC_STATE, ...own, ...seeds(REMOTE_HASH, 45 * MINUTE) }
}

const LOCAL_DAYS: Scenario = {
  name: 'delete local days',
  start: NOW,
  tree: tree(),
  steps: [
    { op: 'rebuild' },
    { op: 'event', payload: { kind: 'char', key: 'a', ts: NOW + 100, keyboard: KB } },
    { op: 'deleteDays', uid: UID, dates: ['2026-03-08', '2026-03-09'] },
    { op: 'deleteDays', uid: UID, dates: ['2026-03-09', '2026-03-08'] },
    { op: 'deleteDays', uid: UID, dates: ['2026-11-01'] },
    { op: 'deleteDays', uid: UID, dates: ['2026-11-02', 'not a day'] },
    { op: 'deleteDevice', uid: UID, hash: REMOTE_HASH, dates: ['2026-03-08'] },
    { op: 'deleteDevice', uid: UID, hash: REMOTE_HASH, dates: ['2026-03-10', '2026-03-07', '2026-11-01'] },
    { op: 'advance', ms: 2 * MINUTE },
    { op: 'event', payload: { kind: 'char', key: 'b', ts: NOW + 2 * MINUTE, keyboard: KB } },
    { op: 'flush', uid: UID },
    { op: 'rebuild' },
  ],
}

describe('data operation local-day fixtures', () => {
  it('records the deletes of local days in this time zone', async () => {
    const timeZone = recordingTimeZone()
    writeJsonFixture(join(ANALYTICS_FIXTURES_DIR, 'data_ops_local_days', `${zoneSlug(timeZone)}.json`), {
      timeZone,
      machineId: MACHINE_ID,
      installationId: INSTALLATION_ID,
      ownHash: OWN_HASH,
      os: OS,
      ids: IDS,
      scenarios: await runScenarios([LOCAL_DAYS], { compact: true }),
    })
  })
})
