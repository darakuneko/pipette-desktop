// SPDX-License-Identifier: GPL-2.0-or-later
// The Hub peer comparison of the Analyze post's export: for every saved
// Analyze filter of the source userData (peer.ts), the export Electron's
// `prepareAnalyticsExport` builds on a copy, with the preview values,
// against what the Rust peer (hub_peer) builds on another copy. Both
// caches are rebuilt from the copy's day files for the machine hash of
// this machine and the copy's installation id, as the app derives it.
// Each export must be the same JSON text with the same preview values, or
// the same failure.
//
// The export needs the keymap snapshots of `typing-analytics/keymaps/`,
// which live outside `sync/`; a copy without them answers every saved
// filter with the same failure on both sides.
//
// Without PIPETTE_HUB_PEER_USER_DATA it runs on the tree, seed rows and
// parameters of the export golden (tests/fixtures/ts_hub_analytics_export
// .json). Runs under Electron acting as Node for the real better-sqlite3,
// in UTC on both sides. It prints counts and times only.
//
// Run: pnpm run test:hub-peer

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import nodeMachineId from 'node-machine-id'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { TypingAnalyticsDB, setTypingAnalyticsDBForTests } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { applyRowsToCache } from '../../src/main/typing-analytics/jsonl/apply-to-cache'
import { readRows } from '../../src/main/typing-analytics/jsonl/jsonl-reader'
import { rebuildCacheFromMasterFiles } from '../../src/main/typing-analytics/cache-rebuild'
import { prepareAnalyticsExport } from '../../src/main/hub/hub-ipc-analytics-prepare'
import { estimateAnalyticsExportSizeBytes, validateAnalyticsExport } from '../../src/main/hub/hub-analytics'
import { FIXED_NOW, writeTree } from '../sync-fixtures/harness'
import { hubFixturePath } from '../hub-fixtures/paths'
import { countsOnly, electronCopy, liveEntries, readJson, realSource, storeFile, removePeerDirs, runPeer, rustCopy, trackedTempDir } from './peer'

const { ownHash } = vi.hoisted(() => ({ ownHash: { value: '' } }))

// The machine hash the export reads: the one both caches are rebuilt for.
vi.mock('../../src/main/typing-analytics/machine-hash', () => ({
  getMachineHash: async () => ownHash.value,
  resetMachineHashCacheForTests: () => undefined,
}))

type Params = Record<string, unknown>

interface Golden {
  ownHash: string
  tree: Record<string, string>
  cases: Array<{ params: Params }>
}

const real = realSource()

afterAll(() => {
  const failed = removePeerDirs()
  if (failed > 0) process.stdout.write(`hub peer: ${failed} temporary director(ies) could not be removed\n`)
  expect(failed).toBe(0)
})

/** Saved filters left out because their index names a file outside the
 *  store's directory (`storeFile`); counted, never named. */
let skipped = 0

/** The parameters of a post of every live saved filter of every keyboard
 *  whose file stays inside its store. */
function filterParams(dir: string): Params[] {
  const keyboards = join(dir, 'sync', 'keyboards')
  let uids: string[]
  try {
    uids = readdirSync(keyboards).sort()
  } catch {
    return []
  }
  return uids.flatMap((uid) => {
    const store = `sync/keyboards/${uid}/analyze_filters`
    const safe = liveEntries(readJson(dir, `${store}/index.json`)).filter((entry) => {
      const inside = storeFile(dir, store, entry.filename) !== null
      if (!inside) skipped++
      return inside
    })
    return safe.map((entry) => ({
      uid,
      entryId: entry.id,
      title: 'peer',
      thumbnailBase64: '',
      keyboard: { productName: 'Peer', vendorId: 0, productId: 0 },
      fingerOverrides: {},
      layoutComparisonInputs: null,
    }))
  })
}

/** The machine hash of this machine for the copy's installation id, or
 *  PIPETTE_HUB_PEER_OWN_HASH for a copy from another machine. */
async function machineHashFor(dir: string): Promise<string> {
  const given = process.env.PIPETTE_HUB_PEER_OWN_HASH
  if (given) return given
  const installationId = readFileSync(join(dir, 'local', 'installation-id'), 'utf8').trim()
  const machine = await nodeMachineId.machineId(true)
  return createHash('sha256').update(machine).update(installationId).digest('hex')
}

async function electronExport(params: Params): Promise<Record<string, unknown>> {
  let built: Awaited<ReturnType<typeof prepareAnalyticsExport>>
  try {
    built = await prepareAnalyticsExport(params as unknown as Parameters<typeof prepareAnalyticsExport>[0])
  } catch (err) {
    if (!(err instanceof Error)) throw err
    return { thrown: err.message }
  }
  if (!built.ok) return { failed: { error: built.error, totalKeystrokes: built.totalKeystrokes, rangeMs: built.rangeMs } }
  const { exportData } = built
  return {
    exportJson: JSON.stringify(exportData),
    preview: {
      totalKeystrokes: exportData.snapshot.totalKeystrokes,
      rangeMs: exportData.snapshot.range.toMs - exportData.snapshot.range.fromMs,
      estimatedBytes: estimateAnalyticsExportSizeBytes(exportData),
      validation: validateAnalyticsExport(exportData),
    },
  }
}

describe('the Analyze post export of both builds on a copy of a userData', () => {
  it('builds the same export for every saved filter', () => countsOnly('the Analyze exports', async () => {
    const golden = real === null
      ? (JSON.parse(readFileSync(hubFixturePath('ts_hub_analytics_export.json'), 'utf8')) as Golden)
      : null
    let source: string
    if (golden === null) {
      source = real as string
    } else {
      source = trackedTempDir('pipette-hub-peer-source-')
      writeTree(source, golden.tree)
    }
    const seed = golden === null ? null : hubFixturePath('ts_hub_analytics_export_seed.jsonl')
    const electron = electronCopy(source)
    const rust = rustCopy(source)
    ownHash.value = golden === null ? await machineHashFor(electron) : golden.ownHash
    const params = golden === null ? filterParams(electron) : golden.cases.map((c) => c.params)

    const db = new TypingAnalyticsDB(join(trackedTempDir('pipette-hub-peer-cache-'), 'cache.db'))
    const electronResults: Array<Record<string, unknown>> = []
    let rebuiltMs: number
    let electronMs: number
    try {
      const started = performance.now()
      if (seed !== null) applyRowsToCache(db, (await readRows(seed)).rows)
      else await rebuildCacheFromMasterFiles(db, electron, ownHash.value)
      setTypingAnalyticsDBForTests(db)
      rebuiltMs = performance.now() - started
      const exportStarted = performance.now()
      for (const p of params) electronResults.push(await electronExport(p))
      electronMs = performance.now() - exportStarted
    } finally {
      db.close()
    }

    const peer = await runPeer<{ results: Array<Record<string, unknown>> }>(rust, FIXED_NOW, {
      kind: 'analytics',
      ownHash: ownHash.value,
      ...(seed === null ? {} : { seed }),
      params,
    })
    let same = 0
    let built = 0
    for (const [index, mine] of electronResults.entries()) {
      if ('exportJson' in mine) built++
      if (JSON.stringify(mine) === JSON.stringify(peer.output.results[index])) same++
    }
    process.stdout.write(
      `hub peer Analyze exports: ${same}/${params.length} the same (${built} built, the rest failures); skipped (file outside its store): ${skipped}; ` +
        `Electron rebuild ${Math.round(rebuiltMs)} ms + exports ${Math.round(electronMs)} ms (process max RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB), ` +
        `Rust rebuild and exports ${peer.elapsedMs} ms (max RSS ${Math.round((peer.maxRssKb ?? 0) / 1024)} MB)\n`,
    )
    expect(same).toBe(params.length)
    // The golden builds some exports, so the comparison is not vacuous.
    if (golden !== null) expect(built).toBeGreaterThan(0)
  }))
})
