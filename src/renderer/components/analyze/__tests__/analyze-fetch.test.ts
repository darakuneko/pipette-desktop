// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Coverage for the in-flight de-dupe on `listMinuteStatsForScope`:
// concurrent identical calls must share one underlying vialAPI
// invocation, and a call issued after the shared promise has already
// settled must trigger a fresh one (no result caching / staleness).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { listMinuteStatsForScope } from '../analyze-fetch'
import type { TypingMinuteStatsRow } from '../../../../shared/types/typing-analytics'

const localSpy = vi.fn<(...args: unknown[]) => Promise<TypingMinuteStatsRow[]>>()

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsListMinuteStatsLocal: (...args: unknown[]) => localSpy(...args),
  },
  writable: true,
  configurable: true,
})

const range = { fromMs: 0, toMs: 60_000 }
const rows: TypingMinuteStatsRow[] = [{
  minuteMs: 0, keystrokes: 5, activeMs: 500,
  intervalMinMs: 50, intervalP25Ms: 100, intervalP50Ms: 150, intervalP75Ms: 200, intervalMaxMs: 400,
}]

/** Deferred promise so the test controls exactly when the underlying
 * call resolves, keeping two concurrent calls genuinely overlapping. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('listMinuteStatsForScope in-flight de-dupe', () => {
  beforeEach(() => {
    localSpy.mockReset()
  })

  it('shares one underlying vialAPI invocation for concurrent identical calls', async () => {
    const { promise, resolve } = deferred<TypingMinuteStatsRow[]>()
    localSpy.mockReturnValue(promise)

    const call1 = listMinuteStatsForScope('0xAABB', 'own', range.fromMs, range.toMs, [], [], [])
    const call2 = listMinuteStatsForScope('0xAABB', 'own', range.fromMs, range.toMs, [], [], [])

    expect(localSpy).toHaveBeenCalledTimes(1)

    resolve(rows)
    const [result1, result2] = await Promise.all([call1, call2])
    expect(result1).toBe(rows)
    expect(result2).toBe(rows)
    expect(localSpy).toHaveBeenCalledTimes(1)
  })

  it('issues a fresh invocation for a call made after the shared promise settles', async () => {
    localSpy.mockResolvedValueOnce(rows)
    await listMinuteStatsForScope('0xAABB', 'own', range.fromMs, range.toMs, [], [], [])
    expect(localSpy).toHaveBeenCalledTimes(1)

    localSpy.mockResolvedValueOnce(rows)
    await listMinuteStatsForScope('0xAABB', 'own', range.fromMs, range.toMs, [], [], [])
    expect(localSpy).toHaveBeenCalledTimes(2)
  })

  it('does not de-dupe calls with different filter args', async () => {
    localSpy.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows)
    const call1 = listMinuteStatsForScope('0xAABB', 'own', range.fromMs, range.toMs, [], [], [])
    const call2 = listMinuteStatsForScope('0xAABB', 'own', range.fromMs, range.toMs, ['Code'], [], [])
    await Promise.all([call1, call2])
    expect(localSpy).toHaveBeenCalledTimes(2)
  })

  it('clears the in-flight entry even when the underlying call rejects', async () => {
    localSpy.mockRejectedValueOnce(new Error('boom'))
    await expect(listMinuteStatsForScope('0xAABB', 'own', range.fromMs, range.toMs, [], [], [])).rejects.toThrow('boom')

    localSpy.mockResolvedValueOnce(rows)
    await listMinuteStatsForScope('0xAABB', 'own', range.fromMs, range.toMs, [], [], [])
    expect(localSpy).toHaveBeenCalledTimes(2)
  })
})
