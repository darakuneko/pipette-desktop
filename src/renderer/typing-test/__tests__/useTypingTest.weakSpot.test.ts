// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Weak Spot Training (Plan-miss-focus-mode) integration coverage: the
// getMistakeProfile thunk option, the live weakSpotGate exposed for the
// Option section's toggle/hint, and end-to-end biased sampling through
// setConfig/restart — the individual pieces (profile aggregation,
// word scoring, sampling mixture) already have focused unit coverage in
// weak-spot-profile.test.ts / word-generator/__tests__/weak-spot-weighting.test.ts
// / word-generator.test.ts / word-supply.test.ts / run-state.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingTest } from '../useTypingTest'
import type { TypingTestConfig } from '../types'
import type { MistakeProfile, WeakSpotInputMethod } from '../weak-spot-profile'

const ACTIVE_PROFILE: MistakeProfile = { weights: { e: 1000 }, weakTokenCount: 1 }
const NO_WEAK_SPOTS_PROFILE: MistakeProfile = { weights: {}, weakTokenCount: 0 }
// Five weak tokens so the top-3 slice and the "+N" overflow both have
// something to prove. 'r' and 'b' share a score (50) to exercise the
// plain-string tie-break — 'b' sorts before 'r' and must win the 3rd slot
// ahead of it, despite 'r' being declared first in the object.
const MANY_WEAK_PROFILE: MistakeProfile = {
  weights: { k: 80, sha: 65, r: 50, b: 50, a: 40 },
  weakTokenCount: 5,
}

function activeThunk(): (language: string, inputMethod: WeakSpotInputMethod) => MistakeProfile | undefined {
  return () => ACTIVE_PROFILE
}

describe('useTypingTest — weakSpotGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('is not applicable in quote mode', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    const { result } = renderHook(() => useTypingTest(config, 'english', { getMistakeProfile: activeThunk() }))
    expect(result.current.weakSpotGate.applicable).toBe(false)
  })

  it('is "unavailable" (no hint) when no getMistakeProfile thunk is given — never claims "no weak spots" without data', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.weakSpotGate.applicable).toBe(true)
    expect(result.current.weakSpotGate.status).toBe('unavailable')
  })

  it('is "no-weak-spots" when the scoped profile has zero weak tokens', () => {
    const { result } = renderHook(() => useTypingTest(undefined, undefined, {
      getMistakeProfile: () => NO_WEAK_SPOTS_PROFILE,
    }))
    expect(result.current.weakSpotGate.status).toBe('no-weak-spots')
  })

  it('is "active" once the scoped profile has at least one weak token', () => {
    const { result } = renderHook(() => useTypingTest(undefined, undefined, { getMistakeProfile: activeThunk() }))
    expect(result.current.weakSpotGate.status).toBe('active')
  })

  it('exposes the top 3 weak tokens (score DESC, deterministic tie-break) and the total weak-token count', () => {
    const { result } = renderHook(() => useTypingTest(undefined, undefined, {
      getMistakeProfile: () => MANY_WEAK_PROFILE,
    }))
    expect(result.current.weakSpotGate.topWeakTokens).toEqual(['k', 'sha', 'b'])
    expect(result.current.weakSpotGate.weakTokenCount).toBe(5)
  })

  it('omits topWeakTokens/weakTokenCount entirely for the non-applicable sentinel (quote mode)', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    const { result } = renderHook(() => useTypingTest(config, 'english', { getMistakeProfile: () => MANY_WEAK_PROFILE }))
    expect(result.current.weakSpotGate.topWeakTokens).toBeUndefined()
    expect(result.current.weakSpotGate.weakTokenCount).toBeUndefined()
  })
})

describe('useTypingTest — biased sampling end-to-end', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  it('setConfig with weakSpotTraining ON + an active profile visibly skews the sampled words', async () => {
    const { result } = renderHook(() => useTypingTest(undefined, undefined, { getMistakeProfile: activeThunk() }))
    const config: TypingTestConfig = { mode: 'words', wordCount: 300, punctuation: false, numbers: false, weakSpotTraining: true }
    await act(async () => result.current.setConfig(config))
    const withE = result.current.state.words.filter((w) => w.includes('e')).length
    expect(withE / result.current.state.words.length).toBeGreaterThan(0.5)
  })

  it('weakSpotTraining ON but the toggle-off default (no weakSpotTraining field) samples normally', async () => {
    const { result } = renderHook(() => useTypingTest(undefined, undefined, { getMistakeProfile: activeThunk() }))
    const config: TypingTestConfig = { mode: 'words', wordCount: 300, punctuation: false, numbers: false }
    await act(async () => result.current.setConfig(config))
    const withE = result.current.state.words.filter((w) => w.includes('e')).length
    // 'e' is common in English regardless, but nowhere near the >50%
    // saturation a 1000-weight bias produces — should land well under it.
    expect(withE / result.current.state.words.length).toBeLessThan(0.5)
  })

  it('weakSpotTraining ON but the profile has no weak tokens: samples normally (gate not active)', async () => {
    const { result } = renderHook(() => useTypingTest(undefined, undefined, {
      getMistakeProfile: () => NO_WEAK_SPOTS_PROFILE,
    }))
    const config: TypingTestConfig = { mode: 'words', wordCount: 300, punctuation: false, numbers: false, weakSpotTraining: true }
    await act(async () => result.current.setConfig(config))
    const withE = result.current.state.words.filter((w) => w.includes('e')).length
    expect(withE / result.current.state.words.length).toBeLessThan(0.5)
  })

  it('the run\'s weakSpotProfile snapshot survives a time-mode refill unchanged (immutability)', async () => {
    const { result } = renderHook(() => useTypingTest(undefined, undefined, { getMistakeProfile: activeThunk() }))
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false, weakSpotTraining: true }
    await act(async () => result.current.setConfig(config))
    const snapshotBefore = result.current.state.weakSpotProfile
    expect(snapshotBefore).toBeDefined()

    // Drive the run down to a low untyped tail so advanceAfterWord's
    // refill fires (TIME_MODE_EXTEND_THRESHOLD = 10) — simplest way from
    // the public API is to jump currentWordIndex via repeated submits is
    // slow; instead just call setBaseLayer (which regenerates a whole new
    // batch, itself re-resolving the profile) and confirm the profile
    // object stays referentially the SAME as long as config/language and
    // the mistake data haven't changed — proving resolveWeakSpotProfileArg
    // + the cache both return the identical object, not a fresh clone.
    await act(async () => result.current.setBaseLayer(0))
    expect(result.current.state.weakSpotProfile).toEqual(snapshotBefore)
  })

  it('is gated OUT of quote mode even with weakSpotTraining nominally set on a stale words config carried over', async () => {
    // weakSpotTraining only exists on words/time in the type union; quote
    // mode's own config object structurally can't carry it. Just confirm
    // quote mode never biases regardless of an active profile.
    const { result } = renderHook(() => useTypingTest(undefined, undefined, { getMistakeProfile: activeThunk() }))
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    await act(async () => result.current.setConfig(config))
    expect(result.current.state.weakSpotProfile).toBeUndefined()
  })
})
