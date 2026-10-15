// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-entry-store: runs the real
// src/main/sync/body-filename-migration.ts over store directories built in
// a temp directory and records what each call returned and every file and
// directory left behind (path → content), so the crate can replay each
// scenario and compare the bytes.
//
// Run: pnpm run generate:entry-store-fixtures

import { afterAll, describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import type { EntryStore } from '../../src/main/sync/entry-clocks'
import { normalizeEntries } from '../../src/main/sync/entry-write'
import { migrateBodyFilenames, readIndexDirMigrated, unlinkUnreferencedBodyFiles } from '../../src/main/sync/body-filename-migration'
import { LONE, MAX_ISO, T, TS, UUID } from './fixture-inputs'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-entry-store/tests/fixtures/ts_migration_scenarios.json')

/** A store directory: file path → UTF-8 content (`{ hex }` for bytes that
 *  are not UTF-8), or null for a directory. */
type Tree = Record<string, string | { hex: string } | null>

type Scenario =
  | { name: string; store: EntryStore; op: 'readIndexDir'; tree: Tree }
  | { name: string; store: EntryStore; op: 'migrate'; tree: Tree; entries: string; persist: 'ok' | 'fail' }
  | { name: string; store: EntryStore; op: 'unlink'; tree: Tree; referenced: string[] }

/** The file U+FFFD names on disk for a name with a lone surrogate. */
const FFFD = '\uFFFD'

const index = (head: Record<string, unknown>, entries: unknown[]): string => JSON.stringify({ ...head, entries })
const entry = (id: string, filename: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, label: 'L', filename, savedAt: T(1), ...extra,
})

const LONG_DEVICE = 'K'.repeat(240 - TS.length - '_.pipette'.length)
const EMOJI_DEVICE = '😀'.repeat(40)

const SCENARIOS: Scenario[] = [
  {
    name: 'two ids share a legacy file', store: 'favorites', op: 'readIndexDir',
    tree: { 'index.json': index({ type: 'macro' }, [entry('id1', 'macro_ts_ab12.json'), entry('id2', 'macro_ts_ab12.json')]), 'macro_ts_ab12.json': 'BODY' },
  },
  {
    name: 'an entry keeps its own prefix name, another gets a copy', store: 'keyLabels', op: 'readIndexDir',
    tree: { 'index.json': index({}, [{ id: 'abc', name: 'N', filename: 'abc_x.json', savedAt: T(1) }, { id: 'other', name: 'N', filename: 'abc_x.json', savedAt: T(1) }]), 'abc_x.json': 'SHARED' },
  },
  {
    name: 'a tombstone whose body is gone', store: 'analyzeFilters', op: 'readIndexDir',
    tree: { 'index.json': index({ uid: 'u' }, [entry('t', 'gone.json', { deletedAt: T(2) })]) },
  },
  {
    name: 'every name already carries its id: nothing is written', store: 'favorites', op: 'readIndexDir',
    tree: { 'index.json': '{"type":"macro","entries":[{"id":"id1","filename":"a_ts_id1.json","savedAt":"x"}],"extra":1}\n', 'a_ts_id1.json': 'BODY' },
  },
  {
    name: 'a v1 index with future clocks, unknown fields and index keys', store: 'snapshots', op: 'readIndexDir',
    tree: {
      'index.json': index({ 9: 0, uid: 'u', zz: true }, [
        { 3: 'three', id: 's1', label: 'L', filename: `KB_${TS}.pipette`, savedAt: '9999-12-31T23:59:59.999Z', updatedAt: MAX_ISO, vilVersion: 2, unknown: { b: 1, a: [] } },
        { id: 's2', label: 'L', filename: `KB2_${TS}.pipette`, savedAt: T(1), clocks: { created: T(1), body: '+275760-09-13T00:00:00.001Z', name: MAX_ISO, hub: 'garbage' }, updatedAt: T(5), deletedAt: MAX_ISO },
      ]),
      [`KB_${TS}.pipette`]: 'ONE',
      [`KB2_${TS}.pipette`]: 'TWO',
    },
  },
  { name: 'no index', store: 'favorites', op: 'readIndexDir', tree: {} },
  { name: 'not JSON', store: 'favorites', op: 'readIndexDir', tree: { 'index.json': '{"entries":[' } },
  { name: 'empty file', store: 'favorites', op: 'readIndexDir', tree: { 'index.json': '' } },
  { name: 'a byte order mark', store: 'favorites', op: 'readIndexDir', tree: { 'index.json': '\uFEFF{"entries":[]}' } },
  { name: 'an array', store: 'favorites', op: 'readIndexDir', tree: { 'index.json': '[]' } },
  { name: 'no entries', store: 'favorites', op: 'readIndexDir', tree: { 'index.json': '{"type":"macro"}' } },
  { name: 'entries is not an array', store: 'favorites', op: 'readIndexDir', tree: { 'index.json': '{"entries":{"0":{}}}' } },
  { name: 'index.json is a directory', store: 'favorites', op: 'readIndexDir', tree: { 'index.json/': null } },
  {
    // x<FF>.json, a label of <E6 97>a<C0 AF><ED A0 80>: each bad sequence
    // reads as U+FFFD (one per maximal subpart).
    name: 'invalid UTF-8 in the index', store: 'favorites', op: 'readIndexDir',
    tree: {
      'index.json': { hex: Buffer.concat([
        Buffer.from('{"entries":[{"id":"i","filename":"x'), Buffer.from([0xff]), Buffer.from('.json","label":"'),
        Buffer.from([0xe6, 0x97]), Buffer.from('a'), Buffer.from([0xc0, 0xaf, 0xed, 0xa0, 0x80]), Buffer.from(`","savedAt":"${T(1)}"}]}`),
      ]).toString('hex') },
      [`x${FFFD}.json`]: 'BODY',
    },
  },
  {
    name: 'long, multi-byte and control-character legacy names', store: 'snapshots', op: 'readIndexDir',
    tree: {
      'index.json': index({ uid: 'u' }, [
        entry(UUID, `${LONG_DEVICE}_${TS}.pipette`),
        entry('e2', `${EMOJI_DEVICE}_${TS}.pipette`),
        entry('e3', `${'日本語'.repeat(20)}_${TS}.pipette`),
        entry('e4', `ctl\u0001\u001f\u007f name_${TS}.pipette`),
        entry('e5', `${'é_'.repeat(60)}_${TS}.pipette`),
      ]),
      [`${LONG_DEVICE}_${TS}.pipette`]: 'LONG',
      [`${EMOJI_DEVICE}_${TS}.pipette`]: 'EMOJI',
      [`${'日本語'.repeat(20)}_${TS}.pipette`]: 'CJK',
      [`ctl\u0001\u001f\u007f name_${TS}.pipette`]: 'CTL',
    },
  },
  {
    name: 'lone surrogates in an id and a filename', store: 'favorites', op: 'readIndexDir',
    tree: {
      'index.json': index({ type: 'macro' }, [entry(LONE, `m${LONE}.json`), entry('ok', `n${LONE}_x.json`)]),
      [`m${FFFD}.json`]: 'LONE',
      [`n${FFFD}_x.json`]: 'NAME',
    },
  },
  {
    name: 'unsafe names are left alone', store: 'favorites', op: 'readIndexDir',
    tree: { 'index.json': index({}, [entry('a', '../evil.json'), entry('b', 'a\\b.json'), entry('c', '..'), entry('d', '')]) },
  },
  {
    name: 'entries without a string id are dropped from the written index', store: 'favorites', op: 'readIndexDir',
    tree: { 'index.json': index({}, [entry('a', 'old.json'), { id: 5, filename: 'x.json' }, null, 'str', { filename: 'y.json' }]), 'old.json': 'OLD' },
  },
  {
    name: 'a copy over an existing file', store: 'favorites', op: 'readIndexDir',
    tree: { 'index.json': index({}, [entry('a', 'm.json')]), 'm.json': 'NEW', 'm_a.json': 'STALE' },
  },
  {
    name: 'a NUL in a filename fails', store: 'favorites', op: 'readIndexDir',
    tree: { 'index.json': index({}, [entry('a', 'n\u0000ul.json')]) },
  },
  {
    name: 'a legacy name that is a directory fails before the index is written', store: 'favorites', op: 'readIndexDir',
    tree: { 'index.json': index({}, [entry('a', 'd.json'), entry('b', 'f.json')]), 'd.json/': null, 'f.json': 'F' },
  },
  {
    name: 'pack names are fixed and never moved', store: 'i18nPacks', op: 'readIndexDir',
    tree: { 'index.json': index({}, [{ id: 'p1', filename: 'other.json', name: 'N', savedAt: T(1) }]), 'other.json': '{}' },
  },
  {
    name: 'prefix and suffix stores', store: 'typingTestTexts', op: 'readIndexDir',
    tree: { 'index.json': index({}, [{ id: 'x1', name: 'N', filename: 'text.json', savedAt: T(1) }]), 'text.json': 'T' },
  },
  {
    name: 'run logs', store: 'runLogs', op: 'readIndexDir',
    tree: { 'index.json': index({}, [{ id: 'r1', startedAt: T(0), filename: '2026_r.json', savedAt: T(1) }, { id: 'r1', startedAt: T(0), filename: '2026_r.json', savedAt: T(2) }]), '2026_r.json': 'R' },
  },
  {
    name: 'migrate with a persist step that succeeds', store: 'favorites', op: 'migrate', persist: 'ok',
    entries: JSON.stringify([entry('id1', 'old.json'), entry('id2', 'old.json'), entry('id3', 'keep_id3.json')]),
    tree: { 'old.json': 'OLD', 'keep_id3.json': 'KEEP' },
  },
  {
    name: 'migrate with a persist step that fails', store: 'favorites', op: 'migrate', persist: 'fail',
    entries: JSON.stringify([entry('id1', 'old.json')]), tree: { 'old.json': 'OLD' },
  },
  {
    name: 'unreferenced body files', store: 'favorites', op: 'unlink', referenced: ['keep_a.json', `r${LONE}_x.json`],
    tree: {
      'index.json': '{}', 'keep_a.json': '', 'drop_b.json': '', 'note.txt': '', 'plain.json': '', 'x_y.json.1.abc.tmp': '',
      'dir_c.json/': null, [`r${FFFD}_x.json`]: '', [`s${FFFD}_y.json`]: '',
    },
  },
  { name: 'unreferenced body files of a snapshot store', store: 'snapshots', op: 'unlink', referenced: [], tree: { 'a_b.pipette': '', 'a_b.json': '' } },
]

let root = ''
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function build(dir: string, tree: Tree): void {
  for (const [path, content] of Object.entries(tree)) {
    if (content === null) mkdirSync(join(dir, path), { recursive: true })
    else writeFileSync(join(dir, path), typeof content === 'string' ? content : Buffer.from(content.hex, 'hex'))
  }
}

/** Every file (path → UTF-8 content) and directory (`path/` → null) under `dir`. */
function record(dir: string, prefix = ''): Tree {
  const tree: Tree = {}
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
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

async function run(scenario: Scenario, dir: string): Promise<unknown> {
  try {
    switch (scenario.op) {
      case 'readIndexDir': {
        const read = await readIndexDirMigrated(scenario.store, dir)
        return read.state === 'ok'
          ? { state: 'ok', index: JSON.stringify(read.index), entries: JSON.stringify(read.entries) }
          : { state: read.state }
      }
      case 'migrate': {
        const entries = normalizeEntries(scenario.store, JSON.parse(scenario.entries))
        const changed = await migrateBodyFilenames(scenario.store, dir, entries, async () => {
          if (scenario.persist === 'fail') throw new Error('disk full')
          writeFileSync(join(dir, 'persisted.json'), JSON.stringify(entries))
        })
        return { changed, entries: JSON.stringify(entries) }
      }
      case 'unlink':
        return { removed: await unlinkUnreferencedBodyFiles(scenario.store, dir, new Set(scenario.referenced)) }
    }
  } catch {
    return { error: true }
  }
}

describe('body filename migration fixtures', () => {
  it('records each scenario’s result and the directory it leaves', async () => {
    root = mkdtempSync(join(tmpdir(), 'entry-store-fixtures-'))
    const results: unknown[] = []
    for (const [i, scenario] of SCENARIOS.entries()) {
      const dir = join(root, String(i))
      mkdirSync(dir)
      build(dir, scenario.tree)
      const result = await run(scenario, dir)
      results.push({ ...scenario, result, after: record(dir) })
    }
    writeJsonFixture(OUT, results)
    expect(results.some((r) => (r as { result: { error?: boolean } }).result.error)).toBe(true)
  })
})
