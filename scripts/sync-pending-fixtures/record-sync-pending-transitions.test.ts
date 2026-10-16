// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the pending transitions of the upload side and the
// accounts (src-tauri/crates/pipette-sync/tests/ts_pending_transitions.rs):
// runs the real src/main/sync/sync-runtime-state.ts, sync-pending-store.ts
// and sync-pending-account.ts on a userData directory built in a temp
// directory, with the stored sign-in replaced by an account the scenario
// names, and records after each step the pending state (owner, units with
// their generations, held units), the file's text and the statuses told
// to the renderer, so the crate can replay each scenario and compare.
//
// Run: pnpm run generate:sync-pending-fixtures

import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

let userData = ''
/** The `sub` of the stored sign-in, as `getAccountSub` answers it. */
let signedIn: string | null = null
const statuses: boolean[] = []

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}))

vi.mock('../../src/main/utils/broadcast', () => ({
  broadcastToAllWindows: (_channel: string, pending: boolean) => {
    statuses.push(pending)
  },
}))

vi.mock('../../src/main/sync/google-auth', () => ({
  getAccountSub: async () => signedIn,
  signOut: async () => {
    signedIn = null
  },
}))

vi.mock('../../src/main/sync/sync-account-caches', () => ({
  forgetAccountCaches: () => {},
}))

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_pending_transitions.json')

type Step =
  /** `notifyChange`'s part before the upload: mark and tell the renderer. */
  | { op: 'notify'; unit: string }
  /** The write delay passes. */
  | { op: 'advance' }
  /** A pass takes the generations before it uploads. */
  | { op: 'snapshot' }
  /** Settles `unit` with the generation of the last snapshot (0 when it had none). */
  | { op: 'settle'; unit: string }
  | { op: 'broadcast' }
  | { op: 'cancel'; prefixes?: string[]; writeAlways?: boolean }
  | { op: 'copy' }
  | { op: 'restore' }
  /** A pass or the startup hands the units to `sub`, the stored sign-in. */
  | { op: 'adopt'; sub: string | null }
  | { op: 'markPendingFor'; owner: string | null; unit: string }
  /** A sign-in of `sub` while `current` is stored; storing makes `sub` the stored one. */
  | { op: 'signIn'; current: string | null; sub: string | null }
  /** A sign-out while `current` is stored. */
  | { op: 'signOut'; current: string | null }
  /** A non-empty directory in the file's place, so writes fail. */
  | { op: 'blockWrites' }
  | { op: 'unblockWrites' }

interface Scenario {
  name: string
  /** The keyboard directories under sync/keyboards. */
  keyboards: string[]
  /** The pending file at launch; none when null. */
  file: string | null
  steps: Step[]
}

const PENDING = 'local/sync-pending.json'
const file = (owner: string | null, units: string[], held: Record<string, string[]> = {}): string =>
  JSON.stringify({ version: 1, owner, units, held })
const notify = (...units: string[]): Step[] => units.map((unit) => ({ op: 'notify', unit }))
const ADVANCE: Step = { op: 'advance' }

/** The Google `sub` the Electron build ran as. */
const ELECTRON_SUB = '104242424242424242424'

const SCENARIOS: Scenario[] = [
  {
    name: 'a settle removes a unit only at the generation the pass took',
    keyboards: ['uid1'],
    file: null,
    steps: [
      ...notify('favorites/macro', 'keyboards/uid1/settings'),
      ADVANCE,
      { op: 'snapshot' },
      ...notify('favorites/macro'),
      { op: 'settle', unit: 'favorites/macro' },
      { op: 'settle', unit: 'keyboards/uid1/settings' },
      { op: 'settle', unit: 'favorites/never' },
      { op: 'broadcast' },
      ADVANCE,
      { op: 'snapshot' },
      { op: 'settle', unit: 'favorites/macro' },
      { op: 'broadcast' },
      ADVANCE,
    ],
  },
  {
    name: 'cancels of prefixes, held units included, and putting them back',
    keyboards: ['uid1', 'uid2'],
    file: file('account-a', ['keyboards/uid1/settings', 'favorites/macro', 'themes/index'], {
      'account-b': ['keyboards/uid1/snapshots', 'i18n/index'],
      '7': ['keyboards/uid2/settings'],
      'account-c': ['themes/packs/p1'],
    }),
    steps: [
      { op: 'copy' },
      { op: 'cancel', prefixes: ['keyboards/uid1/', 'themes/'] },
      { op: 'cancel', prefixes: [] },
      { op: 'cancel', prefixes: ['nothing/'] },
      { op: 'cancel', prefixes: ['nothing/'], writeAlways: true },
      ...notify('favorites/combo', 'keyboards/uid1/settings'),
      { op: 'restore' },
      { op: 'copy' },
      { op: 'cancel' },
      { op: 'restore' },
      ADVANCE,
    ],
  },
  {
    name: 'a cancel that cannot be written changes nothing',
    keyboards: ['uid1'],
    file: file('account-a', ['keyboards/uid1/settings'], { 'account-b': ['keyboards/uid1/snapshots'] }),
    steps: [
      { op: 'blockWrites' },
      { op: 'cancel', prefixes: ['keyboards/uid1/'] },
      { op: 'cancel', prefixes: ['nothing/'] },
      { op: 'cancel', prefixes: ['nothing/'], writeAlways: true },
      { op: 'unblockWrites' },
      ...notify('keyboards/uid1/settings'),
      ADVANCE,
      { op: 'cancel', prefixes: ['keyboards/uid1/'], writeAlways: true },
    ],
  },
  {
    name: 'units marked after the copy keep their newer generation',
    keyboards: [],
    file: file('account-a', ['favorites/tapDance', 'favorites/macro'], { 'account-b': ['favorites/combo'] }),
    steps: [
      { op: 'copy' },
      { op: 'cancel', prefixes: ['favorites/'], writeAlways: true },
      ...notify('favorites/macro', 'favorites/altRepeatKey'),
      { op: 'markPendingFor', owner: 'account-b', unit: 'favorites/keyOverride' },
      { op: 'restore' },
      ADVANCE,
    ],
  },
  {
    name: 'handing the units to the signed-in account',
    keyboards: [],
    file: file('account-a', ['favorites/tapDance'], { 'account-b': ['favorites/macro'] }),
    steps: [
      { op: 'adopt', sub: null },
      { op: 'adopt', sub: 'account-a' },
      { op: 'adopt', sub: 'account-b' },
      ...notify('favorites/combo'),
      { op: 'adopt', sub: 'account-a' },
      { op: 'adopt', sub: 'account-c' },
      { op: 'adopt', sub: '2' },
      ADVANCE,
    ],
  },
  {
    name: 'marking a unit pending for the account a pass ran as',
    keyboards: [],
    file: file('account-b', [], {}),
    steps: [
      { op: 'markPendingFor', owner: 'account-b', unit: 'favorites/tapDance' },
      { op: 'markPendingFor', owner: null, unit: 'favorites/macro' },
      { op: 'markPendingFor', owner: 'account-b', unit: 'favorites/macro' },
      { op: 'markPendingFor', owner: 'account-a', unit: 'favorites/combo' },
      { op: 'markPendingFor', owner: 'account-a', unit: 'favorites/combo' },
      { op: 'broadcast' },
      ADVANCE,
    ],
  },
  {
    // The pending file the Electron build left, owned by its account, and
    // the Tauri build not signed in: a sign-in of another account holds the
    // units for the Electron account, and that account's sign-in brings
    // them back.
    name: 'the units the Electron build left, then another account and the same account',
    keyboards: ['uid1'],
    file: file(ELECTRON_SUB, ['favorites/macro', 'keyboards/uid1/settings']),
    steps: [
      { op: 'adopt', sub: null },
      ...notify('favorites/combo'),
      { op: 'signIn', current: null, sub: 'tauri-other' },
      ...notify('favorites/tapDance'),
      { op: 'signOut', current: 'tauri-other' },
      { op: 'signIn', current: null, sub: ELECTRON_SUB },
      { op: 'adopt', sub: ELECTRON_SUB },
      ADVANCE,
    ],
  },
  {
    name: 'the units the Electron build left, then the same account',
    keyboards: ['uid1'],
    file: file(ELECTRON_SUB, ['favorites/macro', 'keyboards/uid1/settings'], { 'someone-else': ['favorites/combo'] }),
    steps: [
      { op: 'adopt', sub: null },
      { op: 'signIn', current: null, sub: ELECTRON_SUB },
      { op: 'adopt', sub: ELECTRON_SUB },
      ADVANCE,
    ],
  },
  {
    name: 'signing in and out with units nobody owns',
    keyboards: [],
    file: file(null, ['favorites/macro']),
    steps: [
      { op: 'signIn', current: 'account-a', sub: 'account-b' },
      ...notify('favorites/combo'),
      { op: 'signOut', current: 'account-b' },
      ...notify('favorites/tapDance'),
      { op: 'signOut', current: 'account-a' },
      { op: 'signIn', current: null, sub: 'account-a' },
      { op: 'signIn', current: 'account-a', sub: null },
      { op: 'signOut', current: null },
      ADVANCE,
    ],
  },
  {
    name: 'a hand-over that cannot be written keeps the old account',
    keyboards: [],
    file: file('account-a', ['favorites/macro']),
    steps: [
      { op: 'blockWrites' },
      { op: 'signIn', current: 'account-a', sub: 'account-b' },
      { op: 'signOut', current: 'account-a' },
      { op: 'unblockWrites' },
      { op: 'signIn', current: 'account-a', sub: 'account-b' },
      ADVANCE,
    ],
  },
]

interface Recorded {
  op: Step['op']
  error: boolean
  owner: string | null
  units: [string, number][]
  held: Record<string, string[]>
  /** The file's text; null when missing, `<blocked>` when a directory is in its place. */
  file: string | null
  /** The statuses told to the renderer during the step. */
  statuses: boolean[]
}

let root = ''
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function readPendingFile(dir: string): string | null {
  const path = join(dir, PENDING)
  if (!existsSync(path)) return null
  if (lstatSync(path).isDirectory()) return '<blocked>'
  return readFileSync(path, 'utf-8')
}

async function play(scenario: Scenario, dir: string): Promise<Recorded[]> {
  vi.resetModules()
  const runtime = await import('../../src/main/sync/sync-runtime-state')
  const store = await import('../../src/main/sync/sync-pending-store')
  const account = await import('../../src/main/sync/sync-pending-account')
  userData = dir
  signedIn = null
  statuses.length = 0
  for (const uid of scenario.keyboards) mkdirSync(join(dir, 'sync', 'keyboards', uid), { recursive: true })
  if (scenario.file !== null) {
    mkdirSync(dirname(join(dir, PENDING)), { recursive: true })
    writeFileSync(join(dir, PENDING), scenario.file)
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    store.restorePendingFromDisk()
    vi.advanceTimersByTime(store.PENDING_WRITE_DELAY_MS)
    let generations = new Map<string, number>()
    let copy: ReturnType<typeof runtime.copyPendingState> | null = null
    const recorded: Recorded[] = []
    for (const step of scenario.steps) {
      statuses.length = 0
      let error = false
      try {
        switch (step.op) {
          case 'notify':
            runtime.markPending(step.unit)
            runtime.broadcastPendingStatus()
            break
          case 'advance':
            vi.advanceTimersByTime(store.PENDING_WRITE_DELAY_MS)
            break
          case 'snapshot':
            generations = runtime.snapshotPendingGenerations()
            break
          case 'settle':
            runtime.settlePending(step.unit, generations.get(step.unit) ?? 0)
            break
          case 'broadcast':
            runtime.broadcastPendingStatus()
            break
          case 'cancel':
            runtime.cancelPendingChanges(step.prefixes, { writeAlways: step.writeAlways })
            break
          case 'copy':
            copy = runtime.copyPendingState()
            break
          case 'restore':
            if (!copy) throw new Error('no copy')
            runtime.restoreCancelledPending(copy)
            break
          case 'adopt':
            signedIn = step.sub
            await account.adoptPendingForSignedInAccount()
            break
          case 'markPendingFor':
            account.markPendingFor(step.owner, step.unit)
            break
          case 'signIn': {
            signedIn = step.current
            const sub = step.sub
            await account.switchAccountKeepingPending(async () => {
              signedIn = sub
            }, sub)
            break
          }
          case 'signOut':
            signedIn = step.current
            await account.signOutKeepingPending()
            break
          case 'blockWrites':
            rmSync(join(dir, PENDING), { force: true })
            mkdirSync(join(dir, PENDING, 'blocker'), { recursive: true })
            break
          case 'unblockWrites':
            rmSync(join(dir, PENDING), { recursive: true })
            break
        }
      } catch {
        error = true
      }
      const held: Record<string, string[]> = {}
      for (const [sub, units] of runtime.syncRuntime.heldPending) held[sub] = [...units]
      recorded.push({
        op: step.op,
        error,
        owner: runtime.syncRuntime.pendingOwner,
        units: [...runtime.snapshotPendingGenerations()],
        held,
        file: readPendingFile(dir),
        statuses: [...statuses],
      })
    }
    return recorded
  } finally {
    warn.mockRestore()
    store.resetPendingStoreForTests()
    runtime.resetSyncRuntimeForTests()
    vi.useRealTimers()
  }
}

describe('sync pending transition fixtures', () => {
  it('records the pending state, the file and the statuses after each step', async () => {
    root = mkdtempSync(join(tmpdir(), 'sync-pending-transitions-'))
    const results: (Scenario & { recorded: Recorded[] })[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      results.push({ ...scenario, recorded: await play(scenario, dir) })
    }
    writeJsonFixture(OUT, results)
    // The Electron build's units are held for its account while another
    // account is signed in, and come back with its sign-in.
    const handoff = results[SCENARIOS.findIndex((s) => s.name.startsWith('the units the Electron build left, then another'))]
    const signedInOther = handoff.recorded.find((r) => r.op === 'signIn')
    expect(signedInOther?.held[ELECTRON_SUB]).toEqual(['favorites/macro', 'keyboards/uid1/settings', 'favorites/combo'])
    const back = handoff.recorded.filter((r) => r.op === 'signIn')[1]
    expect(back.owner).toBe(ELECTRON_SUB)
    expect(back.units.map(([unit]) => unit)).toEqual(['favorites/macro', 'keyboards/uid1/settings', 'favorites/combo'])
  })
})
