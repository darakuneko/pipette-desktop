// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  EPOCH_ISO,
  bodyFilenameHasId,
  idBodyFilename,
  idFilenameSegment,
  MAX_BODY_FILENAME_BYTES,
  RESERVED_FIELDS,
  STORE_GROUPS,
  bodyFieldsOf,
  canonicalJson,
  clockMs,
  derivedUpdatedAt,
  groupValues,
  markDeleted,
  newClocks,
  normalizeEntry,
  reviveEntry,
  touchClock,
  type EntryStore,
  type StoreMetaMap,
} from '../entry-clocks'
import { utf8ByteLength } from '../../../shared/utils/utf8-truncate'

const T = (s: number): string => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString()

const hubPrivate = { id: 'p', url: '/p?token=x', expiresAt: null }

/** One meta per store with every optional field set. */
const FULL: { [S in EntryStore]: StoreMetaMap[S] } = {
  favorites: { id: 'f', label: 'L', savedAt: T(1), filename: 'f.json', updatedAt: T(2), hubPostId: 'h', hubPrivate },
  snapshots: { id: 's', label: 'L', filename: 's.pipette', savedAt: T(1), updatedAt: T(2), hubPostId: 'h', hubPrivate, vilVersion: 2 },
  analyzeFilters: { id: 'a', label: 'L', summary: 'x', filename: 'a.json', savedAt: T(1), updatedAt: T(2), hubPostId: 'h', hubPrivate },
  keyLabels: { id: 'k', name: 'N', uploaderName: 'u', hubPostId: 'h', hubUpdatedAt: T(0), filename: 'k.json', savedAt: T(1), updatedAt: T(2) },
  typingTestTexts: {
    id: 't', name: 'N', wordCount: 3, lineCount: 1, filename: 't.json', savedAt: T(1), updatedAt: T(2), source: { provider: 'p', workId: 'w' },
  },
  i18nPacks: {
    id: 'i', filename: 'i.json', name: 'N', version: '1.0.0', enabled: true, hubPostId: 'h', hubUpdatedAt: T(0), uploaderName: 'u',
    savedAt: T(1), updatedAt: T(2), appVersionAtImport: '1', matchedBaseVersion: '1', coverage: { totalKeys: 2, coveredKeys: 1 }, dangerousKeyCount: 0,
  },
  themePacks: { id: 'th', filename: 'th.json', name: 'N', version: '1', hubPostId: 'h', hubUpdatedAt: T(0), uploaderName: 'u', savedAt: T(1), updatedAt: T(2) },
  runLogs: { id: 'r', startedAt: T(0), filename: 'r.jsonl', savedAt: T(1), updatedAt: T(2) },
}

const STORES = Object.keys(FULL) as EntryStore[]

describe('STORE_GROUPS', () => {
  it.each(STORES)('%s: the body list is exactly the fields no other group claims', (store) => {
    const def = STORE_GROUPS[store]
    expect(bodyFieldsOf(def, FULL[store]).sort()).toEqual([...def.body].sort())
  })

  it.each(STORES)('%s: every meta field belongs to exactly one group or is reserved', (store) => {
    const def = STORE_GROUPS[store]
    const groups = [def.body, def.createdFields, def.name ?? [], def.hub ?? [], def.enabled ?? []]
    for (const key of Object.keys(FULL[store])) {
      const owners = groups.filter((g) => g.includes(key)).length
      expect(owners + (RESERVED_FIELDS.has(key) ? 1 : 0)).toBe(1)
    }
  })
})

describe('id-carrying body filenames', () => {
  const id = '0f8c2b1e-1111-4222-8333-944445555666'
  it.each([
    ['snapshots', `kb_2025-01-01T00-00-00_${id}.pipette`, 'kb_2025-01-01T00-00-00.pipette', `kb_2025-01-01T00-00-00_${id}.pipette`],
    ['favorites', `macro_2025_ab12cd34_${id}.json`, 'macro_2025_ab12cd34.json', `macro_2025_ab12cd34_${id}.json`],
    ['analyzeFilters', `2025_${id}.json`, '2025_99999999-aaaa-4bbb-8ccc-dddddddddddd.json', `2025_99999999-aaaa-4bbb-8ccc-dddddddddddd_${id}.json`],
    ['runLogs', `2025_${id}.json`, '2025_other.json', `2025_other_${id}.json`],
    ['keyLabels', `${id}_2025.json`, 'x.json', `${id}_x.json`],
    ['typingTestTexts', `${id}_2025.json`, 'x.json', `${id}_x.json`],
    ['i18nPacks', `packs/${id}.json`, 'packs/other.json', `packs/${id}.json`],
    ['themePacks', `packs/${id}.json`, 'x.json', `packs/${id}.json`],
  ] as const)('%s', (store, current, legacy, converted) => {
    expect(bodyFilenameHasId(store, id, current)).toBe(true)
    expect(idBodyFilename(store, id, current)).toBe(current)
    expect(bodyFilenameHasId(store, id, legacy)).toBe(false)
    expect(idBodyFilename(store, id, legacy)).toBe(converted)
    expect(bodyFilenameHasId(store, id, converted)).toBe(true)
  })

  it('a name with no extension gets the id at the end', () => {
    expect(idBodyFilename('favorites', 'a', 'noext')).toBe('noext_a')
  })

  it('ids outside [A-Za-z0-9-], or starting with x, are hex-encoded so no segment holds `_`', () => {
    expect(idFilenameSegment('abc-1')).toBe('abc-1')
    expect(idFilenameSegment('b_a')).toBe('x0062005f0061')
    expect(idFilenameSegment('x1')).toBe('x00780031')
    expect(idFilenameSegment('日本')).toBe('x65e5672c')
    expect(idFilenameSegment('ab')).not.toBe(idFilenameSegment('x6162'))
    expect(idFilenameSegment('\uD800')).toBe('xd800')
    expect(idFilenameSegment('\uD800')).not.toBe(idFilenameSegment('\uD801'))
    expect(idFilenameSegment('😀')).toBe('xd83dde00')
  })

  it('an id that is a suffix or prefix of another never owns its file', () => {
    const forBa = idBodyFilename('favorites', 'b_a', 'x.json')
    expect(forBa).toBe('x_x0062005f0061.json')
    expect(bodyFilenameHasId('favorites', 'a', forBa)).toBe(false)
    expect(bodyFilenameHasId('favorites', 'b_a', 'x_b_a.json')).toBe(false)
    expect(bodyFilenameHasId('favorites', 'a', 'x_b_a.json')).toBe(true)
    expect(bodyFilenameHasId('favorites', 'b', 'x_b-a.json')).toBe(false)
    expect(bodyFilenameHasId('keyLabels', 'a', 'a-b_2025.json')).toBe(false)
    expect(bodyFilenameHasId('keyLabels', 'a-b', 'a-b_2025.json')).toBe(true)
    expect(idBodyFilename('keyLabels', 'a_b', 'a_b_2025.json')).toBe('x0061005f0062_a_b_2025.json')
  })

  it('conversion is idempotent for every rule, also for encoded ids', () => {
    for (const store of STORES) {
      for (const sid of ['a', 'b_a', '日本', 'x1', '\uD800']) {
        const once = idBodyFilename(store, sid, 'legacy_1.json')
        expect(idBodyFilename(store, sid, once)).toBe(once)
        expect(bodyFilenameHasId(store, sid, once)).toBe(true)
      }
    }
  })
})

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}]},"b":1}')
  })
})

describe('clockMs', () => {
  it('treats non-strings and unparseable strings as 0', () => {
    expect(clockMs(42)).toBe(0)
    expect(clockMs(null)).toBe(0)
    expect(clockMs('garbage')).toBe(0)
    expect(clockMs(T(1))).toBe(Date.parse(T(1)))
  })
})

describe('normalizeEntry — v1 entries', () => {
  it('favorites: body = savedAt, meta = updatedAt', () => {
    const n = normalizeEntry('favorites', FULL.favorites)
    expect(n.clocks).toEqual({ created: T(1), body: T(1), name: T(2), hub: T(2) })
    expect(n.updatedAt).toBe(T(2))
  })

  it('snapshots and analyze filters: body = updatedAt ?? savedAt', () => {
    expect(normalizeEntry('snapshots', FULL.snapshots).clocks.body).toBe(T(2))
    expect(normalizeEntry('analyzeFilters', FULL.analyzeFilters).clocks.body).toBe(T(2))
    const { updatedAt: _u, ...noUpdated } = FULL.snapshots
    expect(normalizeEntry('snapshots', noUpdated).clocks).toEqual({ created: T(1), body: T(1), name: T(1), hub: T(1) })
  })

  it('key labels and texts: body = savedAt; texts have no hub clock', () => {
    expect(normalizeEntry('keyLabels', FULL.keyLabels).clocks).toEqual({ created: T(1), body: T(1), name: T(2), hub: T(2) })
    expect(normalizeEntry('typingTestTexts', FULL.typingTestTexts).clocks).toEqual({ created: T(1), body: T(1), name: T(2) })
  })

  it('run logs: no meta clocks; savedAt is a body field (a re-save by id rewrites it)', () => {
    expect(normalizeEntry('runLogs', FULL.runLogs).clocks).toEqual({ created: T(1), body: T(1) })
    expect(STORE_GROUPS.runLogs.body).toContain('savedAt')
  })

  it('packs: the index body clock starts at 0 (the body unit sets it)', () => {
    expect(normalizeEntry('i18nPacks', FULL.i18nPacks).clocks).toEqual({ created: T(1), body: EPOCH_ISO, name: T(2), hub: T(2), enabled: T(2) })
    expect(normalizeEntry('themePacks', FULL.themePacks).clocks).toEqual({ created: T(1), body: EPOCH_ISO, name: T(2), hub: T(2) })
  })

  it('keeps a tombstone and includes deletedAt in updatedAt', () => {
    const n = normalizeEntry('favorites', { ...FULL.favorites, deletedAt: T(9) })
    expect(n.deletedAt).toBe(T(9))
    expect(n.updatedAt).toBe(T(9))
  })

  it('does not modify its input', () => {
    const input = { ...FULL.favorites }
    normalizeEntry('favorites', input)
    expect(input).toEqual(FULL.favorites)
  })
})

describe('normalizeEntry — v2 entries', () => {
  const v2 = { ...FULL.favorites, clocks: { created: T(1), body: T(1), name: T(3), hub: T(4) }, updatedAt: T(4) }

  it('keeps valid clocks and rewrites updatedAt as their max', () => {
    const n = normalizeEntry('favorites', { ...v2, updatedAt: T(0) })
    expect(n.clocks).toEqual(v2.clocks)
    expect(n.updatedAt).toBe(T(4))
  })

  it('treats invalid clocks as 0 and drops groups the store does not have', () => {
    const { updatedAt: _u, ...noUpdated } = FULL.favorites
    const n = normalizeEntry('favorites', { ...noUpdated, clocks: { created: 42, body: 'garbage', name: null, enabled: T(5) } })
    expect(n.clocks).toEqual({ created: EPOCH_ISO, body: EPOCH_ISO })
  })

  it('a non-object clocks value is read as v1', () => {
    expect(normalizeEntry('favorites', { ...FULL.favorites, clocks: 'x' }).clocks).toEqual({ created: T(1), body: T(1), name: T(2), hub: T(2) })
  })

  it('an updatedAt newer than every clock (a v1 app wrote it) raises the meta clocks', () => {
    const n = normalizeEntry('favorites', { ...v2, label: 'renamed', updatedAt: T(7) })
    expect(n.clocks).toEqual({ created: T(1), body: T(1), name: T(7), hub: T(7) })
    expect(n.updatedAt).toBe(T(7))
  })

  it('a v1 app write on a snapshot also raises the body clock (v1 cannot tell a rename from an update)', () => {
    const snap = { ...FULL.snapshots, clocks: { created: T(1), body: T(1), name: T(1), hub: T(1) }, updatedAt: T(7) }
    expect(normalizeEntry('snapshots', snap).clocks).toEqual({ created: T(1), body: T(7), name: T(7), hub: T(7) })
  })

  it('a v1 app write never raises created or (for savedAt-rule stores) body', () => {
    const entry = { ...FULL.favorites, savedAt: T(8), updatedAt: T(8), clocks: { created: T(1), body: T(1), name: T(1), hub: T(1) } }
    expect(normalizeEntry('favorites', entry).clocks).toEqual({ created: T(1), body: T(1), name: T(8), hub: T(8) })
  })

  it('an entry written through derivedUpdatedAt is never read as a v1 write', () => {
    const entry = touchClock({ ...v2, deletedAt: T(3) }, 'name', new Date(T(9)))
    expect(normalizeEntry('favorites', entry).clocks).toEqual({ ...v2.clocks, name: T(9) })
  })

  it('an updatedAt equal to deletedAt is not read as a v1 write', () => {
    const entry = { ...v2, deletedAt: T(6), updatedAt: T(6) }
    expect(normalizeEntry('favorites', entry).clocks).toEqual(v2.clocks)
  })

  it('an invalid deletedAt counts as 0, so an entry with a later created is alive', () => {
    expect(normalizeEntry('favorites', { ...v2, deletedAt: 'bad' })).not.toHaveProperty('deletedAt')
    expect(normalizeEntry('favorites', { ...v2, clocks: { ...v2.clocks, created: 'bad' }, deletedAt: 'bad' }).deletedAt).toBe(EPOCH_ISO)
  })

  it('drops a stale deletedAt from an entry alive under the merge rule', () => {
    const n = normalizeEntry('favorites', { ...v2, clocks: { ...v2.clocks, created: T(6) }, deletedAt: T(5), updatedAt: T(6) })
    expect(n).not.toHaveProperty('deletedAt')
    expect(n.updatedAt).toBe(T(6))
  })

  it('a v1 tombstone never comes back: created is no later than deletedAt', () => {
    const v1 = normalizeEntry('favorites', { ...FULL.favorites, savedAt: T(6), deletedAt: T(5) })
    expect(v1).toMatchObject({ deletedAt: T(5), clocks: { created: T(5) } })
    expect(normalizeEntry('favorites', { ...FULL.favorites, deletedAt: T(5) }).clocks.created).toBe(T(1))
  })
})

describe('clock writers', () => {
  const base = normalizeEntry('favorites', FULL.favorites)

  it('touchClock sets one clock and rewrites updatedAt', () => {
    const e = touchClock(base, 'hub', new Date(T(9)))
    expect(e.clocks).toEqual({ ...base.clocks, hub: T(9) })
    expect(e.updatedAt).toBe(derivedUpdatedAt(e.clocks, undefined))
  })

  it('touching created past deletedAt revives; touching another group does not', () => {
    const dead = markDeleted(base, new Date(T(5)))
    expect(touchClock(dead, 'name', new Date(T(9))).deletedAt).toBe(T(5))
    expect(touchClock(dead, 'created', new Date(T(9)))).not.toHaveProperty('deletedAt')
  })

  it('touchClock moves a group 1 ms past its clock when now is behind', () => {
    const ahead = touchClock(base, 'name', new Date(T(50)))
    expect(touchClock(ahead, 'name', new Date(T(9))).clocks.name).toBe(new Date(Date.parse(T(50)) + 1).toISOString())
  })

  it('reviveEntry brings a tombstone back past a deletedAt that runs ahead, and leaves a live entry alone', () => {
    const dead = markDeleted(base, new Date(T(50)))
    const back = reviveEntry(dead, new Date(T(9)))
    expect(back).not.toHaveProperty('deletedAt')
    expect(back.clocks.created).toBe(new Date(Date.parse(T(50)) + 1).toISOString())
    expect(back.updatedAt).toBe(back.clocks.created)
    expect(reviveEntry(markDeleted(base, new Date(T(5))), new Date(T(9))).clocks.created).toBe(T(9))
    expect(reviveEntry(base, new Date(T(9)))).toBe(base)
  })

  it('newClocks starts every group the store has at now', () => {
    expect(newClocks('i18nPacks', new Date(T(3)))).toEqual({ created: T(3), body: T(3), name: T(3), hub: T(3), enabled: T(3) })
    expect(newClocks('runLogs', new Date(T(3)))).toEqual({ created: T(3), body: T(3) })
  })

  it('groupValues returns one group, the body being every unclaimed field', () => {
    expect(groupValues(STORE_GROUPS.snapshots, FULL.snapshots, 'body')).toEqual({ filename: 's.pipette', vilVersion: 2 })
    expect(groupValues(STORE_GROUPS.snapshots, FULL.snapshots, 'hub')).toEqual({ hubPostId: 'h', hubPrivate })
  })

  it('markDeleted never puts deletedAt before created', () => {
    const ahead = { ...base, clocks: { ...base.clocks, created: T(50) } }
    expect(markDeleted(ahead, new Date(T(9))).deletedAt).toBe(T(50))
  })
})

describe('idBodyFilename keeps a suffix-rule name within MAX_BODY_FILENAME_BYTES', () => {
  const ID = '0b9f6f1e-3c1a-4e0e-9d7a-2f1d5f6b8a90'
  const TS = '2026-03-15T14-35-29.037Z'
  const ID_PART = `_${ID}.pipette`

  it('cuts the device name of a 240-byte legacy snapshot name and keeps its timestamp, id and extension', () => {
    const legacy = `${'A'.repeat(240 - TS.length - '_.pipette'.length)}_${TS}.pipette`
    expect(utf8ByteLength(legacy)).toBe(240)
    const named = idBodyFilename('snapshots', ID, legacy)
    expect(utf8ByteLength(named)).toBeLessThanOrEqual(MAX_BODY_FILENAME_BYTES)
    expect(named.endsWith(`_${TS}${ID_PART}`)).toBe(true)
    expect(named.startsWith('AAAA')).toBe(true)
    expect(bodyFilenameHasId('snapshots', ID, named)).toBe(true)
    expect(idBodyFilename('snapshots', ID, named)).toBe(named)
  })

  it('never splits a multi-byte character or surrogate pair, and drops the separators the cut leaves', () => {
    for (const unit of ['日本語', '😀', 'é_']) {
      const legacy = `${unit.repeat(80)}_${TS}.pipette`
      const named = idBodyFilename('snapshots', ID, legacy)
      expect(utf8ByteLength(named)).toBeLessThanOrEqual(MAX_BODY_FILENAME_BYTES)
      const head = named.slice(0, -(`_${TS}${ID_PART}`).length)
      expect(head.length).toBeGreaterThan(0)
      expect(unit.repeat(80).startsWith(head)).toBe(true)
      expect(head).not.toMatch(/[_.\s]$/)
      expect(named).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    }
  })

  it('gives every device the same name for the same legacy name', () => {
    const legacy = `${'キーボード'.repeat(20)}_${TS}.pipette`
    expect(idBodyFilename('snapshots', ID, legacy)).toBe(idBodyFilename('snapshots', ID, legacy))
  })

  it('cuts the stem from its end when it has no `_` to keep the tail of', () => {
    const named = idBodyFilename('favorites', 'a', `${'b'.repeat(300)}.json`)
    expect(named).toBe(`${'b'.repeat(MAX_BODY_FILENAME_BYTES - '_a.json'.length)}_a.json`)
  })

  it('leaves a name within the limit as it was', () => {
    expect(idBodyFilename('snapshots', ID, `KB_${TS}.pipette`)).toBe(`KB_${TS}${ID_PART}`)
  })
})
