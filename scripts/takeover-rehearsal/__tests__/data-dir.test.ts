// SPDX-License-Identifier: GPL-2.0-or-later
//
// The snapshot and the comparison for a userData directory started on by
// hand (the Windows and macOS rehearsal), on temporary directories.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compare, saveSnapshot } from '../data-dir'
import { RefusedError } from '../tree'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function dataDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipette-data-dir-test-')))
  made.push(dir)
  write(join(dir, 'config.json'), '{"autoLaunch":true,"windowState":{"x":1}}')
  write(join(dir, 'sync/favorites/macro/index.json'), '{"entries":[]}')
  return dir
}

describe('a userData directory started on by hand', () => {
  it('passes a launch that changes only the listed files', () => {
    const data = dataDir()
    const saved = saveSnapshot(data)
    write(join(data, 'config.json'), '{"autoLaunch":true,"windowState":{"x":2}}')
    write(join(data, 'logs/pipette-0.log'), 'line\n')
    write(join(data, 'lockfile'), '')
    write(join(data, 'quit-pending.json'), '{}')
    const result = compare(data, saved, false)
    expect(result.findings.filter((finding) => finding.verdict === 'violation')).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('stops at a removal or a change off the list', () => {
    const data = dataDir()
    const saved = saveSnapshot(data)
    unlinkSync(join(data, 'sync/favorites/macro/index.json'))
    write(join(data, 'config.json'), '{"autoLaunch":false}')
    const result = compare(data, saved, false)
    expect(result.findings.filter((finding) => finding.verdict === 'violation').map((finding) => finding.path)).toEqual([
      'config.json',
      'sync/favorites/macro/index.json',
    ])
    expect(result.passed).toBe(false)
  })

  it('reads the new and changed files after operations and lists the removals', () => {
    const data = dataDir()
    const saved = saveSnapshot(data)
    write(join(data, 'sync/favorites/macro/index.json'), '{"entries":[{"id":"a"}]}')
    write(join(data, 'sync/favorites/macro/a.json'), '{"a":')
    unlinkSync(join(data, 'config.json'))
    const result = compare(data, saved, true)
    expect(result.findings.map((finding) => [finding.change, finding.path])).toEqual([['removed', 'config.json']])
    expect(result.readable.map((read) => [read.path, read.verdict])).toEqual([
      ['sync/favorites/macro/a.json', 'unreadable'],
      ['sync/favorites/macro/index.json', 'readable'],
    ])
    expect(result.passed).toBe(false)
  })

  it('refuses a snapshot of another directory and a copy with a link', () => {
    const data = dataDir()
    const saved = saveSnapshot(data)
    expect(() => compare(dataDir(), saved, false)).toThrow(RefusedError)
    symlinkSync(tmpdir(), join(data, 'escape'))
    expect(() => compare(data, saved, false)).toThrow(/symbolic link/)
    expect(() => saveSnapshot(data)).toThrow(RefusedError)
  })
})
