// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  deletedRangeForAll,
  deletedRangesForLocalDays,
  isDeletedRangeEntry,
  parseDeletedRangesFile,
  serializeDeletedRanges,
  unionDeletedRanges,
  type DeletedRangeEntry,
} from '../deleted-ranges'
import { localDayRangeMs } from '../../../shared/local-day-range'

const entry = (id: string, cutoffMs = 100, startMs = 0, endMs = 50): DeletedRangeEntry => ({ id, startMs, endMs, cutoffMs })

describe('isDeletedRangeEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(isDeletedRangeEntry(entry('a'))).toBe(true)
  })

  it.each([
    ['null', null],
    ['no id', { startMs: 0, endMs: 1, cutoffMs: 1 }],
    ['empty id', { id: '', startMs: 0, endMs: 1, cutoffMs: 1 }],
    ['long id', { id: 'x'.repeat(200), startMs: 0, endMs: 1, cutoffMs: 1 }],
    ['empty range', { id: 'a', startMs: 5, endMs: 5, cutoffMs: 1 }],
    ['negative start', { id: 'a', startMs: -1, endMs: 5, cutoffMs: 1 }],
    ['fractional', { id: 'a', startMs: 0.5, endMs: 5, cutoffMs: 1 }],
    ['string time', { id: 'a', startMs: '0', endMs: 5, cutoffMs: 1 }],
    ['infinite cutoff', { id: 'a', startMs: 0, endMs: 5, cutoffMs: Infinity }],
    ['negative cutoff', { id: 'a', startMs: 0, endMs: 5, cutoffMs: -1 }],
  ])('rejects %s', (_label, value) => {
    expect(isDeletedRangeEntry(value)).toBe(false)
  })
})

describe('parseDeletedRangesFile', () => {
  it('keeps valid entries, drops invalid ones and duplicate ids', () => {
    const parsed = parseDeletedRangesFile({
      version: 1,
      entries: [entry('a'), { id: 'bad' }, entry('a', 999), entry('b', 5)],
    })
    expect(parsed).toEqual([entry('b', 5), entry('a')])
  })

  it.each([
    ['null', null],
    ['array', []],
    ['no entries', { version: 1 }],
    ['entries not array', { version: 1, entries: {} }],
    ['other version', { version: 2, entries: [] }],
  ])('returns null for a broken shape: %s', (_label, value) => {
    expect(parseDeletedRangesFile(value)).toBeNull()
  })

  it('round-trips through serializeDeletedRanges', () => {
    const entries = [entry('a', 1), entry('b', 2)]
    expect(parseDeletedRangesFile(JSON.parse(serializeDeletedRanges(entries)))).toEqual(entries)
    expect(JSON.parse(serializeDeletedRanges(entries))).toEqual({ version: 1, entries })
  })
})

describe('unionDeletedRanges', () => {
  it('unions by id, keeps the local copy of a shared id and sorts by (cutoffMs, id)', () => {
    const result = unionDeletedRanges([entry('b', 2), entry('a', 9)], [entry('a', 1, 0, 10), entry('c', 2)])
    expect(result.entries).toEqual([entry('b', 2), entry('c', 2), entry('a', 9)])
    expect(result.localChanged).toBe(true)
    expect(result.remoteNeedsUpdate).toBe(true)
  })

  it('reports no change when both sides hold the same ids', () => {
    const result = unionDeletedRanges([entry('a')], [entry('a')])
    expect(result).toEqual({ entries: [entry('a')], localChanged: false, remoteNeedsUpdate: false })
  })

  it('needs an upload only when local holds an id the other side lacks', () => {
    expect(unionDeletedRanges([entry('a'), entry('b')], [entry('a')]))
      .toMatchObject({ localChanged: false, remoteNeedsUpdate: true })
    expect(unionDeletedRanges([entry('a')], [entry('a'), entry('b')]))
      .toMatchObject({ localChanged: true, remoteNeedsUpdate: false })
  })
})

describe('deletedRangesForLocalDays', () => {
  let n = 0
  const newId = (): string => `id-${++n}`

  it('joins adjacent local days into one range and keeps gaps apart', () => {
    n = 0
    const entries = deletedRangesForLocalDays(['2026-04-03', '2026-04-01', '2026-04-02', '2026-04-05', '2026-04-02'], 777, newId)
    expect(entries).toEqual([
      { id: 'id-1', startMs: localDayRangeMs('2026-04-01')!.startMs, endMs: localDayRangeMs('2026-04-03')!.endMs, cutoffMs: 777 },
      { id: 'id-2', startMs: localDayRangeMs('2026-04-05')!.startMs, endMs: localDayRangeMs('2026-04-05')!.endMs, cutoffMs: 777 },
    ])
  })

  it('returns no entries for no days', () => {
    expect(deletedRangesForLocalDays([], 1, newId)).toEqual([])
  })

  it('throws on a value that is not a date', () => {
    expect(() => deletedRangesForLocalDays(['2026-4-1'], 1, newId)).toThrow(RangeError)
  })
})

describe('deletedRangeForAll', () => {
  it('covers everything up to and including the cutoff', () => {
    expect(deletedRangeForAll(500, 'x')).toEqual({ id: 'x', startMs: 0, endMs: 501, cutoffMs: 500 })
  })
})
