// SPDX-License-Identifier: GPL-2.0-or-later
// Times both sync engines on one synthetic userData against the Node fake
// Drive (machines.ts) and logs the numbers as JSON; nothing here passes
// or fails on them. Skipped unless PIPETTE_SYNC_MEASURE=1.
//
// The userData: 5 favorite stores of 10 entries, 28 keyboards (one with
// settings only, the rest with settings and two 20 KB snapshots) and 100
// typing days of this machine on a keyboard of its own: 60 units and 100
// days. Each engine:
//   - uploads everything to an empty Drive (with the password-check and
//     the sync-format marker);
//   - downloads everything into an empty machine that has the 28 keyboards
//     (the typing days' keyboard is not on it, so its days stay on Drive);
//   - downloads, just started, one keyboard whose only unit another
//     machine changed (the password-check opened again, no revision
//     known);
//   - seals 16 envelopes at once (one key derivation each, 4 at a time).
// The Electron code runs under Node in this process, so its peak memory
// is the test process's; the Rust engine's is the peer process's
// (`VmHWM`). Set PIPETTE_SYNC_PEER to a release build of the peer for
// the numbers of the shipped engine.
//
// Run: PIPETTE_SYNC_MEASURE=1 PIPETTE_SYNC_MEASURE_OUT=<file> pnpm run
// test:sync-interop measure (the file gets the JSON too)

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { FIXED_NOW, seedUserData, writeTree, type Tree } from '../sync-fixtures/harness'
import {
  caught,
  fakeDrive,
  newRustMachine,
  onElectron,
  onRust,
  patchSettingsElectron,
  patchSettingsRust,
  resetMachines,
  startElectron,
  startMachines,
  stopMachines,
  tempDir,
  tick,
} from './machines'
import { scopeRowId } from '../../src/main/typing-analytics/jsonl/jsonl-row'
import { encrypt } from '../../src/main/sync/sync-crypto'
import { executeSync } from '../../src/main/sync/sync-execute'
import { setPasswordAndValidate } from '../../src/main/sync/sync-password'

const PASSWORD = 'measure-password'
const FAVORITE_TYPES = ['macro', 'tapDance', 'combo', 'keyOverride', 'altRepeatKey']
const KEYBOARDS = Array.from({ length: 28 }, (_, i) => `kb${String(i).padStart(2, '0')}`)
const DAYS = Array.from({ length: 100 }, (_, i) => new Date(FIXED_NOW - (i + 1) * 86_400_000).toISOString().slice(0, 10))
const AT = new Date(FIXED_NOW - 86_400_000).toISOString()
const clocks = { created: AT, body: AT, name: AT, hub: AT }
const json = (value: unknown): string => JSON.stringify(value, null, 2)

const hashOf = (machineId: string, installationId: string): string =>
  createHash('sha256').update(machineId).update(installationId).digest('hex')

/** A typing day of `hash`: its scope row and 150 more rows like it. */
function dayText(hash: string): string {
  const scopeId = `${hash}|linux|kbDays`
  const row = JSON.stringify({
    id: scopeRowId(scopeId), kind: 'scope', updated_at: 1_000,
    payload: {
      id: scopeId, machineHash: hash, osPlatform: 'linux', osRelease: '6.8.0', osArch: 'x64',
      keyboardUid: 'kbDays', keyboardVendorId: 1, keyboardProductId: 2, keyboardProductName: 'Pipette',
    },
  })
  return `${Array.from({ length: 151 }, () => row).join('\n')}\n`
}

/** The synthetic userData of a machine whose hash is `hash`. */
function dataset(hash: string): Tree {
  const tree: Tree = {}
  for (const ty of FAVORITE_TYPES) {
    const ids = Array.from({ length: 10 }, (_, i) => `${ty}-${i}`)
    tree[`sync/favorites/${ty}/index.json`] = json({
      type: ty,
      entries: ids.map((id) => ({ id, label: `Fav ${id}`, filename: `${ty}_${id}.json`, savedAt: AT, updatedAt: AT, clocks })),
    })
    for (const id of ids) tree[`sync/favorites/${ty}/${ty}_${id}.json`] = JSON.stringify({ id, keys: 'x'.repeat(2000) })
  }
  for (const [i, uid] of KEYBOARDS.entries()) {
    tree[`sync/keyboards/${uid}/pipette_settings.json`] = JSON.stringify({ _rev: 1, keyboardLayout: 'qwerty', autoAdvance: true, layerNames: [], _updatedAt: AT })
    if (i === 0) continue
    const snaps = ['s1', 's2'].map((id) => ({ id, label: `Snap ${id}`, filename: `KB_t_${id}.pipette`, savedAt: AT, vilVersion: 2, updatedAt: AT, clocks }))
    tree[`sync/keyboards/${uid}/snapshots/index.json`] = json({ uid, entries: snaps })
    for (const snap of snaps) tree[`sync/keyboards/${uid}/snapshots/${snap.filename}`] = JSON.stringify({ layout: 'k'.repeat(20_000) })
  }
  for (const day of DAYS) tree[`sync/keyboards/kbDays/devices/${hash}/${day}.jsonl`] = dayText(hash)
  return tree
}

/** An empty machine with the keyboards connected. */
const withKeyboards = (installationId: string): Tree => ({
  'local/installation-id': installationId,
  ...Object.fromEntries(KEYBOARDS.map((uid) => [`sync/keyboards/${uid}/`, null])),
})

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now()
  const value = await work()
  return { value, ms: Math.round(performance.now() - started) }
}

const MEASURE = process.env.PIPETTE_SYNC_MEASURE === '1'

describe.skipIf(!MEASURE)('sync performance', () => {
  beforeAll(startMachines)
  afterAll(stopMachines)
  afterEach(resetMachines)

  it('times the upload, the downloads and the key derivations of both engines', async () => {
    const rssBefore = process.resourceUsage().maxRSS
    const drive = fakeDrive()

    // The Electron code.
    const upMachine = seedUserData(dataset(hashOf('perf-1', '00000000-0000-4000-8000-00000000f1f0')))
    startElectron(upMachine, 'perf-1', ['kbDays'])
    expect(await caught(() => setPasswordAndValidate(PASSWORD))).toBeUndefined()
    const tsUpload = await timed(() => executeSync('upload', 'all'))
    expect(tsUpload.value).toEqual({ status: 'completed' })
    const uploaded = drive.state.files.length
    const downMachine = tempDir('ts-down')
    writeTree(downMachine, withKeyboards('00000000-0000-4000-8000-00000000f2f0'))
    startElectron(downMachine, 'perf-2')
    expect(await caught(() => setPasswordAndValidate(PASSWORD))).toBeUndefined()
    const tsDownload = await timed(() => executeSync('download', 'all'))
    expect(tsDownload.value).toEqual({ status: 'completed' })
    tick()
    onElectron(upMachine, 'perf-1', ['kbDays'])
    await patchSettingsElectron('kb00', { autoAdvance: false })
    expect(await executeSync('upload', { keyboard: 'kb00' })).toEqual({ status: 'completed' })
    // As a machine that just started, as each run of the Rust peer is:
    // the password-check is opened again and no revision is known.
    startElectron(downMachine, 'perf-2')
    const tsOneUnit = await timed(() => executeSync('download', { keyboard: 'kb00' }))
    expect(tsOneUnit.value).toEqual({ status: 'completed' })
    const tsKeys = await timed(() => Promise.all(Array.from({ length: 16 }, (_, i) => encrypt('{}', 'pw', `unit-${i}`))))
    const tsRssKb = process.resourceUsage().maxRSS

    // The Rust engine, on an empty Drive again.
    drive.state.reset()
    const installation = '00000000-0000-4000-8000-00000000f3f0'
    const up = newRustMachine('perf-3', installation, dataset(hashOf('perf-3', installation)))
    expect(await onRust(up, { op: 'setPassword', password: PASSWORD })).toMatchObject({ success: true })
    const rustUpload = await timed(() => onRust(up, { op: 'execute', direction: 'upload', scope: 'all' }))
    expect(rustUpload.value).toMatchObject({ status: 'completed' })
    expect(drive.state.files.length).toBe(uploaded)
    const down = newRustMachine('perf-4', '00000000-0000-4000-8000-00000000f4f0', withKeyboards('00000000-0000-4000-8000-00000000f4f0'))
    expect(await onRust(down, { op: 'setPassword', password: PASSWORD })).toMatchObject({ success: true })
    const rustDownload = await timed(() => onRust(down, { op: 'execute', direction: 'download', scope: 'all' }))
    expect(rustDownload.value).toMatchObject({ status: 'completed' })
    tick()
    await patchSettingsRust(up, 'kb00', { autoAdvance: false })
    expect(await onRust(up, { op: 'execute', direction: 'upload', scope: { keyboard: 'kb00' } })).toMatchObject({ status: 'completed' })
    const rustOneUnit = await timed(() => onRust(down, { op: 'execute', direction: 'download', scope: { keyboard: 'kb00' } }))
    expect(rustOneUnit.value).toMatchObject({ status: 'completed' })
    const rustKeys = await timed(() => onRust(down, { op: 'deriveKeys', count: 16 }))
    expect(rustKeys.value).toMatchObject({ success: true })

    const row = (name: string, ts: number, rust: { ms: number; value: { elapsedMs: number } }) =>
      ({ name, electronMs: ts, rustMs: rust.value.elapsedMs, rustWithStartMs: rust.ms, ratio: +(rust.value.elapsedMs / ts).toFixed(2) })
    const report = JSON.stringify({
      peer: process.env.PIPETTE_SYNC_PEER ?? 'debug build',
      driveFiles: uploaded,
      rows: [
        row('upload everything', tsUpload.ms, rustUpload),
        row('download everything', tsDownload.ms, rustDownload),
        row('download one changed unit', tsOneUnit.ms, rustOneUnit),
        row('16 key derivations', tsKeys.ms, rustKeys),
      ],
      electronMaxRssKb: { atStart: rssBefore, atEnd: tsRssKb },
      rustMaxRssKb: {
        upload: rustUpload.value.maxRssKb,
        download: rustDownload.value.maxRssKb,
        keys: rustKeys.value.maxRssKb,
      },
    }, null, 2)
    if (process.env.PIPETTE_SYNC_MEASURE_OUT) writeFileSync(process.env.PIPETTE_SYNC_MEASURE_OUT, `${report}\n`)
    console.log(report)
  })
})
