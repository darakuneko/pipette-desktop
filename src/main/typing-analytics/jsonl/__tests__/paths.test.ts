// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deviceDayDir,
  deviceDayJsonlPath,
  deviceJsonlPath,
  devicesDir,
  keyboardsRoot,
  listAllDeviceDayJsonlFiles,
  listAllDeviceJsonlFiles,
  listDeviceDays,
  parseReadPointerKey,
  readPointerKey,
} from '../paths'

describe('path helpers', () => {
  it('composes the keyboards root and devices dir with a uid', () => {
    expect(keyboardsRoot('/u')).toBe(join('/u', 'sync', 'keyboards'))
    expect(devicesDir('/u', '0xAABB')).toBe(
      join('/u', 'sync', 'keyboards', '0xAABB', 'devices'),
    )
  })

  it('composes the per-device jsonl path from uid + machineHash', () => {
    expect(deviceJsonlPath('/u', '0xAABB', 'hash-a')).toBe(
      join('/u', 'sync', 'keyboards', '0xAABB', 'devices', 'hash-a.jsonl'),
    )
  })
})

describe('readPointerKey / parseReadPointerKey', () => {
  it('round-trips', () => {
    const key = readPointerKey('0xAABB', 'hash-a')
    expect(parseReadPointerKey(key)).toEqual({ uid: '0xAABB', machineHash: 'hash-a' })
  })

  it('returns null for malformed keys', () => {
    expect(parseReadPointerKey('nopipe')).toBeNull()
    expect(parseReadPointerKey('|missing-uid')).toBeNull()
    expect(parseReadPointerKey('missing-hash|')).toBeNull()
  })
})

describe('listAllDeviceJsonlFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-jsonl-paths-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns an empty list when the sync tree does not exist', async () => {
    expect(await listAllDeviceJsonlFiles(tmpDir)).toEqual([])
  })

  it('returns every {uid}/devices/*.jsonl and ignores non-jsonl entries', async () => {
    const a = devicesDir(tmpDir, '0xAABB')
    const b = devicesDir(tmpDir, '0xCCDD')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    writeFileSync(join(a, 'hash-a.jsonl'), '')
    writeFileSync(join(a, 'hash-b.jsonl'), '')
    writeFileSync(join(a, 'README.txt'), '')
    writeFileSync(join(b, 'hash-a.jsonl'), '')

    const refs = await listAllDeviceJsonlFiles(tmpDir)
    const keys = refs.map((r) => `${r.uid}|${r.machineHash}`).sort()
    expect(keys).toEqual(['0xAABB|hash-a', '0xAABB|hash-b', '0xCCDD|hash-a'])
  })

  it('skips uids that have no devices directory', async () => {
    mkdirSync(join(tmpDir, 'sync', 'keyboards', '0xAABB'), { recursive: true })
    writeFileSync(join(tmpDir, 'sync', 'keyboards', '0xAABB', 'settings.json'), '{}')
    expect(await listAllDeviceJsonlFiles(tmpDir)).toEqual([])
  })
})

describe('per-day path helpers', () => {
  it('composes the per-device day directory under devices/{hash}/', () => {
    expect(deviceDayDir('/u', '0xAABB', 'hash-a')).toBe(
      join('/u', 'sync', 'keyboards', '0xAABB', 'devices', 'hash-a'),
    )
  })

  it('composes the per-day jsonl path with {YYYY-MM-DD}.jsonl', () => {
    expect(deviceDayJsonlPath('/u', '0xAABB', 'hash-a', '2026-04-19')).toBe(
      join('/u', 'sync', 'keyboards', '0xAABB', 'devices', 'hash-a', '2026-04-19.jsonl'),
    )
  })
})

describe('listDeviceDays', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-jsonl-days-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty when the hash directory does not exist', async () => {
    expect(await listDeviceDays(tmpDir, '0xAABB', 'hash-a')).toEqual([])
  })

  it('returns only YYYY-MM-DD.jsonl names, in ascending order', async () => {
    const dir = deviceDayDir(tmpDir, '0xAABB', 'hash-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-04-19.jsonl'), '')
    writeFileSync(join(dir, '2026-04-17.jsonl'), '')
    writeFileSync(join(dir, '2026-04-18.jsonl'), '')
    writeFileSync(join(dir, 'README.txt'), '')
    writeFileSync(join(dir, 'not-a-day.jsonl'), '')
    writeFileSync(join(dir, '2026-13-01.jsonl'), '') // calendar-invalid
    writeFileSync(join(dir, '2026-02-29.jsonl'), '') // not a leap year

    expect(await listDeviceDays(tmpDir, '0xAABB', 'hash-a')).toEqual([
      '2026-04-17',
      '2026-04-18',
      '2026-04-19',
    ])
  })

  it('ignores nested directories masquerading as day files', async () => {
    const dir = deviceDayDir(tmpDir, '0xAABB', 'hash-a')
    mkdirSync(join(dir, '2026-04-19.jsonl'), { recursive: true })
    expect(await listDeviceDays(tmpDir, '0xAABB', 'hash-a')).toEqual([])
  })
})

describe('listAllDeviceDayJsonlFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-jsonl-all-days-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty when no sync tree exists', async () => {
    expect(await listAllDeviceDayJsonlFiles(tmpDir)).toEqual([])
  })

  it('scans {uid}/devices/{hash}/{date}.jsonl and ignores v6 flat files', async () => {
    const hashA = deviceDayDir(tmpDir, '0xAABB', 'hash-a')
    const hashB = deviceDayDir(tmpDir, '0xAABB', 'hash-b')
    const hashC = deviceDayDir(tmpDir, '0xCCDD', 'hash-a')
    mkdirSync(hashA, { recursive: true })
    mkdirSync(hashB, { recursive: true })
    mkdirSync(hashC, { recursive: true })
    writeFileSync(join(hashA, '2026-04-19.jsonl'), '')
    writeFileSync(join(hashA, '2026-04-18.jsonl'), '')
    writeFileSync(join(hashB, '2026-04-19.jsonl'), '')
    writeFileSync(join(hashC, '2026-04-19.jsonl'), '')
    // v6 flat form living alongside — must be ignored by the per-day scan.
    writeFileSync(join(devicesDir(tmpDir, '0xAABB'), 'legacy.jsonl'), '')
    // Junk files within a hash dir.
    writeFileSync(join(hashA, 'notes.txt'), '')
    writeFileSync(join(hashA, 'garbage.jsonl'), '')

    const refs = await listAllDeviceDayJsonlFiles(tmpDir)
    expect(refs.map((r) => `${r.uid}|${r.machineHash}|${r.utcDay}`)).toEqual([
      '0xAABB|hash-a|2026-04-18',
      '0xAABB|hash-a|2026-04-19',
      '0xAABB|hash-b|2026-04-19',
      '0xCCDD|hash-a|2026-04-19',
    ])
    for (const ref of refs) {
      expect(ref.path).toBe(
        join(tmpDir, 'sync', 'keyboards', ref.uid, 'devices', ref.machineHash, `${ref.utcDay}.jsonl`),
      )
    }
  })
})
