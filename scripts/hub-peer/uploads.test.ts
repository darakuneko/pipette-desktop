// SPDX-License-Identifier: GPL-2.0-or-later
// The Hub peer comparison of the uploads and of the startup update: the
// Electron Hub handlers on one copy of the source userData (peer.ts) and
// the Rust ones (hub_peer) on another, each against the same scripted Hub
// (nothing is sent anywhere).
//
// - Uploads: every live key label, language pack, theme pack and favorite
//   (the built-in ones aside) is uploaded on both sides, in the same order.
//   The favorites go the Tauri way on the Rust side: the entry the backend
//   reads (`hub_favorite_entry`), the export JSON of the page's worker, then
//   the backend's upload. Each call must answer the same and send the same
//   requests, byte for byte (the multipart boundary aside), and the copies
//   must be the same afterwards (the Hub links written).
// - Startup update: the Hub answers a newer time for every Hub-linked
//   language pack and a changed pack for its download; both sides must
//   check, download and save the same, and leave the same copies.
//
// It prints counts only.
//
// Run: pnpm run test:hub-peer (PIPETTE_HUB_PEER_USER_DATA for a real
// userData's copy; see peer.ts)

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { clearHubTokenCache, setupHubIpc } from '../../src/main/hub/hub-ipc'
import { syncHubI18nPacksOnStartup } from '../../src/main/hub/i18n-startup-sync'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { FAVORITE_TYPES } from '../../src/shared/favorite-data'
import { runFavoriteTransfer } from '../../src/tauri-shim/workers/favorite-transfer-requests'
import type { FavoriteType } from '../../src/shared/types/favorite-store'
import { cargoTargetTmpDir } from '../fixture-files'
import { readTree } from '../rust-user-data-tree'
import { FIXED_NOW, writeTree } from '../sync-fixtures/harness'
import { ok, USER } from '../hub-fixtures/handler-scenario'
import { FAKE_ID_TOKEN, scriptedFetch, setRules, takeRecorded, type HubRule } from '../hub-fixtures/hub-harness'
import { invokeHandler } from '../hub-fixtures/ipc-handlers'
import { hubFixturePath } from '../hub-fixtures/paths'
import {
  comparable,
  countsOnly,
  trackedTempDir,
  electronCopy,
  fromLogged,
  liveEntries,
  readJson,
  realSource,
  removePeerDirs,
  runPeer,
  rustCopy,
  sortedRequests,
  type PeerRequest,
} from './peer'

const VIAL_PROTOCOL = 6
const POST_ID = 'peer-post'
const HUB_TIME = '2026-10-16 00:00:00.000Z'

/** The synthetic source: the tree the Rust Hub handlers wrote
 *  (verify:hub-rust-user-data) with the favorites of the favorite golden. */
function syntheticSource(): string {
  const tree = resolve(cargoTargetTmpDir('pipette-hub'), 'rust_user_data', 'user-data')
  if (!existsSync(tree)) throw new Error(`${tree} is missing; run cargo test -p pipette-hub --test rust_user_data first`)
  const dir = trackedTempDir('pipette-hub-peer-source-')
  const golden = JSON.parse(readFileSync(hubFixturePath('ts_hub_handlers_favorite.json'), 'utf8')) as {
    scenarios: Array<{ treeBefore: Record<string, string> }>
  }
  for (const scenario of golden.scenarios.slice(0, 2)) {
    const { 'local/installation-id': _, ...favorites } = scenario.treeBefore
    writeTree(dir, favorites)
  }
  writeTree(dir, readTextTree(tree))
  return dir
}

function readTextTree(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}${name.name}`
    if (name.isDirectory()) Object.assign(out, readTextTree(join(dir, name.name), `${path}/`))
    else out[path] = readFileSync(join(dir, name.name), 'utf8')
  }
  return out
}

const real = realSource()
const source = real ?? syntheticSource()

/** Whether a handler answered `{ success: true, … }`. */
function succeeded(answer: unknown): boolean {
  return (answer as { success?: unknown } | null)?.success === true
}

/** Writes a line of counts (a passing run shows it too). */
function report(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** The scripted Hub of the uploads: every upload is the post POST_ID, which
 *  the lists name with its uploader and time. */
function uploadRules(): HubRule[] {
  const summary = { id: POST_ID, name: 'peer', version: '1.0.0', uploaded_by: USER.id, uploader_name: 'Peer', created_at: HUB_TIME, updated_at: HUB_TIME }
  const page = { items: [summary], total: 1, page: 1, per_page: 20 }
  const repeat = (method: string, path: string, data: unknown): HubRule => ({ method, path, responses: [ok(data)], repeat: true })
  return [
    repeat('POST', '/api/auth/token', { token: 'jwt-peer', user: USER }),
    repeat('POST', '/api/key-labels', { id: POST_ID, name: 'peer', uploader_name: 'Peer', updated_at: HUB_TIME }),
    repeat('POST', '/api/i18n-packs', { id: POST_ID, title: 'peer' }),
    repeat('GET', '/api/i18n-packs', page),
    repeat('POST', '/api/theme-packs', { id: POST_ID, title: 'peer' }),
    repeat('GET', '/api/theme-packs', page),
    repeat('POST', '/api/files', { id: POST_ID, title: 'peer' }),
  ]
}

interface Call {
  /** What the call uploads, for the counts. */
  kind: 'key label' | 'language pack' | 'theme pack' | 'favorite'
  call: 'KEY_LABEL_HUB_UPLOAD' | 'HUB_UPLOAD_I18N_POST' | 'HUB_UPLOAD_THEME_POST' | 'HUB_UPLOAD_FAVORITE_POST'
  args: unknown[]
}

function packCalls(dir: string, store: 'i18n' | 'themes', call: Call['call'], kind: Call['kind']): Call[] {
  return liveEntries(readJson(dir, `sync/${store}/index.json`))
    .filter((meta) => !String(meta.id).startsWith('builtin-') && typeof meta.filename === 'string')
    .map((meta) => ({ kind, call, args: [{ entryId: meta.id, pack: readJson(dir, `sync/${store}/${String(meta.filename)}`) }] }))
}

function uploadCalls(dir: string): Call[] {
  const labels = liveEntries(readJson(dir, 'sync/key-labels/index.json'))
    .filter((entry) => entry.id !== 'qwerty')
    .map((entry): Call => ({ kind: 'key label', call: 'KEY_LABEL_HUB_UPLOAD', args: [entry.id] }))
  const favorites = FAVORITE_TYPES.flatMap((type) =>
    liveEntries(readJson(dir, `sync/favorites/${type}/index.json`)).map((entry): Call => ({
      kind: 'favorite',
      call: 'HUB_UPLOAD_FAVORITE_POST',
      args: [{ type, entryId: entry.id, title: 'peer', vialProtocol: VIAL_PROTOCOL }],
    })),
  )
  return [
    ...labels,
    ...packCalls(dir, 'i18n', 'HUB_UPLOAD_I18N_POST', 'language pack'),
    ...packCalls(dir, 'themes', 'HUB_UPLOAD_THEME_POST', 'theme pack'),
    ...favorites,
  ]
}

/** The files of two copies that differ, the installation id aside. */
function differingFiles(a: string, b: string): number {
  const [x, y] = [readTree(a), readTree(b)]
  const paths = new Set([...Object.keys(x), ...Object.keys(y)])
  paths.delete('local/installation-id')
  return [...paths].filter((path) => x[path] !== y[path]).length
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const guarded = globalThis.fetch

afterEach(() => {
  globalThis.fetch = guarded
})

afterAll(() => {
  const failed = removePeerDirs()
  if (failed > 0) report(`hub peer: ${failed} temporary director(ies) could not be removed`)
  expect(failed).toBe(0)
})

describe('the Hub handlers of both builds on a copy of a userData', () => {
  setupHubIpc()

  it('upload every entry the same way', () => countsOnly('the uploads', async () => {
    const electron = electronCopy(source)
    const rust = rustCopy(source)
    const calls = uploadCalls(electron)
    clearHubTokenCache()
    globalThis.fetch = scriptedFetch()
    setRules(uploadRules())
    const started = performance.now()
    const electronSide: Array<{ answer: unknown; requests: PeerRequest[] }> = []
    for (const call of calls) {
      const answer = await invokeHandler(IpcChannels[call.call], call.args)
      electronSide.push({ answer, requests: takeRecorded().requests.map(fromLogged) })
    }
    const electronMs = performance.now() - started

    // The favorites the Tauri way: the backend's read, then the worker's JSON.
    const favoriteCalls = calls.filter((call) => call.kind === 'favorite')
    const entries = await runPeer<{ results: Array<{ success: boolean; entry?: unknown; error?: string }> }>(rust, FIXED_NOW, {
      kind: 'favoriteEntries',
      entries: favoriteCalls.map((call) => {
        const params = call.args[0] as { type: string; entryId: string }
        return { type: params.type, entryId: params.entryId }
      }),
    })
    const rustCalls: Array<Record<string, unknown>> = []
    const readFailures = new Map<number, unknown>()
    let favorite = 0
    for (const [index, call] of calls.entries()) {
      if (call.kind !== 'favorite') {
        rustCalls.push({ call: call.call, args: call.args })
        continue
      }
      // The shim member's steps (api/hub-favorite.ts): a failed read or
      // build is its `{ success: false, error }`.
      const read = entries.output.results[favorite++]
      const params = call.args[0] as { type: FavoriteType }
      if (!read.success) {
        readFailures.set(index, { success: false, error: read.error })
        continue
      }
      const built = runFavoriteTransfer({ op: 'hubExport', scope: params.type, vialProtocol: VIAL_PROTOCOL, entry: read.entry as never })
      if ('json' in built) rustCalls.push({ call: call.call, args: call.args, json: built.json })
      else readFailures.set(index, { success: false, error: 'error' in built ? built.error : (built.thrown ?? 'Upload failed') })
    }
    const peer = await runPeer<{ results: Array<{ answer: unknown; requests: PeerRequest[] }> }>(rust, FIXED_NOW, {
      kind: 'calls',
      idToken: FAKE_ID_TOKEN,
      rules: uploadRules(),
      calls: rustCalls,
    })

    const counts: Record<string, { calls: number; same: number; ok: number }> = {}
    let sent = 0
    for (const [index, call] of calls.entries()) {
      const count = (counts[call.kind] ??= { calls: 0, same: 0, ok: 0 })
      count.calls++
      const failed = readFailures.get(index)
      const rustSide = failed !== undefined ? { answer: failed, requests: [] } : peer.output.results[sent++]
      const mine = electronSide[index]
      if (succeeded(mine.answer)) count.ok++
      if (sameJson(mine.answer, rustSide.answer) && sameJson(mine.requests, rustSide.requests.map(comparable))) {
        count.same++
      }
    }
    const differing = differingFiles(electron, rust)
    report(
      `hub peer uploads: ${Object.entries(counts).map(([kind, { calls: n, same, ok: done }]) => `${kind} ${same}/${n} (${done} ok)`).join(', ')}; ` +
        `files differing after: ${differing}; Electron ${Math.round(electronMs)} ms, Rust ${peer.elapsedMs} ms (max RSS ${peer.maxRssKb ?? '?'} KB)`,
    )
    expect(Object.values(counts).every(({ calls: n, same }) => n === same)).toBe(true)
    expect(differing).toBe(0)
    if (real === null) {
      // The synthetic tree uploads every kind, some of each successfully.
      expect(Object.keys(counts).sort()).toEqual(['favorite', 'key label', 'language pack', 'theme pack'])
      expect(Object.values(counts).every(({ ok: done }) => done > 0)).toBe(true)
    }
  }))

  it('update the Hub-linked language packs at startup the same way', () => countsOnly('the startup update', async () => {
    const electron = electronCopy(source)
    const rust = rustCopy(source)
    const linked = liveEntries(readJson(electron, 'sync/i18n/index.json')).filter(
      (meta) => typeof meta.hubPostId === 'string' && meta.hubPostId.trim() !== '',
    )
    const rules: HubRule[] = [
      {
        method: 'POST',
        path: '/api/i18n-packs/timestamps',
        responses: [ok({ items: linked.map((meta) => ({ id: String(meta.hubPostId).trim(), updated_at: HUB_TIME })) })],
        repeat: true,
      },
      ...linked.map((meta): HubRule => {
        const pack = readJson(electron, `sync/i18n/${String(meta.filename)}`) as Record<string, unknown>
        const changed = { ...pack, version: '99.0.0' }
        return {
          method: 'GET',
          path: `/api/i18n-packs/${encodeURIComponent(String(meta.hubPostId).trim())}/download`,
          responses: [{ status: 200, json: { version: 1, kind: 'i18n', exportedAt: '2026-10-16T00:00:00.000Z', pack: changed } }],
          repeat: true,
        }
      }),
    ]
    globalThis.fetch = scriptedFetch()
    setRules(rules)
    const started = performance.now()
    const result = await syncHubI18nPacksOnStartup()
    const electronMs = performance.now() - started
    const electronRequests = sortedRequests(takeRecorded().requests.map(fromLogged))

    const peer = await runPeer<{ result: Record<string, number>; requests: PeerRequest[] }>(rust, FIXED_NOW, { kind: 'startupSync', rules })
    const sameResult = sameJson(
      { checked: result.checked, updated: result.updated, missingOnHub: result.missingOnHub, errors: result.errors.length },
      peer.output.result,
    )
    const sameRequests = sameJson(electronRequests, sortedRequests(peer.output.requests))
    const differing = differingFiles(electron, rust)
    report(
      `hub peer startup update: linked ${linked.length}, updated ${result.updated} (Rust ${peer.output.result.updated}), ` +
        `errors ${result.errors.length}; same result ${sameResult}, same requests ${sameRequests}, files differing after: ${differing}; ` +
        `Electron ${Math.round(electronMs)} ms, Rust ${peer.elapsedMs} ms`,
    )
    expect(sameResult).toBe(true)
    expect(sameRequests).toBe(true)
    expect(differing).toBe(0)
    if (real === null) {
      expect(linked.length).toBeGreaterThan(0)
      expect(result.updated).toBe(linked.length)
    }
  }))
})
