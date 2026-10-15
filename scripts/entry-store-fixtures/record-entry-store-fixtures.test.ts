// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-entry-store: runs the real
// src/main/sync/entry-clocks.ts, entry-write.ts and the shared file-name
// helpers over tables of inputs and records what each returns (or that it
// throws), JSON values as JSON.stringify texts, so the crate can replay
// every case and compare the bytes.
//
// Run: pnpm run generate:entry-store-fixtures

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import {
  type BaseEntryMeta,
  type ClockedEntry,
  type EntryGroup,
  type EntryStore,
  STORE_GROUPS,
  bodyFieldsOf,
  bodyFilenameHasId,
  bodyHash,
  canonicalJson,
  clockMs,
  derivedUpdatedAt,
  groupValues,
  idBodyFilename,
  idFilenameSegment,
  markDeleted,
  newClocks,
  normalizeEntry,
  reviveEntry,
  setClock,
  touchClock,
  validClock,
} from '../../src/main/sync/entry-clocks'
import { applyEntryMutation, builtinEntry, createEntry, normalizeEntries, overwriteEntry } from '../../src/main/sync/entry-write'
import { truncateUtf8, truncateUtf8NamePart, utf8ByteLength } from '../../src/shared/utils/utf8-truncate'
import {
  isSafeKey, isSafePackId, isSafePath, isSafePathSegment, safeFilename, tsForExportFilename, tsForFilename,
} from '../../src/shared/utils/safe-filename'
import { LONE, MAX_ISO, NEAR_MAX_ISO, STORES, T, TS, UUID, ms } from './fixture-inputs'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-entry-store/tests/fixtures/ts_functions.json')

type Meta = BaseEntryMeta & Record<string, unknown>
type Clocked = ClockedEntry<Meta>
const GROUPS: EntryGroup[] = ['created', 'body', 'name', 'hub', 'enabled']

/** What `run` returned as JSON text, or that it threw. */
function outcome(run: () => unknown): { out: string | null } | { throws: true } {
  try {
    return { out: JSON.stringify(run()) ?? null }
  } catch {
    return { throws: true }
  }
}

// ---- Dates ----

/** Texts both builds read the same way (the ECMAScript date time format). */
const DATE_TEXTS = [
  T(0), '2026-01-01', '2026-01', '2026', '2026-01-01T00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.1Z',
  '2026-01-01T00:00:00.12345Z', '2026-01-01T24:00:00.000Z', '2026-01-01T00:00:00+09:00', '2026-01-01T00:00:00.000-00:00',
  '2026-01-01T12:30', '2026-01-01T00:00:00', '+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z',
  '9999-12-31T23:59:59.999Z', MAX_ISO, NEAR_MAX_ISO, '-271821-04-20T00:00:00.000Z', '1970-01-01T00:00:00.000Z',
  '1969-12-31T23:59:59.999Z', '1970-01-01T00:00:00.001Z', '2026-02-30T00:00:00Z', '0000-01-01T00:00:00Z',
  '-000000-01-01T00:00:00.000Z', '+275760-09-13T00:00:00.001Z', '2026-01-01T24:00:01Z', '2026-01-01T00:00:60Z',
  '2026-13-01', '2026-01-32', '2026-01-00', '2026-01-01T00:00:00.Z', '2026-01-01T00:00:00.000+24:00', '2026-01-01T00Z',
  `${T(0)} `, '20260101', '', 'garbage', `2026-01-01T00:00:00.000Z${LONE}`, '1e3',
]

/** Texts only V8's fallback parser reads; the crate reads them as 0. */
const V8_ONLY_DATE_TEXTS = [
  'Jan 1 2026', '2026-1-1', ' 2026-01-01', '2026-01-01t00:00:00z', '2026-01-01T00:00:00+0900', '2026-01-01Z', '12',
  '+2026-01-01', '2026-01-01 00:00:00Z',
]

const NON_STRING_CLOCKS = ['42', 'null', 'true', '{}', '[]', `[${JSON.stringify(T(0))}]`]

function dateCases(): unknown {
  return {
    texts: DATE_TEXTS.map((text) => ({ text, clockMs: clockMs(text), validClock: validClock(text) ?? null })),
    v8Only: V8_ONLY_DATE_TEXTS.map((text) => ({ text, v8: clockMs(text) })),
    nonStrings: NON_STRING_CLOCKS.map((text) => ({ text, clockMs: clockMs(JSON.parse(text)) })),
  }
}

// ---- File names ----

const UTF8_TEXTS = ['', 'abc', 'aé日😀', `a${LONE}b`, '\uDE00\uD83D', 'ab_. \u3000cd', 'x\uFEFF', 'x\u0085', '___', '日本語_.']

function utf8Cases(): unknown {
  return UTF8_TEXTS.map((text) => ({
    text,
    byteLength: utf8ByteLength(text),
    cuts: [0, 1, 2, 3, 4, 5, 7, 100].map((max) => ({ max, truncate: truncateUtf8(text, max), namePart: truncateUtf8NamePart(text, max) })),
  }))
}

const SAFE_NAMES = ['my file!!name', '!!!', '__日本語 ١٢__', 'a/b\\c:d', `x${LONE}y`, '😀 emoji', 'Ｆｕｌｌ', 'tab\there', '', 'ok-name_1']
const SEGMENTS = ['', '.', '..', '...', 'a/b', 'a\\b', 'my-file_1.json', 'キーボード設定', 'a b', 'a(1).json', 'e1.pipette', 'é', 'a'.repeat(64), 'a'.repeat(65), '../evil', 'uid-1_abc', '\u0001']
const TIMES = [0, ms(0), ms(0) + 123, -1, 253402300800000, 8.64e15]

function safeFilenameCases(): unknown {
  return {
    safeFilename: SAFE_NAMES.map((name) => ({ name, out: safeFilename(name, 'fallback') })),
    segments: SEGMENTS.map((value) => ({
      value, segment: isSafePathSegment(value), key: isSafeKey(value), path: isSafePath(value), packId: isSafePackId(value),
    })),
    timestamps: TIMES.map((t) => ({ ms: t, filename: tsForFilename(new Date(t)), export: tsForExportFilename(new Date(t)) })),
  }
}

const IDS = [UUID, 'a', 'b_a', '日本', 'x1', LONE, '😀', '', 'A-z9']
const LONG_SNAPSHOT = `${'K'.repeat(240 - TS.length - '_.pipette'.length)}_${TS}.pipette`
const FILENAMES = [
  'legacy_1.json', 'macro_2025_ab12cd34.json', `kb_${TS}.pipette`, `${UUID}_2025.json`, `x_${UUID}.json`, 'a_b.json',
  'noext', '.hidden', 'dir.d/name', 'packs/a.json', `packs/${UUID}.json`, 'x_b_a.json', 'x_x0062005f0061.json',
  `ctl\u0001\u001f\u007f_x.json`, `a${LONE}_${LONE}.json`, '', '_', '.json',
]

/** Names past MAX_BODY_FILENAME_BYTES once the id goes in, run with fewer ids. */
const LONG_FILENAMES = [
  LONG_SNAPSHOT, `${'日本語'.repeat(80)}_${TS}.pipette`, `${'😀'.repeat(60)}_${TS}.pipette`, `${'é_'.repeat(80)}_${TS}.pipette`,
  `${'b'.repeat(300)}.json`, `${'a. '.repeat(70)}_${TS}.json`, `_${'z'.repeat(250)}.json`, `${LONE.repeat(70)}_tail.json`,
  `${'é'.repeat(130)}.pipette`,
]
const LONG_IDS = [UUID, 'b_a', LONE]

/** One store per filename rule (suffix, prefix, fixed); `storeGroups`
 *  records which rule every store has. */
const RULE_STORES: EntryStore[] = ['favorites', 'keyLabels', 'i18nPacks']

function bodyFilenameCases(): unknown {
  const pairs = [
    ...IDS.flatMap((id) => FILENAMES.map((filename) => [id, filename])),
    ...LONG_IDS.flatMap((id) => LONG_FILENAMES.map((filename) => [id, filename])),
  ]
  const cases: unknown[] = []
  for (const [id, filename] of pairs) {
    {
      const perStore = RULE_STORES.map((store) => ({ store, hasId: bodyFilenameHasId(store, id, filename), named: idBodyFilename(store, id, filename) }))
      cases.push({ id, filename, perStore })
    }
  }
  return { segments: IDS.map((id) => ({ id, segment: idFilenameSegment(id) })), cases }
}

// ---- Canonical JSON and hashes ----

const CANONICAL_TEXTS = [
  'null', '1', '"s"', '[]', '{}', '{"b":1,"a":{"c":[{"z":1,"y":2}]}}', '{"b":1,"10":2,"9":3,"a":null}',
  '{"__proto__":{"x":1},"a":1}', '{"__proto__":5,"b":[{"__proto__":null,"c":1}]}', '{"é":1,"e":2,"😀":3,"\\uffff":4,"Z":5}',
  '{"\\ud800":1,"a":2}', '{"a":1,"a":2,"b":-0,"c":1e21}', '[{"b":1,"a":2},[3,{"d":4,"c":5}]]',
]

const HASH_TEXTS = ['', 'body', '{"data":1}', '日本語😀', `a${LONE}b`]

// ---- Entries ----

const HUB_PRIVATE = { id: 'p', url: '/p?token=x', expiresAt: null }

/** Raw index entries, as JSON texts, read under every store. */
const RAW_ENTRIES: string[] = [
  // v1, every field.
  JSON.stringify({ id: 'f', label: 'L', name: 'N', savedAt: T(1), filename: 'f.json', updatedAt: T(2), hubPostId: 'h', hubPrivate: HUB_PRIVATE, enabled: true, vilVersion: 2 }),
  // v1 without updatedAt; v1 tombstones (savedAt after / before deletedAt).
  JSON.stringify({ id: 'a', name: 'A', filename: 'a_1.json', savedAt: T(1) }),
  JSON.stringify({ id: 'f', label: 'L', savedAt: T(6), filename: 'f.json', updatedAt: T(6), deletedAt: T(5) }),
  JSON.stringify({ id: 'f', label: 'L', savedAt: T(1), filename: 'f.json', deletedAt: T(5) }),
  // v2 entries: valid, written by a v1 app afterwards, deleted, revived.
  JSON.stringify({ id: 'v', label: 'L', filename: 'v.json', savedAt: T(1), clocks: { created: T(1), body: T(1), name: T(3), hub: T(4) }, updatedAt: T(4) }),
  JSON.stringify({ id: 'v', label: 'R', filename: 'v.json', savedAt: T(1), clocks: { created: T(1), body: T(1), name: T(3), hub: T(4), enabled: T(2) }, updatedAt: T(7) }),
  JSON.stringify({ id: 'v', filename: 'v.json', savedAt: T(1), clocks: { body: T(1), created: T(6) }, deletedAt: T(5), updatedAt: T(6) }),
  JSON.stringify({ id: 'v', filename: 'v.json', savedAt: T(1), clocks: { created: T(1), body: T(1), name: T(1) }, deletedAt: T(6), updatedAt: T(6) }),
  // Future clocks: year 9999, the last date, past the last date.
  JSON.stringify({ id: 'z', label: 'L', filename: 'z.json', savedAt: '9999-12-31T23:59:59.999Z', clocks: { created: T(1), body: MAX_ISO, name: NEAR_MAX_ISO, hub: '+275760-09-13T00:00:00.001Z' }, updatedAt: MAX_ISO }),
  JSON.stringify({ id: 'z', label: 'L', filename: 'z.json', savedAt: T(1), updatedAt: MAX_ISO, deletedAt: MAX_ISO }),
  JSON.stringify({ id: 'z', name: 'N', filename: 'z.json', savedAt: '+010000-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00+09:00' }),
  // Broken clocks and markers.
  JSON.stringify({ id: 'b', label: 'L', filename: 'b.json', savedAt: T(1), clocks: { created: 42, body: 'garbage', name: null, enabled: T(5), extra: T(9) } }),
  JSON.stringify({ id: 'b', label: 'L', filename: 'b.json', savedAt: T(1), clocks: 'x', deletedAt: null }),
  JSON.stringify({ id: 'b', label: 'L', filename: 'b.json', savedAt: 5, updatedAt: 'garbage', clocks: [1], deletedAt: 'bad' }),
  JSON.stringify({ id: 'b', clocks: null }),
  JSON.stringify({ id: '' }),
  // Unknown fields, array-index keys, a __proto__ key, a lone surrogate.
  '{"9":1,"zeta":true,"id":"u","updatedAt":"2026-01-01T00:00:02.000Z","label":"L","savedAt":"2026-01-01T00:00:01.000Z","extra":{"b":1,"a":2},"0":[]}',
  '{"id":"p","__proto__":{"x":1},"label":"L","savedAt":"2026-01-01T00:00:01.000Z","summary":"s"}',
  `{"id":"\\ud800","label":"\\udc00x","filename":"a\\ud800.json","savedAt":"2026-01-01T00:00:01.000Z","hubPostId":"\\ud83d"}`,
  JSON.stringify({ id: 'n', name: 'N', wordCount: 3, lineCount: 1, source: { provider: 'p', workId: 'w' }, version: '1', coverage: { totalKeys: 2, coveredKeys: 1 }, dangerousKeyCount: 0, startedAt: T(0), uploaderName: 'u', hubUpdatedAt: T(0), filename: 'n.json', savedAt: T(1), updatedAt: T(2) }),
]

const NOW = [ms(9), ms(-30)]
const SET_CLOCKS = [T(4), MAX_ISO, 'garbage']

function normalizeCases(): unknown {
  return RAW_ENTRIES.map((text) => ({
    text,
    perStore: STORES.map((store) => {
      const raw = JSON.parse(text) as Meta
      const def = STORE_GROUPS[store]
      return {
        store,
        normalized: JSON.stringify(normalizeEntry(store, raw as never)),
        bodyFields: bodyFieldsOf(def, raw),
        groups: GROUPS.map((g) => JSON.stringify(groupValues(def, raw, g))),
        canonical: GROUPS.map((g) => canonicalJson(groupValues(def, raw, g))),
      }
    }),
  }))
}

const ENTRY_LISTS = [
  'null', '{}', '[]', `[${RAW_ENTRIES[0]},null,3,{"name":"no id"},{"id":1},[1],"x",${RAW_ENTRIES[4]}]`,
]

/** The raw entries the clock writers run on (read as favorites entries):
 *  v1, v2, deleted, future clocks, broken clocks and unknown fields. */
const WRITER_ENTRIES = [0, 2, 4, 6, 8, 9, 13, 16, 18].map((i) => RAW_ENTRIES[i])

/** The clock writers over each of WRITER_ENTRIES. */
function writerCases(): unknown {
  const cases: unknown[] = []
  for (const text of WRITER_ENTRIES) {
    const entry = normalizeEntry('favorites', JSON.parse(text)) as unknown as Clocked
    const ops: Record<string, unknown> = {}
    for (const group of GROUPS) {
      ops[`touch:${group}`] = NOW.map((now) => outcome(() => touchClock(entry, group, new Date(now))))
      ops[`set:${group}`] = SET_CLOCKS.map((iso) => outcome(() => setClock(entry, group, iso)))
    }
    ops.markDeleted = NOW.map((now) => outcome(() => markDeleted(entry, new Date(now))))
    // Revives the entry deleted at ms(7) (`reviveDeletedAt`).
    ops.revive = NOW.map((now) => outcome(() => reviveEntry(markDeleted(entry, new Date(ms(7))), new Date(now))))
    ops.reviveLive = NOW.map((now) => outcome(() => reviveEntry(entry, new Date(now))))
    ops.derived = derivedUpdatedAt(entry.clocks, entry.deletedAt)
    cases.push({ text, ops })
  }
  return cases
}

const NEXT_FIELDS: Record<string, string> = {
  same: '{"id":"e","label":"L","name":"N","filename":"e_1.json","savedAt":"2026-01-01T00:00:01.000Z","hubPostId":"h","enabled":true,"version":"1"}',
  renamed: '{"id":"e","label":"L2","name":"N2","filename":"e_1.json","savedAt":"2026-01-01T00:00:01.000Z","hubPostId":"h","enabled":true,"version":"1"}',
  hubAndEnabled: '{"id":"e","label":"L","name":"N","filename":"e_1.json","savedAt":"2026-01-01T00:00:01.000Z","hubPostId":"h2","hubUpdatedAt":"2026-01-01T00:00:09.000Z","enabled":false,"version":"1"}',
  reordered: '{"version":"2","enabled":true,"hubPostId":"h","savedAt":"2026-01-01T00:00:01.000Z","filename":"e_2.json","name":"N","label":"L","id":"e","clocks":{"created":"2026-01-01T00:00:00.000Z"},"deletedAt":"2026-01-01T00:00:00.000Z","updatedAt":"x","5":"five"}',
}

const EXISTING: Record<string, string | null> = {
  none: null,
  live: NEXT_FIELDS.same,
  deleted: '{"id":"e","label":"L","name":"N","filename":"e_1.json","savedAt":"2026-01-01T00:00:01.000Z","hubPostId":"h","enabled":true,"version":"1","deletedAt":"2026-01-01T00:00:03.000Z"}',
  deletedAhead: '{"id":"e","label":"L","name":"N","filename":"e_1.json","savedAt":"2026-01-01T00:00:01.000Z","hubPostId":"h","enabled":true,"version":"1","clocks":{"created":"2026-01-01T00:00:01.000Z","body":"2026-01-01T00:00:01.000Z"},"deletedAt":"2026-01-01T00:01:40.000Z"}',
  atMax: `{"id":"e","label":"L","name":"N","filename":"e_1.json","savedAt":"2026-01-01T00:00:01.000Z","clocks":{"created":"${MAX_ISO}","body":"${MAX_ISO}","name":"${MAX_ISO}"},"deletedAt":"${MAX_ISO}"}`,
}

const OPTIONS = [
  { body: true, explicit: true }, { body: true, explicit: false }, { body: false, explicit: true }, { body: false, explicit: false },
]

function writeCases(): unknown {
  const create = STORES.map((store) => ({
    store,
    created: Object.values(NEXT_FIELDS).map((text) => JSON.stringify(createEntry(store, JSON.parse(text), new Date(ms(9))))),
    builtin: Object.values(NEXT_FIELDS).map((text) => JSON.stringify(builtinEntry(store, JSON.parse(text)))),
  }))
  const overwrite: unknown[] = []
  // One store per shape of groups: hashed suffix bodies, prefix bodies
  // without a hub, packs with enabled, no meta groups at all.
  for (const store of ['favorites', 'snapshots', 'typingTestTexts', 'i18nPacks', 'runLogs'] as EntryStore[]) {
    for (const [existingName, existingText] of Object.entries(EXISTING)) {
      const existing = existingText === null ? undefined : (normalizeEntry(store, JSON.parse(existingText)) as unknown as Clocked)
      for (const [nextName, nextText] of Object.entries(NEXT_FIELDS)) {
        const results = OPTIONS.map((options) => outcome(() => overwriteEntry(store, existing, JSON.parse(nextText) as Meta, new Date(ms(9)), options)))
        overwrite.push({ store, existing: existingName, next: nextName, results })
      }
    }
  }
  return { now: ms(9), existing: EXISTING, next: NEXT_FIELDS, options: OPTIONS, create, overwrite }
}

/** Each mutation sets `set` (a JSON object text) on the copy first. */
const MUTATIONS = [
  { id: 'a', group: 'name', set: '{"name":"B"}' },
  { id: 'a', group: 'hub', set: '{"hubPostId":"p","uploaderName":"u"}' },
  { id: 'a', group: 'enabled', set: '{}' },
  { id: 'a', group: 'delete', set: '{}' },
  { id: 'b', group: 'name', set: '{"name":"C","extra":1}' },
  { id: 'missing', group: 'hub', set: '{}' },
  { id: 'max', group: 'name', set: '{"name":"D"}' },
  { id: 'max', group: 'delete', set: '{}' },
] as const

function mutationCases(): unknown {
  const start = [
    '{"id":"a","name":"A","filename":"a_1.json","savedAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
    '{"id":"b","name":"B","filename":"b_1.json","savedAt":"2026-01-01T00:00:00.000Z","deletedAt":"2026-01-01T00:00:01.000Z"}',
    `{"id":"max","name":"M","filename":"m_1.json","savedAt":"2026-01-01T00:00:00.000Z","clocks":{"created":"${MAX_ISO}","body":"${MAX_ISO}","name":"${MAX_ISO}"}}`,
  ]
  const entries = normalizeEntries('keyLabels', start.map((text) => JSON.parse(text))) as unknown as Clocked[]
  const before = JSON.stringify(entries)
  const steps = MUTATIONS.map((m) => {
    const result = outcome(() => applyEntryMutation(entries, m.id, m.group, new Date(ms(9)), (e) => Object.assign(e, JSON.parse(m.set))) ?? null)
    return { ...m, result, entries: JSON.stringify(entries) }
  })
  return { now: ms(9), start: before, steps }
}

describe('entry store fixtures', () => {
  it('records the entry clock, write and file-name helpers over their input tables', () => {
    const fixture = {
      storeGroups: STORES.map((store) => ({ store, ...STORE_GROUPS[store] })),
      dates: dateCases(),
      utf8: utf8Cases(),
      safeFilename: safeFilenameCases(),
      bodyFilenames: bodyFilenameCases(),
      canonical: CANONICAL_TEXTS.map((text) => ({ text, out: canonicalJson(JSON.parse(text)) })),
      bodyHash: HASH_TEXTS.map((text) => ({ text, hash: bodyHash(text) })),
      newClocks: { now: ms(3), cases: STORES.map((store) => ({ store, clocks: JSON.stringify(newClocks(store, new Date(ms(3)))) })) },
      normalize: normalizeCases(),
      normalizeEntries: STORES.flatMap((store) => ENTRY_LISTS.map((text) => ({ store, text, out: JSON.stringify(normalizeEntries(store, JSON.parse(text))) }))),
      writers: { now: NOW, setClocks: SET_CLOCKS, reviveDeletedAt: ms(7), cases: writerCases() },
      writes: writeCases(),
      mutations: mutationCases(),
    }
    writeJsonFixture(OUT, fixture)
    // The local date-time forms are read as UTC only when TZ is UTC.
    expect(clockMs('2026-01-01T00:00:00')).toBe(ms(0))
  })
})
