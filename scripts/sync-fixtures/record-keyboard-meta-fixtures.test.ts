// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the keyboard-name tombstones and backfill of
// src-tauri/crates/pipette-keyboard-stores (keyboard_meta.rs) and
// src-tauri/crates/pipette-sync (meta_backfill.rs): seeds a userData tree,
// runs `tombstoneKeyboardMeta`, `tombstoneAllKeyboardMeta` and
// `backfillKeyboardMeta` of src/main/sync/keyboard-meta.ts on it step by
// step, and records each step's outcome (or error), the windows it
// notified and the tree after it.
//
// For the backfill, Drive is a stub listing the scenario's files: the
// downloaded envelope of a file is its plaintext, a file marked `wrong`
// does not decrypt, and a file without plaintext fails to download. The
// Rust replay encrypts the plaintexts for real.
//
// Run: pnpm run generate:sync-fixtures

import { describe, it, expect, vi } from 'vitest'
import { resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { FIXED_INSTALLATION_ID, FIXED_NOW, readTree, seedUserData, type Tree } from './harness'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_keyboard_meta.json')

/** A Drive file of a backfill: its plaintext, or `wrong` (another
 *  password), or nothing (the download fails). */
interface RemoteFile {
  id: string
  name: string
  modifiedTime: string
  plaintext?: string
  wrong?: true
}

const remote = new Map<string, RemoteFile>()
const events: Array<[string, unknown]> = []
const downloads: string[] = []

vi.mock('../../src/main/sync/google-drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sync/google-drive')>()
  return {
    ...actual,
    downloadFile: vi.fn(async (id: string) => {
      downloads.push(id)
      const file = remote.get(id)
      if (file?.plaintext === undefined) throw new Error(`Drive download failed: 404`)
      return { ciphertext: file.plaintext, wrong: file.wrong ?? false }
    }),
  }
})
vi.mock('../../src/main/sync/sync-crypto', () => ({
  decrypt: vi.fn(async (envelope: { ciphertext: string; wrong: boolean }) => {
    if (envelope.wrong) throw new Error('Unsupported state or unable to authenticate data')
    return envelope.ciphertext
  }),
}))
vi.mock('../../src/main/utils/broadcast', () => ({
  broadcastToAllWindows: vi.fn((channel: string, payload?: unknown) => { events.push([channel, payload ?? null]) }),
}))

import { backfillKeyboardMeta, tombstoneAllKeyboardMeta, tombstoneKeyboardMeta } from '../../src/main/sync/keyboard-meta'
import type { DriveFile } from '../../src/main/sync/google-drive'

// ---- Inputs ----

const DAY = 86_400_000
const D = (n: number): string => new Date(FIXED_NOW - n * DAY).toISOString()
const META = 'sync/meta/keyboard-names.json'
const meta = (entries: unknown[]): string => JSON.stringify({ type: 'keyboard-meta', version: 1, entries }, null, 2)
const json = (value: unknown): string => JSON.stringify(value, null, 2)

type Step =
  | { tombstone: string }
  | { tombstoneAll: true }
  | { backfill: RemoteFile[] }

interface Scenario {
  name: string
  tree: Tree
  steps: Step[]
}

const snapIndex = (uid: string, entries: unknown[]): string => json({ uid, entries })
const snapEntry = (filename: unknown, over: Record<string, unknown> = {}) => ({ id: 's', label: '', filename, savedAt: D(3), ...over })
const snapBundle = (entries: unknown): string => JSON.stringify({ type: 'layout', key: 'x', index: { entries }, files: {} })
const driveFile = (id: string, uid: string, over: Partial<RemoteFile> = {}): RemoteFile =>
  ({ id, name: `keyboards_${uid}_snapshots.enc`, modifiedTime: '2026-10-01T00:00:00.000Z', ...over })

const SCENARIOS: Scenario[] = [
  {
    name: 'tombstones one keyboard, once',
    tree: { [META]: meta([{ uid: '0xA', deviceName: 'A', updatedAt: D(2) }, { uid: '0xB', deviceName: 'B', updatedAt: D(2) }]) },
    steps: [{ tombstone: '0xA' }, { tombstone: '0xA' }, { tombstone: '' }],
  },
  {
    name: 'a keyboard with no name gets a tombstone, and the expired ones go',
    tree: {
      [META]: meta([
        { uid: '0xOld', deviceName: 'Old', updatedAt: D(40), deletedAt: D(40), extra: 1 },
        { uid: '0xA', note: 'kept', deviceName: 'A', updatedAt: D(2) },
      ]),
    },
    steps: [{ tombstone: '0xNew' }],
  },
  {
    name: 'without a names file',
    tree: {},
    steps: [{ tombstone: '0xA' }, { tombstoneAll: true }],
  },
  {
    name: 'tombstones every active keyboard and counts them',
    tree: {
      [META]: meta([
        { uid: '0xA', deviceName: 'A', updatedAt: D(2) },
        { uid: '0xB', deviceName: 'B', updatedAt: D(2), deletedAt: D(1) },
        { uid: '0xOld', deviceName: 'Old', updatedAt: D(31), deletedAt: D(31) },
        { uid: '0xC', deviceName: '', updatedAt: D(2), deletedAt: '' },
      ]),
    },
    steps: [{ tombstoneAll: true }, { tombstoneAll: true }],
  },
  {
    name: 'nothing to tombstone leaves an expired tombstone',
    tree: { [META]: meta([{ uid: '0xOld', deviceName: 'Old', updatedAt: D(31), deletedAt: D(31) }]) },
    steps: [{ tombstoneAll: true }],
  },
  {
    name: 'a null entry fails the tombstones',
    tree: { [META]: meta([{ uid: '0xA', deviceName: 'A', updatedAt: D(2) }, null]) },
    steps: [{ tombstone: '0xZ' }, { tombstoneAll: true }],
  },
  {
    name: 'an entry that is not an object fails the tombstone of all',
    tree: { [META]: meta([5]) },
    steps: [{ tombstoneAll: true }, { tombstone: '0xZ' }],
  },
  {
    name: 'a names file that is not an index is replaced',
    tree: { [META]: '{"type":"other","entries":[]}' },
    steps: [{ tombstone: '0xA' }],
  },
  {
    name: 'backfills names from local snapshots, then from Drive',
    tree: {
      [META]: meta([
        { uid: '0xKnown', deviceName: 'Known', updatedAt: D(2) },
        { uid: '0xGone', deviceName: '', updatedAt: D(2), deletedAt: D(2) },
        { uid: '0xStale', deviceName: 'Stale', updatedAt: D(2) },
      ]),
      'sync/keyboards/0xLocal/snapshots/index.json': snapIndex('0xLocal', [snapEntry('Old Board_2026-01-01T00-00-00.000Z.pipette', { deletedAt: D(1) }), snapEntry('Local Board_2026-04-16T10-00-00.000Z.pipette')]),
      'sync/keyboards/0xEmpty/snapshots/index.json': snapIndex('0xEmpty', []),
      'sync/keyboards/0xBad/snapshots/index.json': '{not json',
    },
    steps: [{
      backfill: [
        driveFile('k', '0xKnown', { plaintext: snapBundle([snapEntry('X_2026-01-01.pipette')]) }),
        driveFile('g', '0xGone', { plaintext: snapBundle([snapEntry('X_2026-01-01.pipette')]) }),
        driveFile('l', '0xLocal', { plaintext: snapBundle([snapEntry('Remote_2026-01-01.pipette')]) }),
        driveFile('e', '0xEmpty', { plaintext: snapBundle([snapEntry('  Spaced Board  _2026-02-02.pipette')]) }),
        driveFile('b', '0xBad', { plaintext: snapBundle([snapEntry('Bad Local_2026-02-02.pipette')]) }),
        driveFile('r-old', '0xRemote', { modifiedTime: '2026-09-01T00:00:00.000Z', plaintext: snapBundle([snapEntry('Older_2026-01-01.pipette')]) }),
        driveFile('r-new', '0xRemote', { modifiedTime: '2026-10-02T00:00:00.000Z', plaintext: snapBundle([snapEntry('Newest_2026-01-01.pipette')]) }),
        driveFile('w', '0xWrong', { plaintext: snapBundle([snapEntry('W_2026-01-01.pipette')]), wrong: true }),
        driveFile('m', '0xMissing'),
        driveFile('n', '0xNoName', { plaintext: snapBundle([snapEntry('no-date.pipette')]) }),
        driveFile('nul', '0xNull', { plaintext: 'null' }),
        driveFile('t', '0xText', { plaintext: 'not json' }),
        driveFile('z', '0xNullEntry', { plaintext: snapBundle([null, snapEntry('Z_2026-01-01.pipette')]) }),
        driveFile('d', '0xDeleted', { plaintext: snapBundle([snapEntry('D_2026-01-01.pipette', { deletedAt: D(1) })]) }),
        { id: 'tr', name: 'keyboards_0xTrash_snapshots.enc.trash.1.2.tr', modifiedTime: '2026-10-01T00:00:00.000Z', plaintext: snapBundle([snapEntry('T_2026-01-01.pipette')]) },
        { id: 'o', name: 'keyboards_0xOther_settings.enc', modifiedTime: '2026-10-01T00:00:00.000Z', plaintext: '{}' },
      ],
    }],
  },
  {
    name: 'a backfill that names nothing writes and notifies nothing',
    tree: { [META]: meta([{ uid: '0xA', deviceName: 'A', updatedAt: D(2) }]) },
    steps: [{ backfill: [] }, { backfill: [driveFile('a', '0xA', { plaintext: snapBundle([]) }), driveFile('m', '0xMissing')] }],
  },
  {
    name: 'a backfilled name revives nothing and keeps the order of Drive',
    tree: {},
    steps: [{
      backfill: [
        driveFile('2', '0xB', { plaintext: snapBundle([snapEntry('B_2026-01-01.pipette')]) }),
        driveFile('1', '0xA', { plaintext: snapBundle([snapEntry('A_2026-01-01.pipette')]) }),
      ],
    }, { tombstone: '0xA' }, {
      backfill: [driveFile('1', '0xA', { plaintext: snapBundle([snapEntry('A again_2026-01-01.pipette')]) })],
    }],
  },
]

// ---- Recording ----

async function outcome(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    return { value: (await run()) ?? null }
  } catch (err) {
    return { error: err instanceof TypeError ? 'TypeError' : 'Error' }
  }
}

async function runStep(step: Step): Promise<Record<string, unknown>> {
  if ('tombstone' in step) return outcome(() => tombstoneKeyboardMeta(step.tombstone))
  if ('tombstoneAll' in step) return outcome(() => tombstoneAllKeyboardMeta())
  remote.clear()
  for (const file of step.backfill) remote.set(file.id, file)
  const files = step.backfill.map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime })) as DriveFile[]
  return outcome(() => backfillKeyboardMeta('pw', files))
}

async function record(scenario: Scenario) {
  const userData = seedUserData(scenario.tree)
  const steps = []
  for (const step of scenario.steps) {
    events.length = 0
    downloads.length = 0
    const result = await runStep(step)
    steps.push({ step, result, events: [...events], downloads: [...downloads].sort(), tree: readTree(userData) })
  }
  return { name: scenario.name, tree: { 'local/installation-id': FIXED_INSTALLATION_ID, ...scenario.tree }, now: FIXED_NOW, steps }
}

describe('keyboard meta fixtures', () => {
  it('records every scenario', async () => {
    const scenarios = []
    for (const scenario of SCENARIOS) scenarios.push(await record(scenario))
    expect(scenarios.length).toBe(SCENARIOS.length)
    writeJsonFixture(OUT, scenarios)
  })
})
