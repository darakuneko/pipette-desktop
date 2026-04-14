// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
}))

import {
  readDailyFile,
  flushDailyFile,
  mergeScopeMaps,
} from '../daily-file-store'
import { dailyFilePath } from '../typing-analytics-paths'
import type {
  TypingAnalyticsDailyFile,
  TypingAnalyticsFingerprint,
  TypingScopeEntry,
} from '../../../shared/types/typing-analytics'
import {
  TYPING_ANALYTICS_REV,
  TYPING_ANALYTICS_VERSION,
} from '../../../shared/types/typing-analytics'

const UID = '0xAABB'
const DATE = '2026-04-14'

function fingerprint(uidSuffix = ''): TypingAnalyticsFingerprint {
  return {
    machineHash: 'hash-abc',
    os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
    keyboard: {
      uid: `0xAABB${uidSuffix}`,
      vendorId: 0xFEED,
      productId: 0x0000,
      productName: 'Pipette',
    },
  }
}

function scopeEntry(fp: TypingAnalyticsFingerprint, overrides: Partial<TypingScopeEntry> = {}): TypingScopeEntry {
  return {
    scope: fp,
    charCounts: {},
    matrixCounts: {},
    ...overrides,
  }
}

describe('daily-file-store', () => {
  beforeEach(async () => {
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-daily-file-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('readDailyFile', () => {
    it('returns null when the file does not exist', async () => {
      expect(await readDailyFile(UID, DATE)).toBeNull()
    })

    it('returns null when the file contains malformed JSON', async () => {
      const path = dailyFilePath(UID, DATE)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, '{not json', 'utf-8')
      expect(await readDailyFile(UID, DATE)).toBeNull()
    })

    it('returns null when the schema revision does not match', async () => {
      const path = dailyFilePath(UID, DATE)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, JSON.stringify({
        _rev: 99,
        analyticsVersion: 1,
        date: DATE,
        updatedAt: '',
        lastFlushedAt: '',
        scopes: {},
      }), 'utf-8')
      expect(await readDailyFile(UID, DATE)).toBeNull()
    })
  })

  describe('mergeScopeMaps', () => {
    it('adds char and matrix counts from both sides', () => {
      const fp = fingerprint()
      const a = {
        k1: scopeEntry(fp, {
          charCounts: { a: 2, b: 1 },
          matrixCounts: { '0,0,0': { count: 5, keycode: 0x04 } },
        }),
      }
      const b = {
        k1: scopeEntry(fp, {
          charCounts: { a: 3, c: 1 },
          matrixCounts: { '0,0,0': { count: 2, keycode: 0x04 }, '0,1,0': { count: 1, keycode: 0x05 } },
        }),
      }

      const merged = mergeScopeMaps(a, b)
      expect(merged.k1.charCounts).toEqual({ a: 5, b: 1, c: 1 })
      expect(merged.k1.matrixCounts['0,0,0']).toEqual({ count: 7, keycode: 0x04 })
      expect(merged.k1.matrixCounts['0,1,0']).toEqual({ count: 1, keycode: 0x05 })
    })

    it('keeps scopes that exist on only one side', () => {
      const fp1 = fingerprint()
      const fp2 = fingerprint('-alt')
      const a = { k1: scopeEntry(fp1, { charCounts: { a: 1 } }) }
      const b = { k2: scopeEntry(fp2, { charCounts: { b: 2 } }) }

      const merged = mergeScopeMaps(a, b)
      expect(Object.keys(merged).sort()).toEqual(['k1', 'k2'])
      expect(merged.k1.charCounts).toEqual({ a: 1 })
      expect(merged.k2.charCounts).toEqual({ b: 2 })
    })

    it('does not mutate its inputs', () => {
      const fp = fingerprint()
      const a = { k1: scopeEntry(fp, { charCounts: { a: 1 } }) }
      const b = { k1: scopeEntry(fp, { charCounts: { a: 2 } }) }
      mergeScopeMaps(a, b)
      expect(a.k1.charCounts).toEqual({ a: 1 })
      expect(b.k1.charCounts).toEqual({ a: 2 })
    })
  })

  describe('flushDailyFile', () => {
    it('writes a fresh file when none exists', async () => {
      const fp = fingerprint()
      const scopes = {
        k1: scopeEntry(fp, { charCounts: { a: 3 } }),
      }
      await flushDailyFile(UID, DATE, scopes)

      const parsed = JSON.parse(await readFile(dailyFilePath(UID, DATE), 'utf-8')) as TypingAnalyticsDailyFile
      expect(parsed._rev).toBe(TYPING_ANALYTICS_REV)
      expect(parsed.analyticsVersion).toBe(TYPING_ANALYTICS_VERSION)
      expect(parsed.date).toBe(DATE)
      expect(parsed.scopes.k1.charCounts).toEqual({ a: 3 })
    })

    it('additively merges with an existing file', async () => {
      const fp = fingerprint()
      await flushDailyFile(UID, DATE, { k1: scopeEntry(fp, { charCounts: { a: 2 } }) })
      await flushDailyFile(UID, DATE, { k1: scopeEntry(fp, { charCounts: { a: 5, b: 1 } }) })

      const parsed = await readDailyFile(UID, DATE)
      expect(parsed?.scopes.k1.charCounts).toEqual({ a: 7, b: 1 })
    })

    it('updates updatedAt and lastFlushedAt on each write', async () => {
      const fp = fingerprint()
      await flushDailyFile(UID, DATE, { k1: scopeEntry(fp, { charCounts: { a: 1 } }) })
      const first = await readDailyFile(UID, DATE)

      await new Promise((resolve) => setTimeout(resolve, 5))
      await flushDailyFile(UID, DATE, { k1: scopeEntry(fp, { charCounts: { a: 1 } }) })
      const second = await readDailyFile(UID, DATE)

      expect(second!.updatedAt >= first!.updatedAt).toBe(true)
    })
  })
})
