// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach } from 'vitest'
import { MinuteBuffer, MINUTE_MS, RETENTION_MS } from '../minute-buffer'
import { NGRAM_MAX_IKI_MS, DRAIN_CLOSE_GRACE_MS } from '../minute-buffer'
import { MAX_TAP_HOLD_DEFER_MS } from '../../../shared/qmk-settings-tapping-term'
import type {
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
  TypingMatrixAction,
} from '../../../shared/types/typing-analytics'
import { canonicalScopeKey } from '../../../shared/types/typing-analytics'

// Reassigned fresh in beforeEach; hoisted to module scope so addEv below
// can close over the current instance instead of taking it as a
// parameter at every call site.
let buffer: MinuteBuffer

/** Most of this suite predates the `nowMs` parameter `addEvent` gained for
 *  retention/eviction (see minute-buffer.ts). Defaulting `nowMs` to the
 *  event's own timestamp keeps every existing call site correct without
 *  editing each one individually: `nowMs` only matters when no live entry
 *  exists yet, and `event.ts` is always inside the grace/retention window
 *  of its own minute, so it never triggers the ultra-late drop. Tests that
 *  actually exercise retention/eviction pass an explicit `nowMs`. */
function addEv(event: TypingAnalyticsEvent, fp: TypingAnalyticsFingerprint, nowMs?: number): void {
  buffer.addEvent(event, fp, nowMs ?? event.ts)
}

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

function matrixEvent(
  row: number,
  col: number,
  layer: number,
  keycode: number,
  ts: number,
  action?: TypingMatrixAction,
): TypingAnalyticsEvent {
  return {
    kind: 'matrix',
    row,
    col,
    layer,
    keycode,
    ts,
    ...(action ? { action } : {}),
    keyboard: { uid: 'x', vendorId: 0, productId: 0, productName: '' },
  }
}

describe('MinuteBuffer', () => {
  beforeEach(() => {
    buffer = new MinuteBuffer()
  })

  it('starts empty', () => {
    expect(buffer.isEmpty()).toBe(true)
    expect(buffer.drainAll()).toEqual([])
  })

  it('groups events into minute buckets', () => {
    const fp = fingerprint()
    addEv(charEvent('a', 1_000), fp)
    addEv(charEvent('b', 30_000), fp)
    addEv(charEvent('a', MINUTE_MS + 5_000), fp)

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
    addEv({ ...charEvent('a', 1_000), runId: 'run-1' }, fp)
    addEv({ ...charEvent('a', 2_000), runId: 'run-1' }, fp)
    addEv({ ...charEvent('b', 3_000), runId: 'run-2' }, fp)
    // Plain REC input (no runId) is its own '' bucket.
    addEv(charEvent('c', 4_000), fp)

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
    addEv(charEvent('a', 1_000), fp)
    addEv(charEvent('a', 2_000), fp)
    addEv(charEvent('b', 3_000), fp)

    const [snap] = buffer.drainAll()
    expect(snap.charCounts.get('a')).toBe(2)
    expect(snap.charCounts.get('b')).toBe(1)
  })

  it('accumulates matrix counts keyed by position, keeps the latest keycode', () => {
    const fp = fingerprint()
    addEv(matrixEvent(0, 3, 0, 0x04, 1_000), fp)
    addEv(matrixEvent(0, 3, 0, 0x04, 2_000), fp)
    addEv(matrixEvent(2, 1, 1, 0x4015, 3_000), fp)

    const [snap] = buffer.drainAll()
    expect(snap.matrixCounts.get('0,3,0')).toEqual({ row: 0, col: 3, layer: 0, keycode: 0x04, count: 2, tapCount: 0, holdCount: 0 })
    expect(snap.matrixCounts.get('2,1,1')).toEqual({ row: 2, col: 1, layer: 1, keycode: 0x4015, count: 1, tapCount: 0, holdCount: 0 })
  })

  it('computes interval stats from event timing', () => {
    const fp = fingerprint()
    // 5 events with intervals [100, 200, 300, 400]
    addEv(charEvent('a', 1_000), fp)
    addEv(charEvent('a', 1_100), fp)
    addEv(charEvent('a', 1_300), fp)
    addEv(charEvent('a', 1_600), fp)
    addEv(charEvent('a', 2_000), fp)

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
    addEv(charEvent('a', 1_000), fp1)
    addEv(charEvent('a', 2_000), fp2)

    const snapshots = buffer.drainAll()
    expect(snapshots).toHaveLength(2)
    const scope1Id = canonicalScopeKey(fp1)
    const scope2Id = canonicalScopeKey(fp2)
    expect(new Set(snapshots.map((s) => s.scopeId))).toEqual(new Set([scope1Id, scope2Id]))
  })

  it('drainClosed only returns entries whose minute ended at least the grace period before the boundary', () => {
    const fp = fingerprint()
    addEv(charEvent('a', 1_000), fp)                // minute 0
    addEv(charEvent('a', MINUTE_MS + 1_000), fp)    // minute 1
    addEv(charEvent('a', 2 * MINUTE_MS + 1_000), fp) // minute 2

    // 3 * MINUTE_MS comfortably clears minute 0 and minute 1's grace window
    // (each ended well over DRAIN_CLOSE_GRACE_MS ago) while minute 2 has
    // barely ended and must stay open.
    const closed = buffer.drainClosed(3 * MINUTE_MS)
    expect(closed.map((s) => s.minuteTs).sort((a, b) => a - b)).toEqual([0, MINUTE_MS])
    // Minute 2 is still live.
    expect(buffer.isEmpty()).toBe(false)

    const remaining = buffer.drainAll()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].minuteTs).toBe(2 * MINUTE_MS)
  })

  it('keeps activeMs monotonic when a late event arrives with an earlier ts', () => {
    const fp = fingerprint()
    addEv(charEvent('a', 1_000), fp)
    addEv(charEvent('a', 1_200), fp)
    // Out-of-order event: still counted, but lastEventMs must not walk back.
    addEv(charEvent('a', 1_100), fp)

    const [snap] = buffer.drainAll()
    expect(snap.keystrokes).toBe(3)
    expect(snap.activeMs).toBe(200)
  })

  it('extends firstEventMs backwards for a late event earlier than the first seen', () => {
    const fp = fingerprint()
    addEv(charEvent('a', 1_500), fp)
    addEv(charEvent('a', 2_000), fp)
    // Earlier than the first seen event — still within minute 0 since
    // MINUTE_MS = 60_000, so it rebuckets into the same entry.
    addEv(charEvent('a', 500), fp)

    const [snap] = buffer.drainAll()
    expect(snap.keystrokes).toBe(3)
    // Outer window is 500 → 2000, so activeMs = 1_500.
    expect(snap.activeMs).toBe(1_500)
  })

  it('handles a single-event minute with null percentile stats', () => {
    const fp = fingerprint()
    addEv(charEvent('a', 1_000), fp)

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
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp) // KC_A
      addEv(matrixEvent(0, 1, 0, 11, 1_120), fp) // KC_H, IKI=120
      addEv(matrixEvent(0, 2, 0, 7, 1_300), fp) // KC_D, IKI=180

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
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv(charEvent('a', 1_050), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_200), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['4_11', [200]]])
    })

    it('drops pairs whose IKI exceeds NGRAM_MAX_IKI_MS', () => {
      // NGRAM_MAX_IKI_MS = 5000ms. A 6-minute gap is far past that
      // ceiling, so the pair must be discarded.
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_000 + 6 * 60 * 1_000), fp)

      const [snapA, snapB] = buffer.drainAll()
      // Two minutes were buffered; check the merged result has no bigrams.
      const allBigrams = new Map([...snapA.bigrams, ...snapB.bigrams])
      expect(allBigrams.size).toBe(0)
    })

    it('records a pair whose gap lands exactly on NGRAM_MAX_IKI_MS', () => {
      // The comparison is `iki <= NGRAM_MAX_IKI_MS`, so the boundary
      // itself is still eligible — only strictly-slower pairs are cut.
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_000 + NGRAM_MAX_IKI_MS), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['4_11', [NGRAM_MAX_IKI_MS]]])
    })

    it('drops a pair whose gap is one ms past NGRAM_MAX_IKI_MS', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_000 + NGRAM_MAX_IKI_MS + 1), fp)

      const [snap] = buffer.drainAll()
      expect(snap.bigrams.size).toBe(0)
    })

    it('advances the chain past an over-cap gap so the next pair forms against the skipped event, not the one before it', () => {
      // B fails to pair with A (gap over the cap), but the chain still
      // moves forward to B. When C then arrives in range, it must pair
      // with B — the event the gap stranded — and not reach back to A.
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 0), fp) // A
      addEv(matrixEvent(0, 1, 0, 2, NGRAM_MAX_IKI_MS + 3_000), fp) // B, gap over cap: no pair
      addEv(matrixEvent(0, 2, 0, 3, NGRAM_MAX_IKI_MS + 3_100), fp) // C, gap=100: pairs with B

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['2_3', [100]]])
    })

    it('drops the cross-minute pair after drainClosed resets the chain', () => {
      // Production flow: the service calls drainClosed periodically;
      // when it fires between two matrix events that straddle a minute
      // boundary, the prior chain head is cleared and the new event has
      // no peer to pair against.
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 30_000), fp) // minute 0
      // Past the grace window so minute 0 actually closes on this call.
      const closed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS)
      expect(closed).toHaveLength(1)
      expect(closed[0].bigrams.size).toBe(0) // single event in minute 0, no pair to record yet

      addEv(matrixEvent(0, 1, 0, 11, 90_000), fp) // minute 1, but chain was just cleared
      addEv(matrixEvent(0, 2, 0, 7, 90_150), fp) // first valid pair within minute 1

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['11_7', [150]]])
    })

    it('attributes cross-minute pairs to the later minute when drainClosed has not run', () => {
      // Without drainClosed firing between events, the chain persists
      // across minutes, so the IKI-eligible pair lands in the snapshot
      // belonging to the later event. Attributing cross-minute pairs to
      // the new minute is the accepted design tradeoff. (A rate for how
      // often this happens used to be quoted here; it was derived when
      // an interval could span up to 5 minutes, so it no longer holds
      // now that NGRAM_MAX_IKI_MS caps eligibility at 5 s. Left
      // unquantified rather than carried forward as a stale number.)
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 58_000), fp) // minute 0
      addEv(matrixEvent(0, 1, 0, 11, 61_000), fp) // minute 1, IKI=3000 → still <= NGRAM_MAX_IKI_MS

      const snaps = buffer.drainAll()
      const minute0 = snaps.find((s) => s.minuteTs === 0)
      const minute1 = snaps.find((s) => s.minuteTs === 60_000)
      expect(minute0?.bigrams.size).toBe(0)
      expect([...(minute1?.bigrams.entries() ?? [])]).toEqual([['4_11', [3_000]]])
    })

    it('does not advance the chain on tied timestamps', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      // Tie ts — no bigram emitted (iki = 0) AND chain stays at keycode 4
      addEv(matrixEvent(0, 1, 0, 11, 1_000), fp)
      // Forward ts — should pair against the original 4 (chain didn't advance to 11)
      addEv(matrixEvent(0, 2, 0, 7, 1_150), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['4_7', [150]]])
    })

    it('clears the chain after drainAll so a fresh batch does not bridge', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      buffer.drainAll()
      // After drainAll, the previous keycode chain should be cleared, so
      // the next matrix event can't pair against a residual prior keycode.
      addEv(matrixEvent(0, 1, 0, 11, 1_500), fp)
      addEv(matrixEvent(0, 2, 0, 7, 1_650), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['11_7', [150]]])
    })
  })

  describe('trigram tracking', () => {
    it('records a triple after 3 consecutive matrix events as the average of the two intervals', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp) // KC_A
      addEv(matrixEvent(0, 1, 0, 11, 1_120), fp) // KC_H, iki1=120
      addEv(matrixEvent(0, 2, 0, 7, 1_300), fp) // KC_D, iki2=180

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([['4_11_7', [150]]]) // (120+180)/2
    })

    it('forms a rolling window of triples across 4+ events', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_100), fp) // iki=100
      addEv(matrixEvent(0, 2, 0, 7, 1_250), fp) // iki=150 -> triple 4_11_7 = 125
      addEv(matrixEvent(0, 3, 0, 5, 1_450), fp) // iki=200 -> triple 11_7_5 = 175

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([
        ['4_11_7', [125]],
        ['11_7_5', [175]],
      ])
    })

    it('does not pair across char events but stays transparent to the chain', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv(charEvent('a', 1_050), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_100), fp)
      addEv(charEvent('b', 1_150), fp)
      addEv(matrixEvent(0, 2, 0, 7, 1_300), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([['4_11_7', [150]]]) // (100+200)/2
    })

    it('drops the triple and resets the chain when the trailing interval exceeds NGRAM_MAX_IKI_MS', () => {
      // NGRAM_MAX_IKI_MS = 5000ms.
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_100), fp) // valid iki=100, chain=[4,11]
      addEv(matrixEvent(0, 2, 0, 7, 1_100 + 6 * 60_000), fp) // gap way past the cap: no triple, chain resets to [7]
      addEv(matrixEvent(0, 3, 0, 5, 1_100 + 6 * 60_000 + 120), fp) // chain=[7,5], still no triple (only 2 deep)

      const snaps = buffer.drainAll()
      const allTrigrams = new Map(snaps.flatMap((s) => [...s.trigrams]))
      expect(allTrigrams.size).toBe(0)
    })

    it('drops the triple entirely when only the leading interval is too slow', () => {
      // First interval exceeds NGRAM_MAX_IKI_MS; second interval (last->curr)
      // is fine on its own, but the stale k1 must not feed a triple.
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_000 + 6 * 60_000), fp) // gap too large -> chain resets to [11]
      addEv(matrixEvent(0, 2, 0, 7, 1_000 + 6 * 60_000 + 100), fp) // chain=[11,7], only 2 deep, no triple yet

      const snaps = buffer.drainAll()
      const allTrigrams = new Map(snaps.flatMap((s) => [...s.trigrams]))
      expect(allTrigrams.size).toBe(0)
    })

    it('rebuilds the trigram chain only once two consecutive in-range intervals follow an over-cap gap', () => {
      // A-B is in range and seeds the chain, then B-C blows past the cap:
      // no bigram, no triple, and prevIki goes stale even though k1 (B)
      // survives. C-D is the first in-range interval after the gap, but
      // a triple still needs a *second* one — D-E supplies it, and only
      // then does C_D_E emit.
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 1, 0), fp) // A
      addEv(matrixEvent(0, 1, 0, 2, 100), fp) // B, iki=100 (in range)
      addEv(matrixEvent(0, 2, 0, 3, 100 + NGRAM_MAX_IKI_MS + 3_000), fp) // C, gap over cap
      const cTs = 100 + NGRAM_MAX_IKI_MS + 3_000
      addEv(matrixEvent(0, 3, 0, 4, cTs + 100), fp) // D, iki=100 (in range, but only 1 interval since the gap)
      addEv(matrixEvent(0, 4, 0, 5, cTs + 200), fp) // E, iki=100 (2nd consecutive in-range interval)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([
        ['1_2', [100]],
        ['3_4', [100]],
        ['4_5', [100]],
      ])
      expect([...snap.trigrams.entries()]).toEqual([['3_4_5', [100]]])
    })

    it('does not advance the chain on tied timestamps', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_100), fp) // chain=[4,11]
      // Tie ts — discarded, chain stays at [4,11]
      addEv(matrixEvent(0, 2, 0, 99, 1_100), fp)
      // Forward ts — pairs against the un-advanced chain [4,11]
      addEv(matrixEvent(0, 3, 0, 7, 1_250), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([['4_11_7', [125]]]) // (100+150)/2
    })

    it('drops the cross-minute triple after drainClosed resets the chain', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 20_000), fp) // minute 0
      addEv(matrixEvent(0, 1, 0, 11, 40_000), fp) // minute 0, chain=[4,11]
      // Past the grace window so minute 0 actually closes on this call.
      const closed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS)
      expect(closed).toHaveLength(1)
      expect(closed[0].trigrams.size).toBe(0) // only 2 events so far, no triple yet

      // Chain was cleared by drainClosed, so this event starts fresh.
      addEv(matrixEvent(0, 2, 0, 7, 90_000), fp) // minute 1
      addEv(matrixEvent(0, 3, 0, 5, 90_150), fp) // minute 1, chain=[7,5]
      addEv(matrixEvent(0, 4, 0, 6, 90_300), fp) // minute 1, first valid triple

      const [snap] = buffer.drainAll()
      expect([...snap.trigrams.entries()]).toEqual([['7_5_6', [150]]])
    })

    it('clears the chain after drainAll so a fresh batch does not bridge', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_100), fp)
      buffer.drainAll()
      addEv(matrixEvent(0, 2, 0, 7, 1_500), fp)
      addEv(matrixEvent(0, 3, 0, 5, 1_650), fp)
      addEv(matrixEvent(0, 4, 0, 6, 1_800), fp)

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
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fpA)
      addEv(matrixEvent(0, 0, 0, 20, 1_050), fpB)
      addEv(matrixEvent(0, 1, 0, 11, 1_100), fpA)
      addEv(matrixEvent(0, 1, 0, 21, 1_150), fpB)
      addEv(matrixEvent(0, 2, 0, 7, 1_200), fpA)

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
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fpA)
      // Foreign scope restarts the chain, so 4 can no longer head a pair.
      addEv(matrixEvent(0, 0, 0, 20, 1_050), fpB)
      addEv(matrixEvent(0, 1, 0, 11, 1_100), fpA)
      addEv(matrixEvent(0, 2, 0, 7, 1_250), fpA)

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
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp)
      addEv({ ...matrixEvent(0, 1, 0, 11, 1_100), runId: 'run-1' }, fp)
      addEv({ ...matrixEvent(0, 2, 0, 7, 1_250), runId: 'run-1' }, fp)

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
      addEv({ ...matrixEvent(0, 0, 0, 4, 1_000), runId: 'run-1' }, fp)
      addEv({ ...matrixEvent(0, 1, 0, 11, 1_100), runId: 'run-1' }, fp)
      addEv({ ...matrixEvent(0, 2, 0, 7, 1_250), runId: 'run-1' }, fp)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([
        ['4_11', [100]],
        ['11_7', [150]],
      ])
      expect([...snap.trigrams.entries()]).toEqual([['4_11_7', [125]]]) // (100+150)/2
    })
  })

  describe('hold events break the n-gram chain', () => {
    it('does not pair a hold with the event before it', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp) // letter
      addEv(matrixEvent(1, 0, 0, 0x4015, 1_100, 'hold'), fp) // LT hold

      const [snap] = buffer.drainAll()
      expect(snap.bigrams.size).toBe(0)
    })

    it('does not pair a hold with the event after it — the chain restarted', () => {
      const fp = fingerprint()
      addEv(matrixEvent(1, 0, 0, 0x4015, 1_000, 'hold'), fp) // LT hold
      addEv(matrixEvent(0, 0, 0, 4, 1_100), fp) // letter

      const [snap] = buffer.drainAll()
      expect(snap.bigrams.size).toBe(0)
    })

    it('does not join two letters into a pair across an intervening hold', () => {
      // The naive "skip the hold and pair its neighbours" shortcut would
      // record 4_7 here (120+180=300ms apart); the chain must instead
      // treat the hold as a full reset so neither neighbour has anything
      // to pair against yet.
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp) // letter A
      addEv(matrixEvent(1, 0, 0, 0x4015, 1_120, 'hold'), fp) // Ctrl/LT hold
      addEv(matrixEvent(0, 1, 0, 7, 1_300), fp) // letter B

      const [snap] = buffer.drainAll()
      expect(snap.bigrams.size).toBe(0)
      expect(snap.bigrams.has('4_7')).toBe(false)
    })

    it('lets a tap event participate in the chain exactly like an unmarked event', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000, 'tap'), fp)
      addEv(matrixEvent(0, 1, 0, 11, 1_120, 'tap'), fp)

      const [snap] = buffer.drainAll()
      expect([...snap.bigrams.entries()]).toEqual([['4_11', [120]]])
    })

    it('still counts a hold toward keystrokes and matrix holdCount', () => {
      const fp = fingerprint()
      addEv(matrixEvent(1, 0, 0, 0x4015, 1_000, 'hold'), fp)

      const [snap] = buffer.drainAll()
      expect(snap.keystrokes).toBe(1)
      expect(snap.matrixCounts.get('1,0,0')).toEqual({
        row: 1,
        col: 0,
        layer: 0,
        keycode: 0x4015,
        count: 1,
        tapCount: 0,
        holdCount: 1,
      })
    })

    it('does not emit a trigram spanning a hold', () => {
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 1_000), fp) // A
      addEv(matrixEvent(0, 1, 0, 11, 1_100), fp) // B, chain=[4,11]
      addEv(matrixEvent(1, 0, 0, 0x4015, 1_200, 'hold'), fp) // hold resets chain
      addEv(matrixEvent(0, 2, 0, 7, 1_300), fp) // C, chain=[7] only

      const [snap] = buffer.drainAll()
      // Only the A-B pair survives; nothing pairs or triples through the hold.
      expect([...snap.bigrams.entries()]).toEqual([['4_11', [100]]])
      expect(snap.trigrams.size).toBe(0)
    })
  })

  describe('drainClosed grace period', () => {
    it('does not finalize a minute that ended less than the grace period ago', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 30_000), fp) // minute 0, ends at MINUTE_MS
      // "Now" is just past the minute boundary, well inside the grace window.
      const closed = buffer.drainClosed(MINUTE_MS + 500)
      expect(closed).toHaveLength(0)
      expect(buffer.isEmpty()).toBe(false)
    })

    it('finalizes a minute once it ended longer ago than the grace period', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 30_000), fp) // minute 0, ends at MINUTE_MS
      const closed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS + 1)
      expect(closed).toHaveLength(1)
      expect(closed[0].minuteTs).toBe(0)
      expect(buffer.isEmpty()).toBe(true)
    })

    it('always exceeds MAX_TAP_HOLD_DEFER_MS, so a press deferred up to the cap always finds its minute still open', () => {
      // Guards against the two constants drifting apart independently: the
      // renderer never defers a press past MAX_TAP_HOLD_DEFER_MS, so the
      // grace only needs to be strictly larger than that cap (plus jitter
      // margin) — not sized off the keyboard's raw, unbounded TAPPING_TERM.
      expect(DRAIN_CLOSE_GRACE_MS).toBeGreaterThan(MAX_TAP_HOLD_DEFER_MS)
    })
  })

  it('exposes an empty bigrams map when no matrix events arrived', () => {
    // Sanity check: the Map exists on every snapshot (downstream emit
    // layer relies on snapshot.bigrams.size, not optional access).
    const fp = fingerprint()
    addEv(charEvent('a', 1_000), fp)
    const [snap] = buffer.drainAll()
    expect(snap.bigrams.size).toBe(0)
    expect(snap.trigrams.size).toBe(0)
  })

  describe('app-name tagging', () => {
    it('returns null appName when markAppName never fires', () => {
      // Default state: aggregator never observed an active app, so the
      // snapshot must say "unknown / not collected" rather than guess.
      const fp = fingerprint()
      addEv(charEvent('a', 1_000), fp)
      const [snap] = buffer.drainAll()
      expect(snap.appName).toBeNull()
    })

    it('returns the single app when only one was observed', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 1_000), fp)
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
      addEv(charEvent('a', 1_000), fp)
      buffer.markAppName('VSCode')
      buffer.markAppName('Slack')
      const [snap] = buffer.drainAll()
      expect(snap.appName).toBeNull()
    })

    it('treats the same app tagged twice as a single observation', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 1_000), fp)
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
      addEv(charEvent('a', 1_000), fp)
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
      addEv(charEvent('a', 1_000), fpA)
      addEv(charEvent('b', 1_000), fpB)
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
      addEv(charEvent('a', 1_000), fp)
      buffer.markAppName('VSCode')
      buffer.drainAll()
      addEv(charEvent('b', MINUTE_MS + 500), fp)
      buffer.markAppName('Slack')
      const [snap] = buffer.drainAll()
      expect(snap.appName).toBe('Slack')
    })

    it('drainClosed produces appName for closed minutes only', () => {
      // The boundary case the live heatmap relies on: closed minutes
      // ship with their final appName, while the open minute keeps its
      // app set alive for further tagging.
      const fp = fingerprint()
      addEv(matrixEvent(0, 0, 0, 4, 500), fp) // minute 0
      addEv(matrixEvent(0, 0, 0, 4, MINUTE_MS + 500), fp) // minute 1
      buffer.markAppName('VSCode')
      // Past the grace window so minute 0 actually closes on this call.
      const closed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS)
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

  describe('retention and full re-send', () => {
    it('re-finalizes the whole minute (not just the late event) when a straggler arrives after drainClosed', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 30_000), fp) // minute 0, 1 keystroke so far
      // Close minute 0 — the renderer's deferred-emit deadline plus jitter
      // has passed, so drainClosed treats it as closed and finalizes it.
      const firstClosed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS)
      expect(firstClosed).toHaveLength(1)
      expect(firstClosed[0].keystrokes).toBe(1)

      // A genuinely late event for minute 0 arrives well after the grace
      // window (but within retention) — e.g. a tap-hold press deferred by
      // IPC jitter beyond DRAIN_CLOSE_GRACE_MS.
      const lateNow = MINUTE_MS + DRAIN_CLOSE_GRACE_MS + 500
      addEv(charEvent('a', 30_500), fp, lateNow)

      // The next drain must emit ONE cumulative snapshot with BOTH
      // keystrokes — not a partial snapshot containing only the straggler,
      // which would replace the DB's real total through the LWW merge.
      const secondClosed = buffer.drainClosed(lateNow + DRAIN_CLOSE_GRACE_MS + 1)
      expect(secondClosed).toHaveLength(1)
      expect(secondClosed[0].minuteTs).toBe(0)
      expect(secondClosed[0].keystrokes).toBe(2)
      expect(secondClosed[0].charCounts.get('a')).toBe(2)
    })

    it('does not re-emit a retained entry that has not changed since its last finalize', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 30_000), fp)
      const firstClosed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS)
      expect(firstClosed).toHaveLength(1)

      // Nothing new arrived — a later drain call must not re-emit the same,
      // unchanged minute a second time.
      const secondClosed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS + 10_000)
      expect(secondClosed).toHaveLength(0)
    })

    it('drops an event whose minute has already aged past RETENTION_MS instead of starting a fresh partial entry', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 30_000), fp) // minute 0
      // Close and evict minute 0 in one call: nowMs is past both grace and
      // retention for minute 0.
      const nowMs = MINUTE_MS + RETENTION_MS + 1
      const closed = buffer.drainClosed(nowMs)
      expect(closed).toHaveLength(1)
      expect(buffer.isEmpty()).toBe(true)

      // An ultra-late event still targeting minute 0 arrives after eviction.
      addEv(charEvent('a', 30_100), fp, nowMs + 100)
      // Dropped — no new entry, nothing to drain.
      expect(buffer.isEmpty()).toBe(true)
      expect(buffer.drainAll()).toEqual([])
    })

    it('reports isEmpty() true when only retained-clean entries remain (no infinite reschedule)', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 30_000), fp)
      const closed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS)
      expect(closed).toHaveLength(1)
      // The entry is retained (not deleted) but clean — isEmpty must treat
      // it as empty, or a service loop keyed on isEmpty() would reschedule
      // a flush forever even though there is nothing left to do.
      expect(buffer.isEmpty()).toBe(true)
    })

    it('peekMatrixCountsForUid excludes an entry once flushed, even after it is reopened dirty', () => {
      const fp = fingerprint()
      addEv(matrixEvent(1, 2, 0, 0x04, 30_000), fp)
      expect(buffer.peekMatrixCountsForUid('0xAABB', 'hash-abc', 0).get('1,2')?.total).toBe(1)

      // Flush the minute — its count is now in the DB, so peek must stop
      // reporting it (double-counting against the DB row otherwise).
      const closed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS)
      expect(closed).toHaveLength(1)
      expect(buffer.peekMatrixCountsForUid('0xAABB', 'hash-abc', 0).size).toBe(0)

      // A straggler reopens the entry (dirty again) — still excluded from
      // peek, since its cumulative count (now 2) would double-count the 1
      // already reported.
      const lateNow = MINUTE_MS + DRAIN_CLOSE_GRACE_MS + 500
      addEv(matrixEvent(1, 2, 0, 0x04, 30_100), fp, lateNow)
      expect(buffer.peekMatrixCountsForUid('0xAABB', 'hash-abc', 0).size).toBe(0)
    })

    it('drainAll retains entries so a post-drainAll straggler lands in the retained entry and the next drain emits the full cumulative snapshot', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 1_000), fp)
      const all = buffer.drainAll()
      expect(all).toHaveLength(1)
      expect(all[0].keystrokes).toBe(1)

      // A straggler for the same minute arrives after the final flush
      // (e.g. record-off flush raced by an in-flight matrix event).
      addEv(charEvent('a', 1_500), fp, 2_000)
      // Not yet re-emitted — the entry is dirty but drainClosed hasn't run.
      expect(buffer.isEmpty()).toBe(false)

      const closed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS + 1)
      expect(closed).toHaveLength(1)
      expect(closed[0].minuteTs).toBe(0)
      expect(closed[0].keystrokes).toBe(2)
      expect(closed[0].charCounts.get('a')).toBe(2)
    })

    it('reopenAll flips retained entries back to reopened so a failed persist re-sends the full cumulative snapshot next drain', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 30_000), fp)
      const closed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS)
      expect(closed).toHaveLength(1)
      // Nothing to re-emit right now — the entry is clean.
      expect(buffer.isEmpty()).toBe(true)

      // Simulate the flush pass's persistence step throwing after the
      // drain already captured this snapshot: the caller reopens the
      // buffer instead of accepting the drained data as lost.
      buffer.reopenAll()
      expect(buffer.isEmpty()).toBe(false)

      // The next drain re-sends the FULL cumulative minute (still just
      // the one keystroke here — nothing new arrived — proving the
      // re-send is the complete snapshot, not an empty/partial one).
      const resent = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS + 1)
      expect(resent).toHaveLength(1)
      expect(resent[0].minuteTs).toBe(0)
      expect(resent[0].keystrokes).toBe(1)
      expect(resent[0].charCounts.get('a')).toBe(1)
    })

    it('reopenAll combined with a genuine straggler still re-sends the full cumulative total, not a duplicate-inflated one', () => {
      const fp = fingerprint()
      addEv(charEvent('a', 30_000), fp)
      buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS)

      // Persist failed for this pass — reopen it for retry...
      buffer.reopenAll()
      // ...and, independently, a real straggler for the same minute also
      // arrives before the retry drain runs.
      const lateNow = MINUTE_MS + DRAIN_CLOSE_GRACE_MS + 500
      addEv(charEvent('a', 30_100), fp, lateNow)

      const resent = buffer.drainClosed(lateNow + DRAIN_CLOSE_GRACE_MS)
      expect(resent).toHaveLength(1)
      expect(resent[0].keystrokes).toBe(2)
      expect(resent[0].charCounts.get('a')).toBe(2)
    })

    it('reopenAll leaves an open (never-finalized) entry untouched — nothing to re-emit for it', () => {
      const fp = fingerprint()
      // Still within the grace window — never finalized yet.
      addEv(charEvent('a', 30_000), fp)
      buffer.reopenAll()
      // Reopening a never-finalized entry is a no-op: still just the one
      // open, unflushed minute — not two, and not prematurely closed.
      expect(buffer.drainClosed(30_000)).toHaveLength(0)
      const closed = buffer.drainClosed(MINUTE_MS + DRAIN_CLOSE_GRACE_MS)
      expect(closed).toHaveLength(1)
      expect(closed[0].keystrokes).toBe(1)
    })
  })

  describe('invariants', () => {
    it('RETENTION_MS exceeds DRAIN_CLOSE_GRACE_MS, so drainClosed can never evict an entry it has not had the chance to finalize first', () => {
      // If this ever inverted (e.g. DRAIN_CLOSE_GRACE_MS growing past
      // RETENTION_MS because MAX_TAP_HOLD_DEFER_MS changed), drainClosed's
      // per-entry finalize-then-evict order would stop guaranteeing a
      // dirty entry gets its last cumulative re-send before eviction —
      // this pins the invariant so that regression fails loudly here
      // instead of silently dropping data in production.
      expect(RETENTION_MS).toBeGreaterThan(DRAIN_CLOSE_GRACE_MS)
    })
  })
})
