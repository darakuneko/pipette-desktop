// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for the Rust Drive client
// (src-tauri/crates/pipette-drive). Every value comes from the real
// TypeScript code, run in the sync fixture harness (harness.ts):
//
// - request_log.json — the scenarios of drive-request-log.ts run through
//   google-drive.ts against the Node fake Drive (scripts/fake-drive): the
//   requests it sends (written as drive-request-log.ts describes), the
//   waits between attempts and the result or error message of each step.
//   The requests go to www.googleapis.com as google-drive.ts writes them
//   and are sent on to the fake Drive on 127.0.0.1; nothing else is
//   reachable.
// - canonical_trash.json — drive-canonical.ts and drive-trash.ts on tables
//   of listings and names.
//
// Run: pnpm run generate:drive-fixtures

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { writeJsonFixture } from '../fixture-files'
import { startFakeDrive, type FakeDrive } from '../fake-drive/server'
import { FIXED_NOW } from './harness'
import { LIST_SUMMARY_OVER, SCENARIOS, logRequest, seedFiles, type LoggedRequest, type Scenario, type Step } from './drive-request-log'

const token = vi.hoisted(() => ({ value: 'fixture-token' as string | null }))

vi.mock('../../src/main/sync/google-auth', () => ({ getAccessToken: async () => token.value }))

import {
  createRawFile,
  deleteFile,
  deleteFilesById,
  deleteFilesByPrefix,
  downloadRawFile,
  listFiles,
  renameFile,
  uploadFile,
  type DriveFile,
} from '../../src/main/sync/google-drive'
import { retryTiming } from '../../src/main/sync/drive-retry'
import {
  canonicalFiles,
  duplicatedNames,
  filesNamed,
  filesNamedWithTrash,
  isNewerCopy,
  namesWithTrash,
  pickCanonicalFile,
  trashCopiesOf,
} from '../../src/main/sync/drive-canonical'
import { TRASH_QUARANTINE_MS, isTrashExpired, parseTrashFile, trashFileName } from '../../src/main/sync/drive-trash'
import { syncRuntime } from '../../src/main/sync/sync-runtime-state'
import type { SyncEnvelope } from '../../src/shared/types/sync'

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src-tauri/crates/pipette-drive/tests/fixtures')
const GOOGLE_API_ORIGIN = 'https://www.googleapis.com'
/** The jitter draw of every backoff. */
const RANDOM = 0.5

type StepResult = { ok: unknown } | { error: string }

function listResult(files: readonly DriveFile[]): unknown {
  if (files.length <= LIST_SUMMARY_OVER) return files
  return { count: files.length, head: files.slice(0, 2), tail: files.slice(-2) }
}

async function runStep(step: Step): Promise<StepResult> {
  switch (step.op) {
    case 'fault':
    case 'token':
    case 'quitOnNextWait':
      throw new Error('handled by the scenario')
    case 'list':
      return { ok: listResult(await listFiles(step.nameContains === undefined ? undefined : { nameContains: step.nameContains })) }
    case 'download':
      return { ok: await downloadRawFile(step.id) }
    case 'upload': {
      // uploadFile writes JSON.stringify of the envelope; the step's
      // content is that text, so the parse gives back the same bytes.
      const envelope = JSON.parse(step.content) as SyncEnvelope
      expect(JSON.stringify(envelope)).toBe(step.content)
      const options = step.createIfMissing === undefined ? undefined : { createIfMissing: step.createIfMissing }
      return { ok: await uploadFile(step.name, envelope, step.id, options) }
    }
    case 'createRaw':
      return { ok: await createRawFile(step.name, step.content) }
    case 'rename':
      return { ok: await renameFile(step.id, step.name) }
    case 'delete':
      await deleteFile(step.id)
      return { ok: null }
    case 'deleteById':
      return { ok: await deleteFilesById(step.ids) }
    case 'deleteByPrefix':
      return { ok: await deleteFilesByPrefix(step.prefix) }
  }
}

function sortedLog(log: LoggedRequest[]): LoggedRequest[] {
  return [...log].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
}

describe('drive fixtures', () => {
  let drive: FakeDrive
  const warn = vi.spyOn(console, 'warn')

  beforeAll(async () => {
    drive = await startFakeDrive()
    warn.mockImplementation(() => {})
  })

  afterAll(async () => {
    warn.mockRestore()
    await drive.close()
  })

  async function record(scenario: Scenario): Promise<unknown> {
    drive.state.reset()
    for (const file of seedFiles(scenario.seed ?? [])) drive.state.create(file.name, Buffer.from(file.content), 'application/json')
    token.value = 'fixture-token'
    syncRuntime.isQuitting = false
    const quit = { onNextWait: false }
    const requests: LoggedRequest[] = []
    const sleeps: number[] = []
    const results: StepResult[] = []
    const guarded = globalThis.fetch
    const saved = { sleep: retryTiming.sleep, random: retryTiming.random }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.origin !== GOOGLE_API_ORIGIN) throw new Error(`google-drive.ts sent a request to ${url.origin}`)
      requests.push(logRequest(url, init))
      return guarded(`${drive.url}${url.pathname}${url.search}`, init)
    }) as typeof fetch
    retryTiming.sleep = async (ms: number) => {
      sleeps.push(ms)
      if (quit.onNextWait) {
        quit.onNextWait = false
        syncRuntime.isQuitting = true
      }
    }
    retryTiming.random = () => RANDOM
    try {
      for (const step of scenario.steps) {
        if (step.op === 'fault') {
          drive.state.inject({ status: step.status, count: step.count, retryAfter: step.retryAfter, body: step.body, only: step.only as never })
        } else if (step.op === 'token') {
          token.value = step.value
        } else if (step.op === 'quitOnNextWait') {
          quit.onNextWait = true
        } else {
          try {
            results.push(await runStep(step))
          } catch (err) {
            results.push({ error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
    } finally {
      globalThis.fetch = guarded
      retryTiming.sleep = saved.sleep
      retryTiming.random = saved.random
      syncRuntime.isQuitting = false
    }
    return { ...scenario, requests: scenario.unordered ? sortedLog(requests) : requests, sleeps, results }
  }

  it('records the request log of google-drive.ts', async () => {
    const scenarios = []
    for (const scenario of SCENARIOS) scenarios.push(await record(scenario))
    // The order of the requests is the same on every run.
    expect(await record(SCENARIOS[5])).toEqual(scenarios[5])
    writeJsonFixture(resolve(fixturesDir, 'request_log.json'), {
      about:
        'The requests google-drive.ts sends for each scenario (scripts/sync-fixtures/drive-request-log.ts), the waits between attempts and the result of each step that is not fault, token or quitOnNextWait. Generated by scripts/sync-fixtures/record-drive-fixtures.test.ts; do not edit.',
      nowMs: FIXED_NOW,
      random: RANDOM,
      listSummaryOver: LIST_SUMMARY_OVER,
      scenarios,
    })
  })

  it('records the canonical and trash tables', () => {
    const f = (id: string, name: string, modifiedTime: string): DriveFile => ({ id, name, modifiedTime })
    const t1 = '2026-01-01T00:00:00.000Z'
    const t2 = '2026-01-02T00:00:00.000Z'
    const listings: Array<{ files: DriveFile[]; names: string[] }> = [
      { files: [], names: ['a.enc'] },
      {
        files: [
          f('b-old', 'favorites_combo.enc', t1),
          f('a-1', 'favorites_macro.enc', t1),
          f('b-new', 'favorites_combo.enc', '2026-01-03T00:00:00.000Z'),
          f('z', 'favorites_macro.enc', t1),
          f('m', 'favorites_macro.enc', t1),
          f('broken', 'key-labels.enc', 'not-a-time'),
          f('valid', 'key-labels.enc', '2020-01-01T00:00:00.000Z'),
          f('broken2', 'key-labels.enc', ''),
          f('B', 'i18n_index.enc', t2),
          f('a', 'i18n_index.enc', t2),
          f('\u{1F600}', 'themes_index.enc', t2),
          f('｡', 'themes_index.enc', t2),
          f('offset', 'typing-test-texts.enc', '2026-01-02T09:00:00.000+09:00'),
          f('zulu', 'typing-test-texts.enc', '2026-01-02T00:00:00Z'),
        ],
        names: ['favorites_combo.enc', 'favorites_macro.enc', 'key-labels.enc', 'i18n_index.enc', 'themes_index.enc', 'typing-test-texts.enc', 'absent.enc'],
      },
      {
        files: [
          f('l1', 'favorites_macro.enc', t1),
          f('s1', 'favorites_tapDance.enc', t1),
          f('ta', 'favorites_macro.enc.trash.1.2.ta', t1),
          f('l2', 'favorites_macro.enc', t2),
          f('tb', 'favorites_tapDance.enc.trash.1.2.tb', t1),
          f('tf', 'favorites_macro.enc.trash.1.2.zz', t1),
          f('tc', 'favorites_macro.enc.trash.5.6.tc', t2),
          f('tp', 'password-check.enc.trash.1.2.tp', t1),
          f('tu', 'unknown.enc.trash.1.2.tu', t1),
          f('only', 'keyboards_0x1_settings.enc.trash.3.4.only', t1),
        ],
        names: ['favorites_macro.enc', 'favorites_tapDance.enc', 'keyboards_0x1_settings.enc', 'favorites_none.enc'],
      },
    ]
    const ids = (files: readonly DriveFile[]): string[] => files.map((file) => file.id)
    const canonical = listings.map(({ files, names }) => ({
      files,
      canonicalFiles: ids(canonicalFiles(files)),
      duplicatedNames: duplicatedNames(files),
      namesWithTrash: namesWithTrash(files),
      byName: names.map((name) => ({
        name,
        pickCanonical: pickCanonicalFile(files, name)?.id ?? null,
        filesNamed: ids(filesNamed(files, name)),
        trashCopiesOf: trashCopiesOf(files, name).map((copy) => ({ id: copy.file.id, trash: copy.trash })),
        filesNamedWithTrash: ids(filesNamedWithTrash(files, name)),
      })),
    }))

    const newer: Array<[number, string, number, string]> = [
      [2, 'a', 1, 'b'],
      [1, 'a', 2, 'b'],
      [1, 'a', 1, 'b'],
      [1, 'b', 1, 'a'],
      [1, 'a', 1, 'a'],
      [-Infinity, 'a', -Infinity, 'b'],
      [-Infinity, 'a', 0, 'b'],
      [0, '\u{1F600}', 0, '｡'],
      [0, 'B', 0, 'a'],
      [0, 'a', 0, 'ab'],
    ]

    const trashNames: Array<{ id: string; name: string; modifiedTime: string; renamedAtMs: number }> = [
      { id: 'Abc_-1', name: 'favorites_macro.enc', modifiedTime: '2026-10-01T00:00:00.000Z', renamedAtMs: 1234 },
      { id: 'id1', name: 'favorites_macro.enc', modifiedTime: 'broken', renamedAtMs: 5 },
      { id: 'id1', name: 'favorites_macro.enc', modifiedTime: '1969-12-31T23:59:59.000Z', renamedAtMs: 5 },
      { id: 'id1', name: 'favorites_macro.enc', modifiedTime: '2026-10-01T09:00:00.123+09:00', renamedAtMs: -7 },
      { id: 'id1', name: 'keyboards_0x1_devices_h1_days_2026-10-01.enc', modifiedTime: '2026-10-01T00:00:00.000Z', renamedAtMs: 1792108800000 },
      { id: 'id.1', name: 'favorites_macro.enc', modifiedTime: '2026-10-01T00:00:00.000Z', renamedAtMs: 5 },
      { id: '', name: 'favorites_macro.enc', modifiedTime: '2026-10-01T00:00:00.000Z', renamedAtMs: 5 },
      { id: 'id 1', name: 'favorites_macro.enc', modifiedTime: '2026-10-01T00:00:00.000Z', renamedAtMs: 5 },
      { id: 'idé', name: 'favorites_macro.enc', modifiedTime: '2026-10-01T00:00:00.000Z', renamedAtMs: 5 },
    ]

    const parses: Array<{ id: string; name: string }> = [
      { id: 'Abc_-1', name: 'favorites_macro.enc.trash.1234.1790812800000.Abc_-1' },
      { id: 'id2', name: 'favorites_macro.enc.trash.1.2.id1' },
      { id: 'id1', name: 'password-check.enc.trash.1.2.id1' },
      { id: 'id1', name: 'unknown.enc.trash.1.2.id1' },
      { id: 'id1', name: 'favorites_macro.enc.trash.x.2.id1' },
      { id: 'id1', name: 'favorites_macro.enc.trash.1.2' },
      { id: 'id1', name: 'favorites_macro.enc' },
      { id: 'id1', name: 'favorites_macro.enc.trash.007.0002.id1' },
      { id: 'id1', name: 'favorites_macro.enc.trash.9007199254740991.9007199254740991.id1' },
      { id: 'id1', name: 'favorites_macro.enc.trash.9007199254740992.1.id1' },
      { id: 'id1', name: 'favorites_macro.enc.trash.1.99999999999999999999999.id1' },
      { id: 'id1', name: 'favorites_macro.enc.trash.1.2.trash.3.4.id1' },
      { id: 'id1', name: 'favorites_a.enc.trash.1.2.x.enc.trash.3.4.id1' },
      { id: 'id1', name: 'favorites_a\nb.enc.trash.1.2.id1' },
      { id: 'id1', name: 'favorites_a\u0085b.enc.trash.1.2.id1' },
      { id: 'id1', name: 'favorites_macro.enc.trash.1.2.id1\n' },
      { id: 'id1', name: 'favorites_macro.enc.trash.١.2.id1' },
      { id: 'id1', name: 'keyboards_0x1_devices_h1_days_2026-10-01.enc.trash.1.2.id1' },
      { id: 'id1', name: 'i18n_packs_p1.enc.trash.1.2.id1' },
      { id: 'id1', name: 'sync-format-v1.json.trash.1.2.id1' },
      { id: 'id1', name: 'password-change-lock.json.enc.trash.1.2.id1' },
      { id: 'id1', name: 'key-labels.enc.trash.1.2.id1' },
      { id: '', name: 'key-labels.enc.trash.1.2.' },
    ]

    const expiry: Array<{ renamedAtMs: number; nowMs: number }> = [
      { renamedAtMs: 1000, nowMs: 1000 + TRASH_QUARANTINE_MS - 1 },
      { renamedAtMs: 1000, nowMs: 1000 + TRASH_QUARANTINE_MS },
      { renamedAtMs: 1000, nowMs: 0 },
      { renamedAtMs: 0, nowMs: TRASH_QUARANTINE_MS + 1 },
    ]

    writeJsonFixture(resolve(fixturesDir, 'canonical_trash.json'), {
      about: 'drive-canonical.ts and drive-trash.ts on tables. Generated by scripts/sync-fixtures/record-drive-fixtures.test.ts; do not edit.',
      trashQuarantineMs: TRASH_QUARANTINE_MS,
      canonical,
      // -Infinity is written as null.
      isNewerCopy: newer.map(([aMs, aId, bMs, bId]) => ({
        aMs: Number.isFinite(aMs) ? aMs : null,
        aId,
        bMs: Number.isFinite(bMs) ? bMs : null,
        bId,
        newer: isNewerCopy(aMs, aId, bMs, bId),
      })),
      trashFileName: trashNames.map((c) => ({ ...c, trashName: trashFileName(c, c.renamedAtMs) })),
      parseTrashFile: parses.map((c) => ({ ...c, trash: parseTrashFile(c) })),
      isTrashExpired: expiry.map((c) => ({
        ...c,
        expired: isTrashExpired({ originalName: 'a.enc', renamedAtMs: c.renamedAtMs, preModifiedMs: 0 }, c.nowMs),
      })),
    })
  })
})
