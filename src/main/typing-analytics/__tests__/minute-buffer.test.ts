// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach } from 'vitest'
import { MinuteBuffer, MINUTE_MS } from '../minute-buffer'
import type {
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
} from '../../../shared/types/typing-analytics'
import { canonicalScopeKey } from '../../../shared/types/typing-analytics'

function fingerprint(overrides: Partial<TypingAnalyticsFingerprint['keyboard']> = {}): TypingAnalyticsFingerprint {
  return {
    machineHash: 'hash-abc',
    os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
    keyboard: {
      uid: '0xAABB',
      vendorId: 0xFEED,
      productId: 0x0000,
      productName: 'Pipette',
      ...overrides,
    },
  }
}

function charEvent(key: string, ts: number): TypingAnalyticsEvent {
  return { kind: 'char', key, ts, keyboard: { uid: 'x', vendorId: 0, productId: 0, productName: '' } }
}

function matrixEvent(row: number, col: number, layer: number, keycode: number, ts: number): TypingAnalyticsEvent {
  return {
    kind: 'matrix',
    row,
    col,
    layer,
    keycode,
    ts,
    keyboard: { uid: 'x', vendorId: 0, productId: 0, productName: '' },
  }
}

describe('MinuteBuffer', () => {
  let buffer: MinuteBuffer

  beforeEach(() => {
    buffer = new MinuteBuffer()
  })

  it('starts empty', () => {
    expect(buffer.isEmpty()).toBe(true)
    expect(buffer.drainAll()).toEqual([])
  })

  it('groups events into minute buckets', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)
    buffer.addEvent(charEvent('b', 30_000), fp)
    buffer.addEvent(charEvent('a', MINUTE_MS + 5_000), fp)

    const snapshots = buffer.drainAll().sort((a, b) => a.minuteTs - b.minuteTs)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0].minuteTs).toBe(0)
    expect(snapshots[0].keystrokes).toBe(2)
    expect(snapshots[0].charCounts.get('a')).toBe(1)
    expect(snapshots[0].charCounts.get('b')).toBe(1)
    expect(snapshots[1].minuteTs).toBe(MINUTE_MS)
    expect(snapshots[1].keystrokes).toBe(1)
  })

  it('splits one wall-clock minute into separate buckets per run id', () => {
    const fp = fingerprint()
    // Two runs typing in the same minute must not collapse: each run keeps
    // its own snapshot so per-run analytics stay exact.
    buffer.addEvent({ ...charEvent('a', 1_000), runId: 'run-1' }, fp)
    buffer.addEvent({ ...charEvent('a', 2_000), runId: 'run-1' }, fp)
    buffer.addEvent({ ...charEvent('b', 3_000), runId: 'run-2' }, fp)
    // Plain REC input (no runId) is its own '' bucket.
    buffer.addEvent(charEvent('c', 4_000), fp)

    const snapshots = buffer.drainAll().sort((a, b) => a.runId.localeCompare(b.runId))
    expect(snapshots).toHaveLength(3)
    expect(snapshots.map((s) => s.runId)).toEqual(['', 'run-1', 'run-2'])
    expect(snapshots.every((s) => s.minuteTs === 0)).toBe(true)
    const run1 = snapshots.find((s) => s.runId === 'run-1')
    expect(run1?.keystrokes).toBe(2)
    expect(run1?.charCounts.get('a')).toBe(2)
    expect(snapshots.find((s) => s.runId === 'run-2')?.keystrokes).toBe(1)
    expect(snapshots.find((s) => s.runId === '')?.charCounts.get('c')).toBe(1)
  })

  it('accumulates char counts within the same minute', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)
    buffer.addEvent(charEvent('a', 2_000), fp)
    buffer.addEvent(charEvent('b', 3_000), fp)

    const [snap] = buffer.drainAll()
    expect(snap.charCounts.get('a')).toBe(2)
    expect(snap.charCounts.get('b')).toBe(1)
  })

  it('accumulates matrix counts keyed by position, keeps the latest keycode', () => {
    const fp = fingerprint()
    buffer.addEvent(matrixEvent(0, 3, 0, 0x04, 1_000), fp)
    buffer.addEvent(matrixEvent(0, 3, 0, 0x04, 2_000), fp)
    buffer.addEvent(matrixEvent(2, 1, 1, 0x4015, 3_000), fp)

    const [snap] = buffer.drainAll()
    expect(snap.matrixCounts.get('0,3,0')).toEqual({ row: 0, col: 3, layer: 0, keycode: 0x04, count: 2, tapCount: 0, holdCount: 0 })
    expect(snap.matrixCounts.get('2,1,1')).toEqual({ row: 2, col: 1, layer: 1, keycode: 0x4015, count: 1, tapCount: 0, holdCount: 0 })
  })

  it('computes interval stats from event timing', () => {
    const fp = fingerprint()
    // 5 events with intervals [100, 200, 300, 400]
    buffer.addEvent(charEvent('a', 1_000), fp)
    buffer.addEvent(charEvent('a', 1_100), fp)
    buffer.addEvent(charEvent('a', 1_300), fp)
    buffer.addEvent(charEvent('a', 1_600), fp)
    buffer.addEvent(charEvent('a', 2_000), fp)

    const [snap] = buffer.drainAll()
    expect(snap.keystrokes).toBe(5)
    expect(snap.intervalMinMs).toBe(100)
    expect(snap.intervalMaxMs).toBe(400)
    expect(snap.intervalAvgMs).toBe(250)
    // sorted intervals: [100, 200, 300, 400]
    // p25 at index floor(3*0.25)=0 → 100
    // p50 at index floor(3*0.5)=1 → 200
    // p75 at index floor(3*0.75)=2 → 300
    expect(snap.intervalP25Ms).toBe(100)
    expect(snap.intervalP50Ms).toBe(200)
    expect(snap.intervalP75Ms).toBe(300)
    expect(snap.activeMs).toBe(1_000)
  })

  it('keeps separate buckets per scope within the same minute', () => {
    const fp1 = fingerprint({ uid: '0xAAAA' })
    const fp2 = fingerprint({ uid: '0xBBBB' })
    buffer.addEvent(charEvent('a', 1_000), fp1)
    buffer.addEvent(charEvent('a', 2_000), fp2)

    const snapshots = buffer.drainAll()
    expect(snapshots).toHaveLength(2)
    const scope1Id = canonicalScopeKey(fp1)
    const scope2Id = canonicalScopeKey(fp2)
    expect(new Set(snapshots.map((s) => s.scopeId))).toEqual(new Set([scope1Id, scope2Id]))
  })

  it('drainClosed only returns entries strictly older than the boundary', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)                // minute 0
    buffer.addEvent(charEvent('a', MINUTE_MS + 1_000), fp)    // minute 1
    buffer.addEvent(charEvent('a', 2 * MINUTE_MS + 1_000), fp) // minute 2

    const closed = buffer.drainClosed(2 * MINUTE_MS)
    expect(closed.map((s) => s.minuteTs).sort((a, b) => a - b)).toEqual([0, MINUTE_MS])
    // Minute 2 is still live.
    expect(buffer.isEmpty()).toBe(false)

    const remaining = buffer.drainAll()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].minuteTs).toBe(2 * MINUTE_MS)
  })

  it('keeps activeMs monotonic when a late event arrives with an earlier ts', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)
    buffer.addEvent(charEvent('a', 1_200), fp)
    // Out-of-order event: still counted, but lastEventMs must not walk back.
    buffer.addEvent(charEvent('a', 1_100), fp)

    const [snap] = buffer.drainAll()
    expect(snap.keystrokes).toBe(3)
    expect(snap.activeMs).toBe(200)
  })

  it('extends firstEventMs backwards for a late event earlier than the first seen', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_500), fp)
    buffer.addEvent(charEvent('a', 2_000), fp)
    // Earlier than the first seen event — still within minute 0 since
    // MINUTE_MS = 60_000, so it rebuckets into the same entry.
    buffer.addEvent(charEvent('a', 500), fp)

    const [snap] = buffer.drainAll()
    expect(snap.keystrokes).toBe(3)
    // Outer window is 500 → 2000, so activeMs = 1_500.
    expect(snap.activeMs).toBe(1_500)
  })

  it('handles a single-event minute with null percentile stats', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)

    const [snap] = buffer.drainAll()
    expect(snap.keystrokes).toBe(1)
    expect(snap.activeMs).toBe(0)
    expect(snap.intervalAvgMs).toBeNull()
    expect(snap.intervalMinMs).toBeNull()
    expect(snap.intervalP50Ms).toBeNull()
    expect(snap.intervalMaxMs).toBeNull()
  })

  describe('bigram tracking', () => {
    it('records pair IKIs across consecutive matrix events', () => {
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp) // KC_A
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_120), fp) // KC_H, IKI=120
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_300), fp) // KC_D, IKI=180

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([
        ['4_11', [120]],
        ['11_7', [180]],
      ])
    })

    it('does not pair across char events but does not reset the chain either', () => {
      // Bigram tracking is matrix-only; intervening char events are
      // transparent so the next matrix pairs against the prior matrix.
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.addEvent(charEvent('a', 1_050), fp)
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_200), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['4_11', [200]]])
    })

    it('drops pairs whose IKI exceeds the session idle gap', () => {
      // SESSION_IDLE_GAP_MS = 5 minutes. A 6-minute gap means the next
      // event starts a fresh session and shouldn't pair with the prior.
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_000 + 6 * 60 * 1_000), fp)

      const [snapA, snapB] = buffer.drainAll()
      // Two minutes were buffered; check the merged result has no bigrams.
      const allBigrams = new Map([...snapA.bigrams, ...snapB.bigrams])
      expect(allBigrams.size).toBe(0)
    })

    it('drops the cross-minute pair after drainClosed resets the chain', () => {
      // Production flow: the service calls drainClosed periodically;
      // when it fires between two matrix events that straddle a minute
      // boundary, the prior chain head is cleared and the new event has
      // no peer to pair against.
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 30_000), fp) // minute 0
      const closed = buffer.drainClosed(60_000)
      expect(closed).toHaveLength(1)
      expect(closed[0].bigrams.size).toBe(0) // single event in minute 0, no pair to record yet

      buffer.addEvent(matrixEvent(0, 1, 0, 11, 90_000), fp) // minute 1, but chain was just cleared
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 90_150), fp) // first valid pair within minute 1

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['11_7', [150]]])
    })

    it('attributes cross-minute pairs to the later minute when drainClosed has not run', () => {
      // Without drainClosed firing between events, the chain persists
      // across minutes, so the IKI-eligible pair lands in the snapshot
      // belonging to the later event. This is acceptable per the design
      // (cross-minute pairs are attributed to the new minute, ~0.3%
      // misattribution at typical rates).
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 30_000), fp) // minute 0
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 90_000), fp) // minute 1, IKI=60000 → still <= SESSION_IDLE_GAP_MS

      const snaps = buffer.drainAll()
      const minute0 = snaps.find((s) => s.minuteTs === 0)
      const minute1 = snaps.find((s) => s.minuteTs === 60_000)
      expect(minute0?.bigrams.size).toBe(0)
      expect([...(minute1?.bigrams.entries() ?? [])]).toEqual([['4_11', [60_000]]])
    })

    it('does not advance the chain on tied timestamps', () => {
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      // Tie ts — no bigram emitted (iki = 0) AND chain stays at keycode 4
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_000), fp)
      // Forward ts — should pair against the original 4 (chain didn't advance to 11)
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_150), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['4_7', [150]]])
    })

    it('clears the chain after drainAll so a fresh batch does not bridge', () => {
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.drainAll()
      // After drainAll, the previous keycode chain should be cleared, so
      // the next matrix event can't pair against a residual prior keycode.
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_500), fp)
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_650), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['11_7', [150]]])
    })
  })

  describe('trigram tracking', () => {
    it('records a triple after 3 consecutive matrix events as the average of the two intervals', () => {
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp) // KC_A
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_120), fp) // KC_H, iki1=120
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_300), fp) // KC_D, iki2=180

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([['4_11_7', [150]]]) // (120+180)/2
    })

    it('forms a rolling window of triples across 4+ events', () => {
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_100), fp) // iki=100
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_250), fp) // iki=150 -> triple 4_11_7 = 125
      buffer.addEvent(matrixEvent(0, 3, 0, 5, 1_450), fp) // iki=200 -> triple 11_7_5 = 175

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([
        ['4_11_7', [125]],
        ['11_7_5', [175]],
      ])
    })

    it('does not pair across char events but stays transparent to the chain', () => {
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.addEvent(charEvent('a', 1_050), fp)
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_100), fp)
      buffer.addEvent(charEvent('b', 1_150), fp)
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_300), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([['4_11_7', [150]]]) // (100+200)/2
    })

    it('drops the triple and resets the chain when the trailing interval exceeds the session gap', () => {
      // SESSION_IDLE_GAP_MS = 5 minutes.
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_100), fp) // valid iki=100, chain=[4,11]
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_100 + 6 * 60_000), fp) // gap > 5min: no triple, chain resets to [7]
      buffer.addEvent(matrixEvent(0, 3, 0, 5, 1_100 + 6 * 60_000 + 120), fp) // chain=[7,5], still no triple (only 2 deep)

      const snaps = buffer.drainAll()
      const allTrigrams = new Map(snaps.flatMap((s) => [...s.trigrams]))
      expect(allTrigrams.size).toBe(0)
    })

    it('drops the triple entirely when only the leading interval is too slow', () => {
      // First interval spans a session gap; second interval (last->curr) is
      // fine on its own, but the stale k1 must not feed a triple.
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_000 + 6 * 60_000), fp) // gap too large -> chain resets to [11]
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_000 + 6 * 60_000 + 100), fp) // chain=[11,7], only 2 deep, no triple yet

      const snaps = buffer.drainAll()
      const allTrigrams = new Map(snaps.flatMap((s) => [...s.trigrams]))
      expect(allTrigrams.size).toBe(0)
    })

    it('does not advance the chain on tied timestamps', () => {
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_100), fp) // chain=[4,11]
      // Tie ts — discarded, chain stays at [4,11]
      buffer.addEvent(matrixEvent(0, 2, 0, 99, 1_100), fp)
      // Forward ts — pairs against the un-advanced chain [4,11]
      buffer.addEvent(matrixEvent(0, 3, 0, 7, 1_250), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([['4_11_7', [125]]]) // (100+150)/2
    })

    it('drops the cross-minute triple after drainClosed resets the chain', () => {
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 20_000), fp) // minute 0
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 40_000), fp) // minute 0, chain=[4,11]
      const closed = buffer.drainClosed(60_000)
      expect(closed).toHaveLength(1)
      expect(closed[0].trigrams.size).toBe(0) // only 2 events so far, no triple yet

      // Chain was cleared by drainClosed, so this event starts fresh.
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 90_000), fp) // minute 1
      buffer.addEvent(matrixEvent(0, 3, 0, 5, 90_150), fp) // minute 1, chain=[7,5]
      buffer.addEvent(matrixEvent(0, 4, 0, 6, 90_300), fp) // minute 1, first valid triple

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([['7_5_6', [150]]])
    })

    it('clears the chain after drainAll so a fresh batch does not bridge', () => {
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_100), fp)
      buffer.drainAll()
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_500), fp)
      buffer.addEvent(matrixEvent(0, 3, 0, 5, 1_650), fp)
      buffer.addEvent(matrixEvent(0, 4, 0, 6, 1_800), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([['7_5_6', [150]]])
    })
  })

  describe('n-gram chain scope/run isolation', () => {
    it('does not pair interleaved events from two different scopes', () => {
      // Two keyboards typing in parallel interleave their matrix events;
      // every scope switch restarts the chain, so no pair or triple may
      // cross the boundary — and here no two consecutive events share a
      // scope, so nothing is recorded at all.
      const fpA = fingerprint({ uid: '0xAAAA' })
      const fpB = fingerprint({ uid: '0xBBBB' })
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fpA)
      buffer.addEvent(matrixEvent(0, 0, 0, 20, 1_050), fpB)
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_100), fpA)
      buffer.addEvent(matrixEvent(0, 1, 0, 21, 1_150), fpB)
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_200), fpA)

      const snaps = buffer.drainAll()
      expect(snaps).toHaveLength(2)
      for (const snap of snaps) {
        expect(snap.bigrams.size).toBe(0)
        expect(snap.trigrams.size).toBe(0)
      }
    })

    it('pairs consecutive same-scope events after an interleaved foreign event reset the chain', () => {
      const fpA = fingerprint({ uid: '0xAAAA' })
      const fpB = fingerprint({ uid: '0xBBBB' })
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fpA)
      // Foreign scope restarts the chain, so 4 can no longer head a pair.
      buffer.addEvent(matrixEvent(0, 0, 0, 20, 1_050), fpB)
      buffer.addEvent(matrixEvent(0, 1, 0, 11, 1_100), fpA)
      buffer.addEvent(matrixEvent(0, 2, 0, 7, 1_250), fpA)

      const snaps = buffer.drainAll()
      const snapA = snaps.find((s) => s.scopeId === canonicalScopeKey(fpA))
      const snapB = snaps.find((s) => s.scopeId === canonicalScopeKey(fpB))
      expect([...(snapA?.bigrams.entries() ?? [])]).toEqual([['11_7', [150]]])
      // Chain is only 2 deep after the reset — no triple, and certainly
      // not 4_11_7 through the foreign event.
      expect(snapA?.trigrams.size).toBe(0)
      expect(snapB?.bigrams.size).toBe(0)
      expect(snapB?.trigrams.size).toBe(0)
    })

    it('resets the chain when the run id changes within one scope', () => {
      // REC input followed by a typing-test run: the run boundary must
      // not produce a cross-run pair even though scope and timing both
      // look continuous.
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.addEvent({ ...matrixEvent(0, 1, 0, 11, 1_100), runId: 'run-1' }, fp)
      buffer.addEvent({ ...matrixEvent(0, 2, 0, 7, 1_250), runId: 'run-1' }, fp)

      const snaps = buffer.drainAll()
      const recSnap = snaps.find((s) => s.runId === '')
      const runSnap = snaps.find((s) => s.runId === 'run-1')
      expect(recSnap?.bigrams.size).toBe(0)
      // Only the within-run pair survives; no 4_11 across the boundary
      // and no 4_11_7 triple through it.
      expect([...(runSnap?.bigrams.entries() ?? [])]).toEqual([['11_7', [150]]])
      expect(runSnap?.trigrams.size).toBe(0)
    })

    it('keeps recording pairs and triples for an uninterrupted same-scope same-run stream', () => {
      const fp = fingerprint()
      buffer.addEvent({ ...matrixEvent(0, 0, 0, 4, 1_000), runId: 'run-1' }, fp)
      buffer.addEvent({ ...matrixEvent(0, 1, 0, 11, 1_100), runId: 'run-1' }, fp)
      buffer.addEvent({ ...matrixEvent(0, 2, 0, 7, 1_250), runId: 'run-1' }, fp)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([
        ['4_11', [100]],
        ['11_7', [150]],
      ])
      expect([...snap.trigrams.entries()]).toEqual([['4_11_7', [125]]]) // (100+150)/2
    })
  })

  it('exposes an empty bigrams map when no matrix events arrived', () => {
    // Sanity check: the Map exists on every snapshot (downstream emit
    // layer relies on snapshot.bigrams.size, not optional access).
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)
    const [snap] = buffer.drainAll()
    expect(snap.bigrams.size).toBe(0)
    expect(snap.trigrams.size).toBe(0)
  })

  describe('app-name tagging', () => {
    it('returns null appName when markAppName never fires', () => {
      // Default state: aggregator never observed an active app, so the
      // snapshot must say "unknown / not collected" rather than guess.
      const fp = fingerprint()
      buffer.addEvent(charEvent('a', 1_000), fp)
      const [snap] = buffer.drainAll()
      expect(snap.appName).toBeNull()
    })

    it('returns the single app when only one was observed', () => {
      const fp = fingerprint()
      buffer.addEvent(charEvent('a', 1_000), fp)
      buffer.markAppName('VSCode')
      const [snap] = buffer.drainAll()
      expect(snap.appName).toBe('VSCode')
    })

    it('collapses to null when multiple distinct apps were observed', () => {
      // The "single app per minute" filter rule lives at finalize time:
      // any minute that saw ≥2 apps must look indistinguishable from a
      // never-tagged minute on the read side, so the size>1 set is
      // forced to null here rather than carrying mixed state forward.
      const fp = fingerprint()
      buffer.addEvent(charEvent('a', 1_000), fp)
      buffer.markAppName('VSCode')
      buffer.markAppName('Slack')
      const [snap] = buffer.drainAll()
      expect(snap.appName).toBeNull()
    })

    it('treats the same app tagged twice as a single observation', () => {
      const fp = fingerprint()
      buffer.addEvent(charEvent('a', 1_000), fp)
      buffer.markAppName('VSCode')
      buffer.markAppName('VSCode')
      const [snap] = buffer.drainAll()
      expect(snap.appName).toBe('VSCode')
    })

    it('ignores null tags so "no observation" is distinguishable from "mixed"', () => {
      // markAppName(null) is the no-op path: app-monitor returns null
      // when Monitor App is off / failed, and we don't want a single OS
      // hiccup to retroactively poison a single-app minute as mixed.
      const fp = fingerprint()
      buffer.addEvent(charEvent('a', 1_000), fp)
      buffer.markAppName('VSCode')
      buffer.markAppName(null)
      const [snap] = buffer.drainAll()
      expect(snap.appName).toBe('VSCode')
    })

    it('tags every live entry across scopes in one call', () => {
      // OS focus is shared across scopes; one markAppName call covers
      // every keyboard / device / minute currently in flight.
      const fpA = fingerprint({ uid: '0xAAAA' })
      const fpB = fingerprint({ uid: '0xBBBB' })
      buffer.addEvent(charEvent('a', 1_000), fpA)
      buffer.addEvent(charEvent('b', 1_000), fpB)
      buffer.markAppName('VSCode')
      const snaps = buffer.drainAll().sort((x, y) => x.scopeId.localeCompare(y.scopeId))
      expect(snaps).toHaveLength(2)
      expect(snaps[0].appName).toBe('VSCode')
      expect(snaps[1].appName).toBe('VSCode')
    })

    it('does not bleed app tags into a fresh minute after a drain', () => {
      // drainAll empties the buffer, so a follow-up minute must start
      // with an empty app set. Otherwise stale tags from the previous
      // minute would force every later minute into the mixed bucket.
      const fp = fingerprint()
      buffer.addEvent(charEvent('a', 1_000), fp)
      buffer.markAppName('VSCode')
      buffer.drainAll()
      buffer.addEvent(charEvent('b', MINUTE_MS + 500), fp)
      buffer.markAppName('Slack')
      const [snap] = buffer.drainAll()
      expect(snap.appName).toBe('Slack')
    })

    it('drainClosed produces appName for closed minutes only', () => {
      // The boundary case the live heatmap relies on: closed minutes
      // ship with their final appName, while the open minute keeps its
      // app set alive for further tagging.
      const fp = fingerprint()
      buffer.addEvent(matrixEvent(0, 0, 0, 4, 500), fp) // minute 0
      buffer.addEvent(matrixEvent(0, 0, 0, 4, MINUTE_MS + 500), fp) // minute 1
      buffer.markAppName('VSCode')
      const closed = buffer.drainClosed(MINUTE_MS)
      expect(closed).toHaveLength(1)
      expect(closed[0].appName).toBe('VSCode')
      // Open minute should still be available; tagging again should
      // accumulate, not reset.
      buffer.markAppName('Slack')
      const remaining = buffer.drainAll()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].appName).toBeNull() // VSCode + Slack → mixed
    })
  })
})
