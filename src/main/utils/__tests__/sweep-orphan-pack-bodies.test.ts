// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared-body coverage for `sweepOrphanFiles`, extracted from
// i18n-pack-store.ts/theme-pack-store.ts's own sweepOrphans tests when
// the sweep body moved here (both stores now keep only a thin
// lock-behavior test of their own `runGcUnderLock`).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { sweepOrphanFiles } from '../sweep-orphan-pack-bodies'

describe('sweepOrphanFiles', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sweep-orphan-pack-bodies-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('removes a .json file with no matching entry in knownFileNames', async () => {
    await writeFile(join(dir, 'kept.json'), '{}', 'utf-8')
    await writeFile(join(dir, 'orphan.json'), '{}', 'utf-8')

    const removed = await sweepOrphanFiles(dir, new Set(['kept.json']))

    expect(removed).toBe(1)
    const remaining = await readdir(dir)
    expect(remaining).toContain('kept.json')
    expect(remaining).not.toContain('orphan.json')
  })

  it('is a no-op when every file has a matching known name', async () => {
    await writeFile(join(dir, 'kept.json'), '{}', 'utf-8')

    const removed = await sweepOrphanFiles(dir, new Set(['kept.json']))

    expect(removed).toBe(0)
  })

  it('ignores non-.json files even if unknown', async () => {
    await writeFile(join(dir, 'notes.txt'), 'hi', 'utf-8')

    const removed = await sweepOrphanFiles(dir, new Set())

    expect(removed).toBe(0)
    expect(await readdir(dir)).toContain('notes.txt')
  })

  it('returns 0 without throwing when packsDir does not exist', async () => {
    await rm(dir, { recursive: true, force: true })

    const removed = await sweepOrphanFiles(dir, new Set())

    expect(removed).toBe(0)
  })

  it('swallows a per-file unlink failure and still reports the ones that succeeded', async () => {
    // A directory named *.json can never be unlinked as a file — this
    // forces exactly the per-file catch the sweep relies on to keep
    // going past one bad entry instead of failing the whole sweep.
    await mkdir(join(dir, 'not-a-file.json'))
    await writeFile(join(dir, 'orphan.json'), '{}', 'utf-8')

    const removed = await sweepOrphanFiles(dir, new Set())

    expect(removed).toBe(1)
    expect(await readdir(dir)).toContain('not-a-file.json')
  })

  // N8: a stray `*.json.tmp` is always an orphan by construction — it's
  // the temp-file half of writeFileAtomic's temp-then-rename that never
  // got renamed (a crash between the write and the rename). Swept
  // unconditionally, not gated on `knownFileNames`.
  it('removes a stray *.json.tmp leftover unconditionally, even with an empty known set', async () => {
    await writeFile(join(dir, 'kept.json'), '{}', 'utf-8')
    await writeFile(join(dir, 'kept.json.tmp'), '{}', 'utf-8')

    const removed = await sweepOrphanFiles(dir, new Set(['kept.json']))

    expect(removed).toBe(1)
    const remaining = await readdir(dir)
    expect(remaining).toContain('kept.json')
    expect(remaining).not.toContain('kept.json.tmp')
  })
})
