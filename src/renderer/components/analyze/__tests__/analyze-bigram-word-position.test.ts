// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  aggregateWordPosition,
  classifyWordPosition,
  tapKeycodeOf,
} from '../analyze-bigram-word-position'
import {
  buildLTKeycode,
  buildModMaskKeycode,
  buildModTapKeycode,
  deserialize,
} from '../../../../shared/keycodes/keycodes'
import type { TypingBigramTopEntry } from '../../../../shared/types/typing-analytics'
import { withDeserializeProtocol } from '../../../../shared/keycodes/with-protocol'

/** Build a keycode under a specific protocol so the test can name which
 * version's range a wrapped keycode came from. */
function withProtocol<T>(protocol: number, body: () => T): T {
  return withDeserializeProtocol(protocol, body)
}

const KC_SPACE = deserialize('KC_SPACE')
const KC_ENTER = deserialize('KC_ENTER')
const KC_TAB = deserialize('KC_TAB')
const KC_A = deserialize('KC_A')
const KC_B = deserialize('KC_B')

function entry(
  ngramId: string,
  count: number,
  hist: number[] = [0, 0, 0, 0, 0, 0, 0, 0],
): TypingBigramTopEntry {
  return { ngramId, count, hist, avgIki: null, sd: null }
}

describe('tapKeycodeOf', () => {
  it('unwraps Layer-Tap to its basic key', () => {
    expect(tapKeycodeOf(buildLTKeycode(1, KC_SPACE))).toBe(KC_SPACE)
  })

  it('unwraps Mod-Tap to its basic key', () => {
    expect(tapKeycodeOf(buildModTapKeycode(0x01, KC_ENTER))).toBe(KC_ENTER)
  })

  it('does NOT unwrap a modifier-mask keycode — it never types the bare key', () => {
    const lctlSpace = buildModMaskKeycode(0x01, KC_SPACE)
    expect(tapKeycodeOf(lctlSpace)).toBe(lctlSpace)
    expect(tapKeycodeOf(lctlSpace)).not.toBe(KC_SPACE)
  })

  it('returns everything else unchanged, including a high keycode whose low byte matches KC_SPACE', () => {
    // Simulates a macro / tap-dance style keycode living well above the
    // basic-key range but sharing KC_SPACE's low byte — masking
    // unconditionally would incorrectly fold this down to KC_SPACE.
    const highCodeSharingLowByte = 0x7000 | (KC_SPACE & 0xff)
    expect(tapKeycodeOf(highCodeSharingLowByte)).toBe(highCodeSharingLowByte)
    expect(tapKeycodeOf(KC_TAB)).toBe(KC_TAB)
  })
})

describe('classifyWordPosition', () => {
  it('classifies space->letter as initiation', () => {
    expect(classifyWordPosition(KC_SPACE, KC_A, true)).toBe('initiation')
  })

  it('classifies letter->letter as in-word', () => {
    expect(classifyWordPosition(KC_A, KC_B, true)).toBe('inWord')
  })

  it('excludes letter->space, space->space, and enter->space', () => {
    expect(classifyWordPosition(KC_A, KC_SPACE, true)).toBe('excluded')
    expect(classifyWordPosition(KC_SPACE, KC_SPACE, true)).toBe('excluded')
    expect(classifyWordPosition(KC_ENTER, KC_SPACE, true)).toBe('excluded')
  })

  it('classifies enter->letter as initiation — pins the approved decision to include Enter', () => {
    expect(classifyWordPosition(KC_ENTER, KC_A, true)).toBe('initiation')
  })

  it('classifies tab->letter as in-word, not initiation — Tab is not a separator', () => {
    expect(classifyWordPosition(KC_TAB, KC_A, true)).toBe('inWord')
  })

  it('classifies LT(1, KC_SPACE)->letter as initiation', () => {
    expect(classifyWordPosition(buildLTKeycode(1, KC_SPACE), KC_A, true)).toBe('initiation')
  })

  it('classifies MT(mod, KC_ENTER)->letter as initiation', () => {
    expect(classifyWordPosition(buildModTapKeycode(0x01, KC_ENTER), KC_A, true)).toBe('initiation')
  })

  it('does NOT classify LCTL(KC_SPACE)->letter as initiation — mod-mask never types a space', () => {
    expect(classifyWordPosition(buildModMaskKeycode(0x01, KC_SPACE), KC_A, true)).toBe('inWord')
  })
})

describe('aggregateWordPosition', () => {
  it('returns zeroed totals for empty entries', () => {
    const result = aggregateWordPosition([])
    expect(result.initiation).toEqual({ count: 0, hist: [0, 0, 0, 0, 0, 0, 0, 0] })
    expect(result.inWord).toEqual({ count: 0, hist: [0, 0, 0, 0, 0, 0, 0, 0] })
    expect(result.excludedCount).toBe(0)
  })

  it('folds a space->letter pair into initiation', () => {
    const result = aggregateWordPosition([
      entry(`${KC_SPACE}_${KC_A}`, 4, [4, 0, 0, 0, 0, 0, 0, 0]),
    ])
    expect(result.initiation).toEqual({ count: 4, hist: [4, 0, 0, 0, 0, 0, 0, 0] })
    expect(result.inWord.count).toBe(0)
  })

  it('folds a letter->letter pair into in-word', () => {
    const result = aggregateWordPosition([
      entry(`${KC_A}_${KC_B}`, 3, [0, 3, 0, 0, 0, 0, 0, 0]),
    ])
    expect(result.inWord).toEqual({ count: 3, hist: [0, 3, 0, 0, 0, 0, 0, 0] })
    expect(result.initiation.count).toBe(0)
  })

  it('drops a pair ending at a separator from both buckets and reports it as excluded', () => {
    const result = aggregateWordPosition([
      entry(`${KC_A}_${KC_SPACE}`, 5),
    ])
    expect(result.excludedCount).toBe(5)
    expect(result.initiation.count).toBe(0)
    expect(result.inWord.count).toBe(0)
  })

  it('skips a malformed ngram id entirely — it reaches neither bucket nor the excluded count', () => {
    const result = aggregateWordPosition([
      entry('bad', 2),
      entry(`${KC_A}_${KC_B}`, 1, [1, 0, 0, 0, 0, 0, 0, 0]),
    ])
    expect(result.excludedCount).toBe(0)
    expect(result.initiation.count).toBe(0)
    expect(result.inWord.count).toBe(1)
  })

  it('folds two entries in the same bucket into a weighted-average histogram', () => {
    const result = aggregateWordPosition([
      entry(`${KC_SPACE}_${KC_A}`, 2, [2, 0, 0, 0, 0, 0, 0, 0]),
      entry(`${KC_ENTER}_${KC_B}`, 1, [0, 1, 0, 0, 0, 0, 0, 0]),
    ])
    expect(result.initiation).toEqual({ count: 3, hist: [2, 1, 0, 0, 0, 0, 0, 0] })
  })

  it('leaves a dual-role space key alone when no protocol is supplied', () => {
    // Without the recording protocol, the Mod-Tap range can't be
    // identified (v5 bases it at 0x6000, v6 at 0x2000), so the pair
    // must fall through to in-word rather than be unwrapped against
    // whichever protocol the session happens to be in.
    const mtSpace = withProtocol(6, () => buildModTapKeycode(0x01, KC_SPACE))
    const result = aggregateWordPosition([entry(`${mtSpace}_${KC_A}`, 4)])
    expect(result.initiation.count).toBe(0)
    expect(result.inWord.count).toBe(4)
  })

  it('unwraps a dual-role space key against the protocol it was recorded under', () => {
    const mtSpaceV6 = withProtocol(6, () => buildModTapKeycode(0x01, KC_SPACE))
    expect(aggregateWordPosition([entry(`${mtSpaceV6}_${KC_A}`, 4)], 6).initiation.count).toBe(4)

    const mtSpaceV5 = withProtocol(5, () => buildModTapKeycode(0x01, KC_SPACE))
    expect(aggregateWordPosition([entry(`${mtSpaceV5}_${KC_A}`, 4)], 5).initiation.count).toBe(4)
  })

  it('does not unwrap a v5-recorded Mod-Tap against v6 ranges', () => {
    // The regression this guards: the two protocols put Mod-Tap in
    // different ranges, so classifying with the wrong one silently
    // drops the pair out of initiation instead of erroring.
    const mtSpaceV5 = withProtocol(5, () => buildModTapKeycode(0x01, KC_SPACE))
    const result = aggregateWordPosition([entry(`${mtSpaceV5}_${KC_A}`, 4)], 6)
    expect(result.initiation.count).toBe(0)
  })
})
