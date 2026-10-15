// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-sync-pending: runs the real
// src/main/sync/sync-pending-store.ts and sync-runtime-state.ts on a userData
// directory built in a temp directory (the startup restore, then changes,
// the delayed writes and the write at quit) and records every file,
// directory and symlink left behind (path → content) after the restore and
// after the steps, so the crate can replay each scenario and compare the
// bytes.
//
// Run: pnpm run generate:sync-pending-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}))

vi.mock('../../src/main/utils/broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}))

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync-pending/tests/fixtures/ts_pending_scenarios.json')

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8), `{ symlink }` for a symlink, or null for a directory. */
type Tree = Record<string, string | { hex: string } | { symlink: string } | null>

type Step =
  | { op: 'notify'; unit: string }
  /** The write delay passes. */
  | { op: 'advance' }
  /** The write of the quit sequence. */
  | { op: 'persistNow' }

interface Scenario {
  name: string
  tree: Tree
  steps: Step[]
}

const PENDING = 'local/sync-pending.json'
const KB = (uid: string): Tree => ({ [`sync/keyboards/${uid}/`]: null })
const notify = (...units: string[]): Step[] => units.map((unit) => ({ op: 'notify', unit }))
const ADVANCE: Step = { op: 'advance' }

const SCENARIOS: Scenario[] = [
  {
    name: 'a new file',
    tree: KB('uid1'),
    steps: [...notify('favorites/macro', 'keyboards/uid1/settings', 'favorites/macro', 'meta/keyboard-names'), ADVANCE],
  },
  {
    name: 'an existing owner and held units',
    tree: {
      ...KB('uid1'),
      [PENDING]: JSON.stringify({ version: 1, owner: 'account-a', units: ['keyboards/uid1/snapshots', 'favorites/macro'], held: { 'account-b': ['favorites/combo', 'keyboards/uid1/settings'] } }),
    },
    steps: [...notify('favorites/combo', 'favorites/macro'), ADVANCE],
  },
  {
    name: 'dropped units',
    tree: {
      ...KB('uid1'),
      'sync/keyboards/file-uid': 'not a directory',
      [PENDING]: '{"version":1,"owner":"\\ud800acct","units":["keyboards/uid1/settings","keyboards/gone/settings","keyboards/file-uid/settings","keyboards","favorites/../x","favorites//macro","",7,null,"a\\\\b",".","favorites/.","favorites/macro","favorites/macro","favorites/\\udc00","日本語/ユニット"],'
        + '"held":{"zeta":["favorites/a"],"10":["favorites/b"],"2":["favorites/c"],"":["favorites/d"],"__proto__":["favorites/e"],"empty":[],"gone":["keyboards/gone/x"],"str":"favorites/f","4294967295":["favorites/g"],"01":["favorites/h"]},"extra":true}',
    },
    steps: [...notify('favorites/new'), ADVANCE],
  },
  {
    name: 'invalid UTF-8 in a unit',
    tree: { [PENDING]: { hex: Buffer.concat([Buffer.from('{"version":1,"owner":null,"units":["favorites/x'), Buffer.from([0xff, 0xe6, 0x97]), Buffer.from('"],"held":{}}')]).toString('hex') } },
    steps: [],
  },
  {
    name: 'a file that cannot be read',
    tree: { 'local/': null, [`${PENDING}`]: { symlink: 'sync-pending.json' } },
    steps: [...notify('favorites/macro'), ADVANCE, { op: 'persistNow' }],
  },
  { name: 'invalid JSON', tree: { [PENDING]: '{"version":1,' }, steps: [...notify('favorites/macro'), ADVANCE] },
  { name: 'another version', tree: { [PENDING]: '{"version":2,"owner":"a","units":["favorites/macro"],"held":{}}' }, steps: [] },
  { name: 'units that are not a list', tree: { [PENDING]: '{"version":1,"owner":"a","units":"favorites/macro","held":{}}' }, steps: [] },
  { name: 'an array', tree: { [PENDING]: '[1,2]' }, steps: [] },
  { name: 'a byte order mark', tree: { [PENDING]: '\uFEFF{"version":1,"owner":"a","units":["favorites/macro"],"held":{}}' }, steps: [] },
  { name: 'an empty file', tree: { [PENDING]: '' }, steps: [] },
  {
    name: 'an owner and held that are not what they should be',
    tree: { [PENDING]: '{"version":1.0,"owner":"","units":["favorites/macro"],"held":["favorites/x"]}' },
    steps: [],
  },
  {
    name: 'the write at quit takes the place of the delayed one',
    tree: {},
    steps: [...notify('favorites/macro'), { op: 'persistNow' }, ...notify('favorites/combo'), { op: 'persistNow' }, ADVANCE],
  },
  {
    name: 'the directory is removed after the restore',
    tree: {},
    steps: [...notify('favorites/macro')],
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

async function play(scenario: Scenario, dir: string): Promise<unknown> {
  vi.resetModules()
  const runtime = await import('../../src/main/sync/sync-runtime-state')
  const store = await import('../../src/main/sync/sync-pending-store')
  userData = dir
  build(dir, scenario.tree)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    store.restorePendingFromDisk()
    vi.advanceTimersByTime(store.PENDING_WRITE_DELAY_MS)
    const restored = record(dir)
    if (scenario.name === 'the directory is removed after the restore') rmSync(join(dir, 'local'), { recursive: true })
    const units = new Set<string>()
    for (const step of scenario.steps) {
      if (step.op === 'notify') {
        runtime.markPending(step.unit)
        units.add(step.unit)
      } else if (step.op === 'advance') {
        vi.advanceTimersByTime(store.PENDING_WRITE_DELAY_MS)
      } else {
        runtime.persistPendingNow()
      }
    }
    const pendingAtEnd = runtime.hasPendingChanges()
    const generations = [...runtime.snapshotPendingGenerations()]
    // What a write due at the end would add.
    vi.advanceTimersByTime(store.PENDING_WRITE_DELAY_MS)
    return { restored, hasPending: pendingAtEnd, generations, after: record(dir) }
  } finally {
    warn.mockRestore()
    store.resetPendingStoreForTests()
    runtime.resetSyncRuntimeForTests()
    vi.useRealTimers()
  }
}

describe('sync pending fixtures', () => {
  it('records each scenario’s files after the restore and after its steps', async () => {
    root = mkdtempSync(join(tmpdir(), 'sync-pending-fixtures-'))
    const results: unknown[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, ...(await play(scenario, dir)) })
    }
    writeJsonFixture(OUT, results)
    // The unreadable file is left as it was.
    const unreadable = results[SCENARIOS.findIndex((s) => s.name === 'a file that cannot be read')] as { after: Tree }
    expect(unreadable.after[PENDING]).toEqual({ symlink: 'sync-pending.json' })
  })
})
