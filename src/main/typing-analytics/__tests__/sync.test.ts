// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  TypingAnalyticsDB,
  type TypingScopeRow,
} from '../db/typing-analytics-db'
import {
  buildTypingAnalyticsBundle,
  mergeTypingAnalyticsBundle,
  TYPING_ANALYTICS_BUNDLE_REV,
  TYPING_ANALYTICS_TOMBSTONE_RETENTION_DAYS,
} from '../sync'

const DAY_MS = 24 * 60 * 60 * 1_000
const NOW = Date.UTC(2026, 3, 15, 12, 0, 0)
const LOCAL_MACHINE = 'local-machine-hash'

function baseScope(overrides: Partial<TypingScopeRow> = {}): TypingScopeRow {
  return {
    id: 'scope-local',
    machineHash: LOCAL_MACHINE,
    osPlatform: 'linux',
    osRelease: '6.8',
    osArch: 'x64',
    keyboardUid: '0xAABB',
    keyboardVendorId: 0xFEED,
    keyboardProductId: 0x0000,
    keyboardProductName: 'Pipette',
    updatedAt: 1_000,
    ...overrides,
  }
}

const baseStats = {
  keystrokes: 1,
  activeMs: 1,
  intervalAvgMs: 1,
  intervalMinMs: 1,
  intervalP25Ms: 1,
  intervalP50Ms: 1,
  intervalP75Ms: 1,
  intervalMaxMs: 1,
}

describe('typing-analytics sync bundle', () => {
  let tmpDir: string
  let db: TypingAnalyticsDB

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-typing-analytics-sync-'))
    db = new TypingAnalyticsDB(join(tmpDir, 'typing-analytics.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('buildTypingAnalyticsBundle', () => {
    it('carries every row for the uid within the live window', () => {
      db.upsertScope(baseScope())
      db.writeMinute(
        { scopeId: 'scope-local', minuteTs: NOW - DAY_MS, ...baseStats },
        [{ scopeId: 'scope-local', minuteTs: NOW - DAY_MS, char: 'a', count: 3 }],
        [{ scopeId: 'scope-local', minuteTs: NOW - DAY_MS, row: 0, col: 3, layer: 0, keycode: 0x04, count: 3 }],
        NOW,
      )
      db.insertSession({ id: 'session-1', scopeId: 'scope-local', startMs: NOW - DAY_MS, endMs: NOW - DAY_MS + 10_000 }, NOW)

      const bundle = buildTypingAnalyticsBundle('0xAABB', 7, { db, now: NOW })

      expect(bundle._rev).toBe(TYPING_ANALYTICS_BUNDLE_REV)
      expect(bundle.uid).toBe('0xAABB')
      expect(bundle.spanDays).toBe(7)
      expect(bundle.scopes.map((s) => s.id)).toEqual(['scope-local'])
      expect(bundle.charMinutes).toHaveLength(1)
      expect(bundle.charMinutes[0]).toMatchObject({ char: 'a', count: 3, isDeleted: false })
      expect(bundle.matrixMinutes).toHaveLength(1)
      expect(bundle.minuteStats).toHaveLength(1)
      expect(bundle.sessions).toHaveLength(1)
    })

    it('drops live rows older than the live window but keeps recent tombstones', () => {
      db.upsertScope(baseScope())
      // Live row outside 7-day window
      db.writeMinute(
        { scopeId: 'scope-local', minuteTs: NOW - 10 * DAY_MS, ...baseStats },
        [{ scopeId: 'scope-local', minuteTs: NOW - 10 * DAY_MS, char: 'a', count: 1 }],
        [],
        NOW,
      )
      // Recent tombstone (within tombstone window)
      db.getConnection().prepare(
        "INSERT INTO typing_char_minute (scope_id, minute_ts, char, count, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, 1)",
      ).run('scope-local', NOW - 10 * DAY_MS, 'b', 0, NOW - DAY_MS)

      const bundle = buildTypingAnalyticsBundle('0xAABB', 7, { db, now: NOW })
      expect(bundle.charMinutes.map((r) => r.char)).toEqual(['b'])
      expect(bundle.charMinutes[0].isDeleted).toBe(true)
    })

    it('drops tombstones older than the tombstone window', () => {
      db.upsertScope(baseScope())
      db.getConnection().prepare(
        "INSERT INTO typing_char_minute (scope_id, minute_ts, char, count, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, 1)",
      ).run('scope-local', 0, 'a', 0, NOW - (TYPING_ANALYTICS_TOMBSTONE_RETENTION_DAYS + 5) * DAY_MS)

      const bundle = buildTypingAnalyticsBundle('0xAABB', 7, { db, now: NOW })
      expect(bundle.charMinutes).toHaveLength(0)
    })

    it('falls back to the default span for non-finite input', () => {
      db.upsertScope(baseScope())
      const bundle = buildTypingAnalyticsBundle('0xAABB', Number.NaN, { db, now: NOW })
      // default 7 — 7-day window covers the scope row updated_at within tombstones.
      expect(bundle.spanDays).toBe(7)
    })
  })

  describe('mergeTypingAnalyticsBundle', () => {
    it('applies every row type in a single transaction (LWW)', () => {
      const bundle = {
        _rev: TYPING_ANALYTICS_BUNDLE_REV,
        exportedAt: NOW,
        uid: '0xAABB',
        spanDays: 7,
        scopes: [baseScope({ updatedAt: 5_000 })],
        charMinutes: [
          { scopeId: 'scope-local', minuteTs: NOW - DAY_MS, char: 'a', count: 9, updatedAt: 5_000, isDeleted: false },
        ],
        matrixMinutes: [
          { scopeId: 'scope-local', minuteTs: NOW - DAY_MS, row: 0, col: 0, layer: 0, keycode: 0x04, count: 2, updatedAt: 5_000, isDeleted: false },
        ],
        minuteStats: [
          { scopeId: 'scope-local', minuteTs: NOW - DAY_MS, keystrokes: 9, activeMs: 1_000, intervalAvgMs: 100, intervalMinMs: 50, intervalP25Ms: 80, intervalP50Ms: 100, intervalP75Ms: 120, intervalMaxMs: 150, updatedAt: 5_000, isDeleted: false },
        ],
        sessions: [
          { id: 'session-a', scopeId: 'scope-local', startMs: NOW - DAY_MS, endMs: NOW - DAY_MS + 5_000, updatedAt: 5_000, isDeleted: false },
        ],
      }

      const result = mergeTypingAnalyticsBundle(bundle, '0xAABB', { db })
      expect(result).toMatchObject({ scopes: 1, charMinutes: 1, matrixMinutes: 1, minuteStats: 1, sessions: 1 })

      const conn = db.getConnection()
      expect((conn.prepare('SELECT count FROM typing_char_minute WHERE char = ?').get('a') as { count: number }).count).toBe(9)
      expect((conn.prepare('SELECT COUNT(*) as n FROM typing_minute_stats').get() as { n: number }).n).toBe(1)
      expect((conn.prepare('SELECT COUNT(*) as n FROM typing_sessions').get() as { n: number }).n).toBe(1)
    })

    it('wins LWW for a newer remote row and loses LWW for an older one', () => {
      db.upsertScope(baseScope())
      db.writeMinute(
        { scopeId: 'scope-local', minuteTs: NOW - DAY_MS, ...baseStats },
        [{ scopeId: 'scope-local', minuteTs: NOW - DAY_MS, char: 'a', count: 2 }],
        [],
        5_000,
      )

      // Older remote — should lose.
      mergeTypingAnalyticsBundle(
        {
          _rev: TYPING_ANALYTICS_BUNDLE_REV,
          exportedAt: NOW,
          uid: '0xAABB',
          spanDays: 7,
          scopes: [],
          charMinutes: [
            { scopeId: 'scope-local', minuteTs: NOW - DAY_MS, char: 'a', count: 99, updatedAt: 4_000, isDeleted: false },
          ],
          matrixMinutes: [],
          minuteStats: [],
          sessions: [],
        },
        '0xAABB',
        { db },
      )
      expect((db.getConnection().prepare('SELECT count FROM typing_char_minute WHERE char = ?').get('a') as { count: number }).count).toBe(2)

      // Newer remote — should win.
      mergeTypingAnalyticsBundle(
        {
          _rev: TYPING_ANALYTICS_BUNDLE_REV,
          exportedAt: NOW,
          uid: '0xAABB',
          spanDays: 7,
          scopes: [],
          charMinutes: [
            { scopeId: 'scope-local', minuteTs: NOW - DAY_MS, char: 'a', count: 99, updatedAt: 6_000, isDeleted: false },
          ],
          matrixMinutes: [],
          minuteStats: [],
          sessions: [],
        },
        '0xAABB',
        { db },
      )
      expect((db.getConnection().prepare('SELECT count FROM typing_char_minute WHERE char = ?').get('a') as { count: number }).count).toBe(99)
    })

    it('skips bundles whose uid does not match', () => {
      const result = mergeTypingAnalyticsBundle(
        {
          _rev: TYPING_ANALYTICS_BUNDLE_REV,
          exportedAt: NOW,
          uid: 'something-else',
          spanDays: 7,
          scopes: [],
          charMinutes: [],
          matrixMinutes: [],
          minuteStats: [],
          sessions: [],
        },
        '0xAABB',
        { db },
      )
      expect(result.skippedUid).toBe('something-else')
      expect(result.scopes).toBe(0)
    })

    it('skips bundles with an unsupported _rev', () => {
      const result = mergeTypingAnalyticsBundle(
        { _rev: 999, exportedAt: NOW, uid: '0xAABB', spanDays: 7, scopes: [], charMinutes: [], matrixMinutes: [], minuteStats: [], sessions: [] },
        '0xAABB',
        { db },
      )
      expect(result.skippedRev).toBe(true)
    })

    it('skips non-object or malformed input', () => {
      expect(mergeTypingAnalyticsBundle(null, '0xAABB', { db }).skippedRev).toBe(true)
      expect(mergeTypingAnalyticsBundle({ foo: 'bar' }, '0xAABB', { db }).skippedRev).toBe(true)
    })
  })

  describe('round-trip', () => {
    it('serializes to JSON and restores bit-for-bit via merge', () => {
      db.upsertScope(baseScope({ updatedAt: 5_000 }))
      db.writeMinute(
        { scopeId: 'scope-local', minuteTs: NOW - DAY_MS, ...baseStats },
        [{ scopeId: 'scope-local', minuteTs: NOW - DAY_MS, char: 'a', count: 5 }],
        [{ scopeId: 'scope-local', minuteTs: NOW - DAY_MS, row: 0, col: 3, layer: 0, keycode: 0x04, count: 5 }],
        6_000,
      )
      db.insertSession({ id: 'session-a', scopeId: 'scope-local', startMs: NOW - DAY_MS, endMs: NOW - DAY_MS + 5_000 }, 6_000)

      const original = buildTypingAnalyticsBundle('0xAABB', 7, { db, now: NOW })
      const wire = JSON.parse(JSON.stringify(original))

      // Tear down and rebuild DB, apply the bundle, check state.
      db.close()
      rmSync(join(tmpDir, 'typing-analytics.db'))
      db = new TypingAnalyticsDB(join(tmpDir, 'typing-analytics.db'))

      const result = mergeTypingAnalyticsBundle(wire, '0xAABB', { db })
      expect(result).toMatchObject({ scopes: 1, charMinutes: 1, matrixMinutes: 1, minuteStats: 1, sessions: 1 })

      const rebuilt = buildTypingAnalyticsBundle('0xAABB', 7, { db, now: NOW })
      // exportedAt differs by call site; compare the row data only.
      expect(rebuilt.charMinutes).toEqual(original.charMinutes)
      expect(rebuilt.matrixMinutes).toEqual(original.matrixMinutes)
      expect(rebuilt.minuteStats).toEqual(original.minuteStats)
      expect(rebuilt.sessions).toEqual(original.sessions)
      expect(rebuilt.scopes).toEqual(original.scopes)
    })
  })
})
