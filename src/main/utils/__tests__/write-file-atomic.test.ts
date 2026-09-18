// SPDX-License-Identifier: GPL-2.0-or-later
//
// Task-irr-1: writeFileAtomic's rename-failure cleanup (plan §A9) —
// the `.tmp` file must not survive a failed rename, and the original
// error must still propagate to the caller.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let realRename: typeof import('node:fs/promises').rename

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, rename: vi.fn(actual.rename) }
})

import { rename } from 'node:fs/promises'
import { writeFileAtomic } from '../write-file-atomic'

describe('writeFileAtomic', () => {
  let dir = ''

  beforeEach(async () => {
    if (!realRename) {
      realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
    }
    dir = await mkdtemp(join(tmpdir(), 'write-file-atomic-test-'))
    vi.mocked(rename).mockImplementation(realRename)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes via temp-file-then-rename on success', async () => {
    const target = join(dir, 'out.json')
    await writeFileAtomic(target, '{"a":1}')

    expect(await readFile(target, 'utf-8')).toBe('{"a":1}')
    const entries = await readdir(dir)
    expect(entries).toEqual(['out.json'])
  })

  it('removes the leftover .tmp file and rethrows when rename fails', async () => {
    const target = join(dir, 'out.json')
    const renameError = new Error('rename failed')
    vi.mocked(rename).mockRejectedValueOnce(renameError)

    await expect(writeFileAtomic(target, '{"a":1}')).rejects.toBe(renameError)

    const entries = await readdir(dir)
    expect(entries).toEqual([])
  })
})
