// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach } from 'vitest'
import { TypingAnalyticsAggregator } from '../aggregator'
import type {
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
} from '../../../shared/types/typing-analytics'
import { canonicalScopeKey } from '../../../shared/types/typing-analytics'

function fingerprint(overrides: Partial<TypingAnalyticsFingerprint['keyboard']> = {}): TypingAnalyticsFingerprint {
  return {
    machineHash: 'machine-hash-abc',
    os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
    keyboard: {
      uid: '0xAABB',
      vendorId: 0xFEED,
      productId: 0x0000,
      productName: 'Pipette Keyboard',
      ...overrides,
    },
  }
}

function charEvent(key: string, ts = 1000): TypingAnalyticsEvent {
  return { kind: 'char', key, ts, keyboard: { uid: 'x', vendorId: 0, productId: 0, productName: '' } }
}

function matrixEvent(row: number, col: number, layer: number, keycode: number, ts = 1000): TypingAnalyticsEvent {
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

describe('TypingAnalyticsAggregator', () => {
  let agg: TypingAnalyticsAggregator

  beforeEach(() => {
    agg = new TypingAnalyticsAggregator()
  })

  it('starts empty', () => {
    expect(agg.isEmpty()).toBe(true)
    expect(agg.getScopes().size).toBe(0)
  })

  it('accumulates char events into per-char counts', () => {
    const fp = fingerprint()
    agg.addEvent(charEvent('a'), fp)
    agg.addEvent(charEvent('a'), fp)
    agg.addEvent(charEvent('b'), fp)

    const entry = agg.getScopes().get(canonicalScopeKey(fp))!
    expect(entry.charCounts).toEqual({ a: 2, b: 1 })
    expect(entry.matrixCounts).toEqual({})
  })

  it('accumulates matrix events into per-position counts and keeps the keycode', () => {
    const fp = fingerprint()
    agg.addEvent(matrixEvent(0, 3, 0, 0x04), fp)
    agg.addEvent(matrixEvent(0, 3, 0, 0x04), fp)
    agg.addEvent(matrixEvent(2, 1, 1, 0x4015), fp)

    const entry = agg.getScopes().get(canonicalScopeKey(fp))!
    expect(entry.matrixCounts['0,3,0']).toEqual({ count: 2, keycode: 0x04 })
    expect(entry.matrixCounts['2,1,1']).toEqual({ count: 1, keycode: 0x4015 })
  })

  it('keeps separate entries per scope key', () => {
    const fp1 = fingerprint({ uid: '0xAABB' })
    const fp2 = fingerprint({ uid: '0xCCDD' })

    agg.addEvent(charEvent('a'), fp1)
    agg.addEvent(charEvent('a'), fp2)
    agg.addEvent(charEvent('a'), fp2)

    const scopes = agg.getScopes()
    expect(scopes.size).toBe(2)
    expect(scopes.get(canonicalScopeKey(fp1))!.charCounts).toEqual({ a: 1 })
    expect(scopes.get(canonicalScopeKey(fp2))!.charCounts).toEqual({ a: 2 })
  })

  it('ignores productName when keying scopes', () => {
    const fp1 = fingerprint({ productName: 'Pipette Keyboard' })
    const fp2 = fingerprint({ productName: 'Pipette Keyboard (win)' })

    agg.addEvent(charEvent('a'), fp1)
    agg.addEvent(charEvent('a'), fp2)

    expect(agg.getScopes().size).toBe(1)
    const entry = agg.getScopes().get(canonicalScopeKey(fp1))!
    expect(entry.charCounts.a).toBe(2)
  })

  it('clear() empties the aggregator', () => {
    agg.addEvent(charEvent('a'), fingerprint())
    agg.clear()
    expect(agg.isEmpty()).toBe(true)
  })
})
