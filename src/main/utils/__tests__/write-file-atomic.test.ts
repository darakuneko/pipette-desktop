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
let realWriteFile: typeof import('node:fs/promises').writeFile

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) }
})

import { rename, writeFile } from 'node:fs/promises'
import { writeFileAtomic } from '../write-file-atomic'

describe('writeFileAtomic', () => {
  let dir = ''

  beforeEach(async () => {
    if (!realRename) {
      realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename
      realWriteFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile
    }
    dir = await mkdtemp(join(tmpdir(), 'write-file-atomic-test-'))
    vi.mocked(rename).mockImplementation(realRename)
    vi.mocked(writeFile).mockImplementation(realWriteFile)
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

  it('removes a leftover .tmp file and rethrows when the write itself fails partway (e.g. ENOSPC)', async () => {
    const target = join(dir, 'out.json')
    const writeError = new Error('ENOSPC: no space left on device')
    vi.mocked(writeFile).mockImplementationOnce(async (path) => {
      // A real ENOSPC-style failure can still leave a partially written
      // file on disk before the rejection — simulate that instead of
      // rejecting before anything ever reaches the filesystem.
      await realWriteFile(path as string, 'PARTIAL', 'utf-8')
      throw writeError
    })

    await expect(writeFileAtomic(target, '{"a":1}')).rejects.toBe(writeError)

    const entries = await readdir(dir)
    expect(entries).toEqual([])
  })
})
