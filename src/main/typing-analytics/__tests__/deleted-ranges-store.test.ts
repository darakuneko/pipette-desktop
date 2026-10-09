// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

vi.mock('../../logger', () => ({ log: vi.fn() }))

import {
  bundleDeletedRanges,
  readDeletedRanges,
  readDeletedRangesSync,
  updateDeletedRanges,
} from '../deleted-ranges-store'
import { unionDeletedRanges, type DeletedRangeEntry } from '../deleted-ranges'
import { deletedRangesPath, listDeletedRangesHashes } from '../jsonl/paths'
import { withWriteLock } from '../../per-uid-write-lock'
import { typingDeletedRangesSyncUnit } from '../sync'

const UID = 'kb'
const HASH = 'hash-r'
const entry = (id: string, cutoffMs = 100): DeletedRangeEntry => ({ id, startMs: 0, endMs: 50, cutoffMs })

let userData = ''

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'deleted-ranges-store-'))
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

async function writeRaw(content: string, hash = HASH): Promise<void> {
  const path = deletedRangesPath(userData, UID, hash)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf-8')
}

describe('paths', () => {
  it('places the file next to the device day files', () => {
    expect(deletedRangesPath(userData, UID, HASH))
      .toBe(join(userData, 'sync', 'keyboards', UID, 'devices', HASH, 'deleted-ranges.json'))
  })

  it('lists the hashes that have a deleted-ranges file', async () => {
    await writeRaw('{}', 'h2')
    await writeRaw('{}', 'h1')
    await mkdir(join(userData, 'sync', 'keyboards', UID, 'devices', 'h3'), { recursive: true })
    expect(await listDeletedRangesHashes(userData, UID)).toEqual(['h1', 'h2'])
    expect(await listDeletedRangesHashes(userData, 'missing')).toEqual([])
  })
})

describe('readDeletedRanges', () => {
  it('returns no entries for a missing file', async () => {
    expect(await readDeletedRanges(userData, UID, HASH)).toEqual([])
    expect(readDeletedRangesSync(userData, UID, HASH)).toEqual([])
  })

  it('drops invalid entries', async () => {
    await writeRaw(JSON.stringify({ version: 1, entries: [entry('a'), { id: 1 }] }))
    expect(await readDeletedRanges(userData, UID, HASH)).toEqual([entry('a')])
    expect(readDeletedRangesSync(userData, UID, HASH)).toEqual([entry('a')])
  })

  it('throws on an unreadable file; the sync read treats it as empty', async () => {
    await writeRaw('{not json')
    await expect(readDeletedRanges(userData, UID, HASH)).rejects.toThrow()
    expect(readDeletedRangesSync(userData, UID, HASH)).toEqual([])
    await writeRaw(JSON.stringify({ version: 1, entries: 'x' }))
    await expect(readDeletedRanges(userData, UID, HASH)).rejects.toThrow()
  })
})

describe('updateDeletedRanges', () => {
  it('writes the union and returns it', async () => {
    const result = await updateDeletedRanges(userData, UID, HASH, (local) => unionDeletedRanges(local, [entry('a')]))
    expect(result.localChanged).toBe(true)
    expect(JSON.parse(await readFile(deletedRangesPath(userData, UID, HASH), 'utf-8')))
      .toEqual({ version: 1, entries: [entry('a')] })
  })

  it('does not create the file when nothing changes', async () => {
    const result = await updateDeletedRanges(userData, UID, HASH, (local) => unionDeletedRanges(local, []))
    expect(result.localChanged).toBe(false)
    expect(existsSync(join(userData, 'sync'))).toBe(false)
  })

  it('refuses to overwrite an unreadable local file', async () => {
    await writeRaw('{not json')
    await expect(updateDeletedRanges(userData, UID, HASH, (local) => unionDeletedRanges(local, [entry('a')]))).rejects.toThrow()
    expect(await readFile(deletedRangesPath(userData, UID, HASH), 'utf-8')).toBe('{not json')
  })

  it('keeps every entry of concurrent updates', async () => {
    await Promise.all(['a', 'b', 'c'].map((id) =>
      updateDeletedRanges(userData, UID, HASH, (local) => unionDeletedRanges(local, [entry(id)]))))
    expect((await readDeletedRanges(userData, UID, HASH)).map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('runs under the lock keyed by the unit name', async () => {
    let release!: () => void
    const held = withWriteLock(typingDeletedRangesSyncUnit(UID, HASH), () => new Promise<void>((r) => { release = r }))
    let done = false
    const update = updateDeletedRanges(userData, UID, HASH, (local) => unionDeletedRanges(local, [entry('a')]))
      .then(() => { done = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    release()
    await held
    await update
    expect(done).toBe(true)
  })
})

describe('bundleDeletedRanges', () => {
  it('returns the validated file content, or null when missing or unreadable', async () => {
    expect(await bundleDeletedRanges(userData, UID, HASH)).toBeNull()
    await writeRaw(JSON.stringify({ version: 1, entries: [entry('a'), { bad: true }] }))
    expect(JSON.parse((await bundleDeletedRanges(userData, UID, HASH))!)).toEqual({ version: 1, entries: [entry('a')] })
    await writeRaw('garbage')
    expect(await bundleDeletedRanges(userData, UID, HASH)).toBeNull()
  })
})
