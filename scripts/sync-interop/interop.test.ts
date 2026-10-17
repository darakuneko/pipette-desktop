// SPDX-License-Identifier: GPL-2.0-or-later
// Interoperability of the two sync engines on one Drive (machines.ts):
// machine 1 runs the Electron main process's sync code, machine 2 the Rust
// engine of src-tauri/crates/pipette-sync over HTTP; both are signed in to
// the same account with the same sync password, each with a userData and a
// machine hash of its own.
//
// Scenarios:
//   - both save and sync in turn, edits to one unit from both included:
//     both `sync/` trees end with the same values, nothing left pending.
//     A first download into machine 2 writes the bytes the Electron code
//     writes on an empty machine of its own; the trees of the two machines
//     are compared as values because a merge writes an entry's keys in
//     its own order while a store writes them in another. Then the
//     Electron code syncs a copy of the userData the Rust engine synced,
//     with a download and an upload pass, and changes nothing in it, on
//     Drive neither;
//   - a password change stopped half way (by failed uploads) on one
//     machine stops the sync of both until it is resumed; the other then
//     re-enters the new password and both converge — once with each
//     engine running the change;
//   - both create the same unit at once: two copies of one name on Drive;
//     the next syncs converge on the chosen copy and the Rust polling pass
//     moves the other copy to the trash;
//   - a sync-format marker newer than both: every pass and the password
//     change of both stop, and Drive and both trees are left as they were.
//
// Run: pnpm run test:sync-interop (after building the peer: cargo build
// -p pipette-sync --example sync_peer, from src-tauri).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cpSync } from 'node:fs'
import { readTree, seedUserData, writeTree } from '../sync-fixtures/harness'
import {
  caught,
  clearFaults,
  driveFiles,
  fakeDrive,
  newRustMachine,
  onBeforeCreate,
  onElectron,
  onRust,
  patchSettingsElectron,
  patchSettingsRust,
  resetMachines,
  rustPending,
  saveFavoriteElectron,
  saveFavoriteRust,
  startElectron,
  startMachines,
  stopMachines,
  syncTree,
  syncValues,
  tempDir,
  tick,
  type PeerAnswer,
  type RustMachine,
} from './machines'
import { SYNC_FORMAT_VERSION } from '../../src/shared/constants/sync-format'
import { executeSync } from '../../src/main/sync/sync-execute'
import { hasPendingChanges } from '../../src/main/sync/sync-runtime-state'
import { replacePasswordAndValidate, setPasswordAndValidate } from '../../src/main/sync/sync-password'
import { getPasswordChangeStatus, resumePasswordChange, startPasswordChange } from '../../src/main/sync/sync-password-change'

const PC1_MACHINE = 'interop-machine-1'
const PC2_MACHINE = 'interop-machine-2'
const PC2_INSTALLATION_ID = '00000000-0000-4000-8000-00000000f2f0'
const LOCK = 'password-change-lock.json'

interface Machines {
  pc1: string
  pc2: RustMachine
}

const pc2 = (m: Machines, command: Record<string, unknown>): Promise<PeerAnswer> => onRust(m.pc2, command)
const onPc1 = (m: Machines): void => onElectron(m.pc1, PC1_MACHINE)
const hasLock = (): boolean => fakeDrive().state.files.some((f) => f.name === LOCK)

/** Both machines with the sync password set and the same favorite and
 *  keyboard settings, all synced. */
async function syncedPair(password: string): Promise<Machines> {
  const m = { pc1: seedUserData(), pc2: newRustMachine(PC2_MACHINE, PC2_INSTALLATION_ID) }
  startElectron(m.pc1, PC1_MACHINE)
  expect(await caught(() => setPasswordAndValidate(password))).toBeUndefined()
  await saveFavoriteElectron('macro', 'base')
  await patchSettingsElectron('kbI', { layerNames: ['Base'] })
  expect(await executeSync('upload', 'all')).toEqual({ status: 'completed' })
  tick()
  expect(await pc2(m, { op: 'setPassword', password })).toMatchObject({ success: true })
  // The keyboard is connected to machine 2 too, so its units are synced
  // there (a keyboard never used on a machine is left on Drive).
  expect(await pc2(m, { op: 'ensureKeyboard', uid: 'kbI' })).toMatchObject({ success: true })
  expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject({ status: 'completed' })

  const mirror = tempDir('mirror')
  writeTree(mirror, { 'local/installation-id': PC2_INSTALLATION_ID, 'sync/keyboards/kbI/': null })
  startElectron(mirror, 'interop-machine-3')
  expect(await caught(() => setPasswordAndValidate(password))).toBeUndefined()
  expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })
  expect(syncTree(m.pc2.dir)).toEqual(syncTree(mirror))
  startElectron(m.pc1, PC1_MACHINE)
  expect(syncValues(m.pc2.dir)).toEqual(syncValues(m.pc1))
  tick()
  return m
}

describe('the Electron and the Rust sync engines on one Drive', () => {
  beforeAll(startMachines)
  afterAll(stopMachines)
  afterEach(resetMachines)

  it('converges when both save and sync in turn, and the Electron code syncs what the Rust engine synced as it is', async () => {
    const m = await syncedPair('interop-password')

    // Machine 2 adds to a unit machine 1 created, starts a store of its
    // own and changes the shared keyboard's settings.
    await saveFavoriteRust(m.pc2, 'macro', 'from-2')
    await saveFavoriteRust(m.pc2, 'tapDance', 'td-2')
    await patchSettingsRust(m.pc2, 'kbI', { autoAdvance: false })
    expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject({ status: 'completed' })
    tick()

    // Machine 1 edits the same unit before it has seen machine 2's
    // change: its upload merges first.
    onPc1(m)
    await saveFavoriteElectron('macro', 'from-1')
    expect(await executeSync('upload', 'all')).toEqual({ status: 'completed' })
    expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })
    tick()
    expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject({ status: 'completed' })
    expect(await pc2(m, { op: 'poll' })).toMatchObject({ success: true })

    const tree = syncTree(m.pc1)
    expect(syncValues(m.pc2.dir)).toEqual(syncValues(m.pc1))
    const macroIndex = JSON.parse(tree['favorites/macro/index.json'] as string) as { entries: Array<{ label: string }> }
    expect(macroIndex.entries.map((e) => e.label).sort()).toEqual(['Fav base', 'Fav from-1', 'Fav from-2'])
    expect(tree['favorites/tapDance/index.json']).toContain('Fav td-2')
    expect(JSON.parse(tree['keyboards/kbI/pipette_settings.json'] as string)).toMatchObject({ layerNames: ['Base'], autoAdvance: false })
    expect(hasPendingChanges()).toBe(false)
    expect(rustPending(m.pc2)).toEqual([])

    // The Electron code on a copy of machine 2's userData, as a machine
    // that just started: it stores the password, then a download and an
    // upload of everything leave the copy and Drive as they were.
    const copy = tempDir('copy')
    cpSync(m.pc2.dir, copy, { recursive: true })
    startElectron(copy, PC2_MACHINE)
    expect(await caught(() => setPasswordAndValidate('interop-password'))).toBeUndefined()
    const before = readTree(copy)
    const driveBefore = driveFiles()
    expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })
    expect(await executeSync('upload', 'all')).toEqual({ status: 'completed' })
    expect(readTree(copy)).toEqual(before)
    expect(driveFiles()).toEqual(driveBefore)
  })

  for (const changer of ['electron', 'rust'] as const) {
    it(`stops both machines while the ${changer} engine's password change is unfinished`, async () => {
      const m = await syncedPair('old-password')
      const changeOnPc1 = changer === 'electron'
      onPc1(m)

      // Every re-encrypting upload fails: the change stops after taking
      // the Drive lock and keeps its state for a resume.
      fakeDrive().state.inject({ status: 400, count: 1000, only: 'update' })
      const started = changeOnPc1
        ? await caught(() => startPasswordChange('new-password'))
        : await pc2(m, { op: 'changePassword', password: 'new-password' })
      clearFaults()
      expect(started).toHaveProperty('error')
      expect(hasLock()).toBe(true)
      const status = changeOnPc1 ? await getPasswordChangeStatus() : await pc2(m, { op: 'changeStatus' })
      expect(status).toMatchObject({ kind: 'inProgress' })

      // Neither machine syncs: the changer for its local state, the other
      // for the lock on Drive. Drive is left as it was.
      tick()
      const driveBefore = driveFiles()
      const local = { status: 'skipped', skipReason: 'blockedLocal' }
      const remote = { status: 'skipped', skipReason: 'blockedByOtherDevice' }
      // Saved a minute apart: entries saved in the same millisecond on two
      // machines keep each machine's own first (entry-merge.ts sorts by
      // updatedAt only), so their order would differ between the machines.
      await saveFavoriteElectron('macro', 'blocked-1')
      tick()
      await saveFavoriteRust(m.pc2, 'macro', 'blocked-2')
      expect(await executeSync('upload', 'all')).toEqual(changeOnPc1 ? local : remote)
      expect(await executeSync('download', 'all')).toEqual(changeOnPc1 ? local : remote)
      expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject(changeOnPc1 ? remote : local)
      expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject(changeOnPc1 ? remote : local)
      expect(await pc2(m, { op: 'poll' })).toMatchObject({ success: true })
      expect(driveFiles()).toEqual(driveBefore)

      // The changer resumes and finishes; the other machine's password no
      // longer opens Drive until it re-enters the new one.
      tick()
      const resumed = changeOnPc1 ? await caught(() => resumePasswordChange()) : await pc2(m, { op: 'resumeChange' })
      expect(resumed).toEqual(changeOnPc1 ? undefined : expect.objectContaining({ success: true }))
      expect(hasLock()).toBe(false)
      tick()
      if (changeOnPc1) {
        expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject({ error: 'sync.passwordMismatch' })
        expect(await pc2(m, { op: 'replacePassword', password: 'new-password' })).toMatchObject({ success: true })
      } else {
        expect(await caught(() => executeSync('upload', 'all'))).toEqual({ error: 'sync.passwordMismatch' })
        expect(await caught(() => replacePasswordAndValidate('new-password'))).toBeUndefined()
      }
      expect(await executeSync('upload', 'all')).toEqual({ status: 'completed' })
      tick()
      expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject({ status: 'completed' })
      expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject({ status: 'completed' })
      tick()
      expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })

      const tree = syncTree(m.pc1)
      expect(syncValues(m.pc2.dir)).toEqual(syncValues(m.pc1))
      expect(tree['favorites/macro/index.json']).toContain('Fav blocked-1')
      expect(tree['favorites/macro/index.json']).toContain('Fav blocked-2')
    })
  }

  it('converges after both create the same unit at once, and the Rust polling moves the extra copy to the trash', async () => {
    const m = await syncedPair('interop-password')
    const name = 'favorites_combo.enc'
    onPc1(m)
    await saveFavoriteElectron('combo', 'c-1')
    tick()
    await saveFavoriteRust(m.pc2, 'combo', 'c-2')

    // Machine 1 lists Drive and is about to create the unit; machine 2
    // lists, finds no copy and creates its own first.
    let peer: Promise<PeerAnswer> | null = null
    onBeforeCreate(async (created) => {
      if (created !== name || peer !== null) return
      peer = pc2(m, { op: 'execute', direction: 'upload', scope: 'favorites' })
      expect(await peer).toMatchObject({ status: 'completed' })
    })
    expect(await executeSync('upload', 'favorites')).toEqual({ status: 'completed' })
    onBeforeCreate(null)
    expect(peer).not.toBeNull()
    expect(fakeDrive().state.files.filter((f) => f.name === name)).toHaveLength(2)

    // The syncs converge on the newest copy; machine 2's own copy is left
    // for the polling pass to move to the trash.
    tick()
    expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject({ status: 'completed' })
    tick()
    expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })
    tick()
    expect(await pc2(m, { op: 'poll' })).toMatchObject({ success: true })
    const copies = fakeDrive().state.files.filter((f) => f.name === name || f.name.startsWith(`${name}.trash.`))
    expect(copies.map((f) => (f.name === name ? 'live' : 'trash')).sort()).toEqual(['live', 'trash'])

    tick()
    expect(await executeSync('download', 'all')).toEqual({ status: 'completed' })
    expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject({ status: 'completed' })
    const tree = syncTree(m.pc1)
    expect(syncValues(m.pc2.dir)).toEqual(syncValues(m.pc1))
    expect(tree['favorites/combo/index.json']).toContain('Fav c-1')
    expect(tree['favorites/combo/index.json']).toContain('Fav c-2')
  })

  it('stops both machines on a sync-format marker newer than both', async () => {
    const m = await syncedPair('interop-password')
    const newer = `sync-format-v${SYNC_FORMAT_VERSION + 1}.json`
    fakeDrive().state.create(newer, Buffer.from(JSON.stringify({ type: 'sync-format', version: SYNC_FORMAT_VERSION + 1 })), 'application/json')
    const driveBefore = driveFiles()
    onPc1(m)
    await saveFavoriteElectron('macro', 'late-1')
    await saveFavoriteRust(m.pc2, 'macro', 'late-2')
    const pc1Before = syncTree(m.pc1)
    const pc2Before = syncTree(m.pc2.dir)

    const blocked = { status: 'skipped', skipReason: 'updateRequired' }
    expect(await executeSync('upload', 'all')).toEqual(blocked)
    expect(await executeSync('download', 'all')).toEqual(blocked)
    expect(await pc2(m, { op: 'execute', direction: 'upload', scope: 'all' })).toMatchObject(blocked)
    expect(await pc2(m, { op: 'execute', direction: 'download', scope: 'all' })).toMatchObject(blocked)
    expect(await pc2(m, { op: 'poll' })).toMatchObject({ success: true })
    expect(await caught(() => startPasswordChange('another-password'))).toEqual({ error: 'sync.updateRequired' })
    expect(await pc2(m, { op: 'changePassword', password: 'another-password' })).toMatchObject({ error: 'sync.updateRequired' })

    expect(driveFiles()).toEqual(driveBefore)
    expect(syncTree(m.pc1)).toEqual(pc1Before)
    expect(syncTree(m.pc2.dir)).toEqual(pc2Before)
  })
})
