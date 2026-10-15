// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the temp file names of the atomic writer in
// src-tauri/crates/pipette-fs. Each target name goes through the real
// writeFileAtomicSync of src/main/utils/write-file-atomic.ts with a fixed
// pid and fixed random bytes, and the temp file name it writes is recorded
// together with whether the orphan sweep pattern of
// src/main/utils/sweep-orphan-pack-bodies.ts matches it. The Rust writer
// must build the same names, and its names must match the same pattern.
//
// Run: pnpm run generate:fs-logger-fixtures

import { describe, it, expect, vi } from 'vitest'
import { basename, dirname, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const RANDOM_BYTES = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab]

const fs = vi.hoisted(() => ({ written: [] as string[] }))

vi.mock('node:crypto', () => ({
  randomBytes: (size: number) => Buffer.from(RANDOM_BYTES.slice(0, size)),
}))
// Only the writes under DIR (the writer's) are captured; the fixture
// itself is written for real.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const captured = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/d/sub/')
  return {
    ...real,
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      if (captured(args[0])) fs.written.push(args[0])
      else real.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      if (!captured(args[0])) real.renameSync(...args)
    },
  }
})

import { writeFileAtomicSync } from '../../src/main/utils/write-file-atomic'
import { TEMP_FILE_PATTERN } from '../../src/main/utils/sweep-orphan-pack-bodies'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-fs/tests/fixtures/ts_temp_names.json')
const DIR = '/d/sub'

/** The pid 4242 gives a 4-digit pid; 4194304 is the largest Linux pid_max. */
const PIDS = [4242, 4194304]

/** Name lengths around the cut: the suffix is 22 bytes with pid 4242 and 25
 *  with pid 4194304, so the longest names kept whole are 233 and 230 bytes. */
const NAMES = [
  'quit-pending.json',
  'config.json',
  'abc.json',
  'a',
  'pack-日本語.json',
  'x'.repeat(233),
  'x'.repeat(234),
  'x'.repeat(230),
  'x'.repeat(231),
  'p'.repeat(222) + '.json',
  'p'.repeat(240) + '.json',
  'é'.repeat(200),
  'あ'.repeat(85),
  '😀'.repeat(60),
  'a' + '😀'.repeat(58),
]

function tempNameFor(name: string, pid: number): string {
  Object.defineProperty(process, 'pid', { value: pid, configurable: true })
  fs.written.length = 0
  writeFileAtomicSync(`${DIR}/${name}`, '')
  const [path] = fs.written
  expect(dirname(path)).toBe(DIR)
  return basename(path)
}

describe('atomic writer temp name fixtures', () => {
  it('records the TypeScript temp name for every target name', () => {
    const realPid = process.pid
    const cases = []
    try {
      for (const pid of PIDS) {
        for (const name of NAMES) {
          const tempName = tempNameFor(name, pid)
          cases.push({ name, pid, tempName, matchesSweepPattern: TEMP_FILE_PATTERN.test(tempName) })
        }
      }
    } finally {
      Object.defineProperty(process, 'pid', { value: realPid, configurable: true })
    }
    writeJsonFixture(OUT, {
      sweepPattern: TEMP_FILE_PATTERN.source,
      randomHex: Buffer.from(RANDOM_BYTES).toString('hex'),
      cases,
    })

    // Both outcomes of the cut and of the pattern are covered.
    expect(cases.some((c) => c.tempName.startsWith(c.name))).toBe(true)
    expect(cases.some((c) => !c.tempName.startsWith(c.name))).toBe(true)
    expect(cases.some((c) => c.matchesSweepPattern)).toBe(true)
    expect(cases.some((c) => !c.matchesSweepPattern)).toBe(true)
  })
})
