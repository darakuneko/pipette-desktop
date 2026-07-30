// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  analyzeTappingTerm,
  clampBelowStrict,
  TAPPING_TERM_MIN_SAMPLES,
} from '../analyze-tapping-term'

// Bucket grid reminder (shared/duration-buckets.ts):
//   0: <50   1: 50-80   2: 80-110   3: 110-140   4: 140-180
//   5: 180-250   6: 250-400   7: >=400 (synthetic span [400, 800))
//
// Every fixture's floor/share checks denominate against TAP-SIDE
// (+straddle) mass, never the sum of the whole array — see the
// "tap-side denominators" describe block below for the counterexamples
// that motivated this.

describe('analyzeTappingTerm', () => {
  it('returns unknown (insufficientSamples) when the sample floor is not met', () => {
    const hist = [TAPPING_TERM_MIN_SAMPLES - 1, 0, 0, 0, 0, 0, 0, 0]
    const result = analyzeTappingTerm(hist, 200)
    expect(result.verdict).toBe('unknown')
    expect(result.unknownReason).toBe('insufficientSamples')
    expect(result.tapP95Range).toBeNull()
    expect(result.holdP5Range).toBeNull()
    expect(result.suggestedMs).toBeNull()
  })

  it('passes the floor at exactly the threshold count', () => {
    // 200 samples, all comfortably below the term with a clean gap —
    // this should NOT fall back to unknown just because the total
    // sits exactly at the floor.
    const hist = [200, 0, 0, 0, 0, 0, 0, 0]
    const result = analyzeTappingTerm(hist, 200)
    expect(result.verdict).not.toBe('unknown')
  })

  it('returns unknown (noTapMass) when every recorded duration is already at/above the term', () => {
    // currentMs=20 sits inside bucket 0 (<50), so bucket 0 straddles
    // and nothing is classified "below" — there is no sub-T mass to
    // compute a tap p95 from at all. The straddle bucket's own mass
    // (220) is what clears the tap-side floor here since "below" mass
    // is always 0 when the term lands inside bucket 0.
    const hist = [220, 0, 0, 0, 0, 0, 0, 0]
    const result = analyzeTappingTerm(hist, 20)
    expect(result.verdict).toBe('unknown')
    expect(result.unknownReason).toBe('noTapMass')
    expect(result.tapP95Range).toBeNull()
  })

  it('reports nearTerm when significant mass sits in the bucket straddling the term', () => {
    // currentMs=200 -> bucket 5 (180-250) straddles. Tap-side(+straddle)
    // mass is 150+50=200 (clears the floor exactly); 50/200 = 25% of
    // that sits in the straddle bucket, well above
    // TAPPING_TERM_NEAR_TERM_SHARE (5%) — long taps and fast holds are
    // genuinely indistinguishable here, regardless of the tap-side p95.
    const hist = [150, 0, 0, 0, 0, 50, 0, 50]
    const result = analyzeTappingTerm(hist, 200)
    expect(result.verdict).toBe('nearTerm')
    expect(result.unknownReason).toBeNull()
    expect(result.suggestedMs).toBeNull()
    expect(result.tapP95Range).toEqual({ lo: 0, hi: 50 })
  })

  it('reports nearTerm when the tap p95 bucket confidently fails the margin (range entirely past the margin line)', () => {
    // currentMs=110 lands exactly on the bucket 2/3 boundary, so no
    // bucket straddles the term (straddle mass is 0 — this is NOT the
    // mass-based nearTerm path). The p95 bucket is [80, 110]; with a
    // 30ms margin the threshold is 80, so lo(80) >= threshold(80): the
    // range confidently does not clear, even at its most optimistic end.
    const hist = [10, 10, 180, 0, 0, 0, 0, 0]
    const result = analyzeTappingTerm(hist, 110)
    expect(result.verdict).toBe('nearTerm')
    expect(result.unknownReason).toBeNull()
    expect(result.tapP95Range).toEqual({ lo: 80, hi: 110 })
    expect(result.suggestedMs).toBeNull()
  })

  it('returns unknown (bucketResolution) when the tap p95 bucket straddles the ok/nearTerm decision boundary', () => {
    // currentMs=195 -> bucket 5 (180-250) straddles the term itself,
    // but its mass is 0 (not the mass-based nearTerm trigger). The p95
    // bucket is [140, 180]; threshold = 195-30 = 165, which falls
    // strictly inside that bucket's range (140 < 165 < 180) — bucket
    // resolution can't say whether the true p95 clears the margin.
    const hist = [50, 50, 50, 50, 100, 0, 0, 50]
    const result = analyzeTappingTerm(hist, 195)
    expect(result.verdict).toBe('unknown')
    expect(result.unknownReason).toBe('bucketResolution')
    expect(result.tapP95Range).toEqual({ lo: 140, hi: 180 })
  })

  it('blocks canLower when mass sits just below the term, even though it is not "significant" (censoring guard)', () => {
    // currentMs=200, threshold=170. p95 bucket is [0,50] (clears
    // easily) but 15/285 ≈ 5.3% of the tap-side(+straddle) mass sits in
    // the gap between that bucket and the term (10 in bucket 4, 5 in
    // the straddling bucket 5) — comfortably below
    // TAPPING_TERM_NEAR_TERM_SHARE (so this is NOT nearTerm), but above
    // the stricter TAPPING_TERM_CLEAN_GAP_SHARE (1%), so canLower's
    // censoring guard must still refuse a numeric suggestion.
    const hist = [270, 0, 0, 0, 10, 5, 0, 15]
    const result = analyzeTappingTerm(hist, 200)
    expect(result.verdict).toBe('ok')
    expect(result.unknownReason).toBeNull()
    expect(result.suggestedMs).toBeNull()
    expect(result.tapP95Range).toEqual({ lo: 0, hi: 50 })
  })

  it('reports canLower with a clean gap and a hold side present', () => {
    // p95 bucket [0,50], gap to the term is empty (gapShare=0), hold
    // side sits far away in the open top bucket ([400, 800)) — every
    // condition for canLower is met.
    const hist = [285, 0, 0, 0, 0, 0, 0, 15]
    const result = analyzeTappingTerm(hist, 200)
    expect(result.verdict).toBe('canLower')
    expect(result.unknownReason).toBeNull()
    expect(result.tapP95Range).toEqual({ lo: 0, hi: 50 })
    expect(result.holdP5Range).toEqual({ lo: 400, hi: 800 })
    // suggestedMs = round5(hi(50) + margin(30)) = 80, clamped strictly
    // below both currentMs(200) and holdP5Range.lo(400).
    expect(result.suggestedMs).toBe(80)
  })

  it('reports canLower when the hold side is entirely absent', () => {
    const hist = [285, 0, 0, 0, 0, 0, 0, 0]
    const result = analyzeTappingTerm(hist, 200)
    expect(result.verdict).toBe('canLower')
    expect(result.holdP5Range).toBeNull()
    expect(result.suggestedMs).toBe(80)
  })

  it('blocks canLower when the hold side sits too close to the tap-derived suggestion', () => {
    // currentMs=140 lands exactly on the bucket 3/4 boundary (no
    // straddle bucket). p95 bucket is [80,110] (bucket 2, with bucket
    // 3 empty so the percentile doesn't shift forward): threshold =
    // 140-30 = 110, and hi(110) <= 110 clears (boundary inclusive).
    // Raw suggestion = round5(110+30) = 140, which equals the term
    // itself and gets clamped to 135. The hold p5 bucket is [140,180]
    // (lo=140, bucket 4) — 140 - 135 = 5, under the 30ms margin, so
    // the suggestion must be refused even though the tap side alone
    // looked clean. (135 also fails the tap-margin check below, since
    // 135 < 110+30=140 — both guards independently block this case.)
    const hist = [10, 10, 180, 0, 50, 0, 0, 0]
    const result = analyzeTappingTerm(hist, 140)
    expect(result.verdict).toBe('ok')
    expect(result.suggestedMs).toBeNull()
    expect(result.tapP95Range).toEqual({ lo: 80, hi: 110 })
    expect(result.holdP5Range).toEqual({ lo: 140, hi: 180 })
  })

  it('falls back to ok when clamping a boundary suggestion would eat into its own margin (codex counterexample)', () => {
    // p95 bucket [140,180] -> raw suggestion = 180 + 30 = 210. With
    // currentMs=210 the raw suggestion equals the term itself exactly
    // (hi(180) <= threshold(180), boundary inclusive, so the tap side
    // "clears"), but clamping strictly below 210 floors it to 205 —
    // only 25ms above tapP95Range.hi, not the 30ms margin the `clears`
    // decision relied on. That contradiction must refuse the
    // suggestion rather than quietly round the margin away.
    const hist = [10, 10, 10, 10, 260, 0, 0, 0]
    const result = analyzeTappingTerm(hist, 210)
    expect(result.verdict).toBe('ok')
    expect(result.suggestedMs).toBeNull()
    expect(result.tapP95Range).toEqual({ lo: 140, hi: 180 })
  })

  it('every canLower suggestion stays strictly below both the term and the hold p5 range', () => {
    const cases: Array<[number[], number]> = [
      [[285, 0, 0, 0, 0, 0, 0, 15], 200],
      [[285, 0, 0, 0, 0, 0, 0, 0], 200],
    ]
    for (const [hist, currentMs] of cases) {
      const result = analyzeTappingTerm(hist, currentMs)
      expect(result.verdict).toBe('canLower')
      expect(result.suggestedMs).not.toBeNull()
      const suggested = result.suggestedMs as number
      expect(suggested).toBeLessThan(currentMs)
      if (result.holdP5Range) expect(suggested).toBeLessThan(result.holdP5Range.lo)
    }
  })

  it('returns currentMs unchanged on the output regardless of verdict', () => {
    const result = analyzeTappingTerm([0, 0, 0, 0, 0, 0, 0, 0], 173)
    expect(result.currentMs).toBe(173)
  })

  describe('tap-side denominators (Opus counterexamples)', () => {
    it('does not issue a confident canLower from a hold-dominated key (5 tap samples, 195 hold samples)', () => {
      // Blended total is 200 (clears the OLD, buggy blended floor);
      // tap-side(+straddle) mass is only 5 — nowhere near the floor.
      // This must resolve to insufficientSamples, never canLower.
      const hist = [5, 0, 0, 0, 0, 0, 0, 195]
      const result = analyzeTappingTerm(hist, 200)
      expect(result.verdict).toBe('unknown')
      expect(result.unknownReason).toBe('insufficientSamples')
    })

    it('does not let hold mass dilute the censoring-guard share below its threshold', () => {
      // Blended total is 2200; tap-side(+straddle) mass is exactly 200
      // (190 below + 2 straddle + 8 in the gap bucket = 198 below-mass,
      // wait: belowMass=190+8=198, straddleMass=2, tapSideMass=200).
      // The 10-sample gap (8 below + 2 straddle) is 10/2200 ≈ 0.45% of
      // the blended total — under the OLD buggy denominator that
      // cleared the 1% clean-gap guard. Denominated against tap-side
      // mass instead, the same gap is 10/200 = 5%, correctly blocking
      // canLower.
      const hist = [190, 0, 0, 0, 8, 2, 0, 2000]
      const result = analyzeTappingTerm(hist, 200)
      expect(result.verdict).not.toBe('canLower')
      expect(result.verdict).toBe('ok')
    })
  })
})

describe('clampBelowStrict', () => {
  it('floors to the largest step multiple strictly below a non-multiple bound (agy counterexample)', () => {
    // The old implementation returned `boundExclusive - step` (173-5=168,
    // not a multiple of 5) whenever `value` needed clamping — only
    // correct when `boundExclusive` itself happens to be a step
    // multiple. A real keyboard's TAPPING_TERM is an arbitrary u16, not
    // constrained to multiples of 5.
    expect(clampBelowStrict(173, 173, 5)).toBe(170)
    expect(clampBelowStrict(200, 173, 5)).toBe(170)
  })

  it('subtracts exactly one step when the bound is itself already a step multiple', () => {
    expect(clampBelowStrict(210, 210, 5)).toBe(205)
  })

  it('returns the value unchanged when it already clears the bound', () => {
    expect(clampBelowStrict(80, 200, 5)).toBe(80)
  })
})
