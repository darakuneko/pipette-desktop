// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deviceJsonlPath,
  devicesDir,
  keyboardsRoot,
  listAllDeviceJsonlFiles,
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
