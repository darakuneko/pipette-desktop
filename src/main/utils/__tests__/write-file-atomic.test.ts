// SPDX-License-Identifier: GPL-2.0-or-later
//
// writeFileAtomic's rename-failure cleanup — the `.tmp` file must not
// survive a failed rename, and the original error must still
// propagate to the caller.

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
    vi.mocked(rename).mockClear()
    vi.mocked(writeFile).mockClear()
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

  it('writes binary content byte-for-byte', async () => {
    const target = join(dir, 'out.enc')
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xc3, 0x28])
    await writeFileAtomic(target, bytes)

    expect(Buffer.compare(await readFile(target), bytes)).toBe(0)
    expect(await readdir(dir)).toEqual(['out.enc'])
  })

  it('uses a unique temp name per call, next to the target', async () => {
    const target = join(dir, 'out.json')
    await writeFileAtomic(target, 'a')
    await writeFileAtomic(target, 'b')

    const tmpPaths = vi.mocked(writeFile).mock.calls.map((call) => call[0] as string)
    expect(tmpPaths).toHaveLength(2)
    expect(tmpPaths[0]).not.toBe(tmpPaths[1])
    for (const tmpPath of tmpPaths) {
      expect(tmpPath.startsWith(`${target}.${process.pid}.`)).toBe(true)
      expect(tmpPath.endsWith('.tmp')).toBe(true)
    }
  })

  it('concurrent writes to the same path all succeed and leave no temp file', async () => {
    const target = join(dir, 'out.json')
    const contents = Array.from({ length: 8 }, (_, i) => `content-${i}`)

    await Promise.all(contents.map((c) => writeFileAtomic(target, c)))

    expect(contents).toContain(await readFile(target, 'utf-8'))
    expect(await readdir(dir)).toEqual(['out.json'])
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
