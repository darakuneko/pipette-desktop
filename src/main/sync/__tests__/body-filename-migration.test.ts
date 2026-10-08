// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { migrateBodyFilenames } from '../body-filename-migration'
import type { BaseEntryMeta } from '../entry-clocks'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'body-filename-migration-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function entry(id: string, filename: string, extra: Partial<BaseEntryMeta> = {}): BaseEntryMeta {
  return { id, filename, savedAt: '2026-01-01T00:00:00.000Z', ...extra }
}

describe('migrateBodyFilenames', () => {
  it('copies a legacy file shared by two ids to each id, then removes it', async () => {
    await writeFile(join(dir, 'macro_ts_ab12.json'), 'BODY')
    const entries = [entry('id1', 'macro_ts_ab12.json'), entry('id2', 'macro_ts_ab12.json')]
    const persist = vi.fn(async () => {
      // The index is written while the legacy file still exists.
      expect(await readFile(join(dir, 'macro_ts_ab12.json'), 'utf-8')).toBe('BODY')
    })

    expect(await migrateBodyFilenames('favorites', dir, entries, persist)).toBe(true)

    expect(persist).toHaveBeenCalledTimes(1)
    expect(entries.map((e) => e.filename)).toEqual(['macro_ts_ab12_id1.json', 'macro_ts_ab12_id2.json'])
    expect(await readFile(join(dir, 'macro_ts_ab12_id1.json'), 'utf-8')).toBe('BODY')
    expect(await readFile(join(dir, 'macro_ts_ab12_id2.json'), 'utf-8')).toBe('BODY')
    expect((await readdir(dir)).sort()).toEqual(['macro_ts_ab12_id1.json', 'macro_ts_ab12_id2.json'])
  })

  it('keeps a legacy file another entry still names under that name', async () => {
    // `abc` names its own body in the prefix form and keeps it; `other`
    // gets a copy.
    const entries = [entry('abc', 'abc_x.json'), entry('other', 'abc_x.json')]
    await writeFile(join(dir, 'abc_x.json'), 'SHARED')

    await migrateBodyFilenames('keyLabels', dir, entries, async () => {})

    expect(entries.map((e) => e.filename)).toEqual(['abc_x.json', 'other_abc_x.json'])
    expect(await readFile(join(dir, 'abc_x.json'), 'utf-8')).toBe('SHARED')
    expect(await readFile(join(dir, 'other_abc_x.json'), 'utf-8')).toBe('SHARED')
  })

  it('renames a tombstone whose body file is gone without failing', async () => {
    const entries = [entry('t', 'gone.json', { deletedAt: '2026-01-02T00:00:00.000Z' })]
    expect(await migrateBodyFilenames('analyzeFilters', dir, entries, async () => {})).toBe(true)
    expect(entries[0].filename).toBe('gone_t.json')
  })

  it('does nothing when every name already carries its id (idempotent)', async () => {
    await writeFile(join(dir, 'a_ts_ab.json'), 'BODY')
    const entries = [entry('id1', 'a_ts_ab.json')]
    await migrateBodyFilenames('favorites', dir, entries, async () => {})

    const persist = vi.fn(async () => {})
    expect(await migrateBodyFilenames('favorites', dir, entries, persist)).toBe(false)
    expect(persist).not.toHaveBeenCalled()
    expect(await readdir(dir)).toEqual(['a_ts_ab_id1.json'])
  })

  it('leaves the legacy file in place when writing the index fails', async () => {
    await writeFile(join(dir, 'old.json'), 'BODY')
    const entries = [entry('id1', 'old.json')]
    await expect(migrateBodyFilenames('favorites', dir, entries, async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    expect(await readFile(join(dir, 'old.json'), 'utf-8')).toBe('BODY')
  })

  it('skips unsafe filenames', async () => {
    const entries = [entry('id1', '../evil.json')]
    expect(await migrateBodyFilenames('favorites', dir, entries, async () => {})).toBe(false)
    expect(entries[0].filename).toBe('../evil.json')
  })
})
