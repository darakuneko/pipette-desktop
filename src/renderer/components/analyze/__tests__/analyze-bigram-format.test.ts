// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, it, expect } from 'vitest'
import { bigramPairLabel, bigramPairLabels, rolloverRatioFromEntry } from '../analyze-bigram-format'
import { buildSnapshotQmkByCode } from '../analyze-snapshot-codes'
import { recreateKeyboardKeycodes } from '../../../../shared/keycodes/keycodes'
import type { TypingKeymapSnapshot } from '../../../../shared/types/typing-analytics'

function snapshotWithKeymap(keymap: string[][][], vialProtocol?: number): TypingKeymapSnapshot {
  return {
    uid: '0x00',
    machineHash: 'h',
    productName: 'Test',
    savedAt: 0,
    layers: keymap.length,
    matrix: { rows: keymap[0]?.length ?? 0, cols: keymap[0]?.[0]?.length ?? 0 },
    keymap,
    layout: null,
    vialProtocol,
  }
}

/** Registers the CURRENT session's keyboard as a small one — 4 layers,
 * 16 macros — the same shape-mismatch setup as
 * key-heatmap-helpers-speed.test.ts's `useSmallSessionKeyboard`. */
function useSmallSessionKeyboard(): void {
  recreateKeyboardKeycodes({
    vialProtocol: 6,
    layers: 4,
    macroCount: 16,
    tapDanceCount: 0,
    customKeycodes: null,
    midi: '',
    supportedFeatures: new Set(),
  })
}

// Re-pins the module-global keyboard registration to this same small
// shape after every test in this file — see the matching afterEach in
// key-heatmap-helpers-speed.test.ts for why it must be this exact
// small shape and not a bigger "default" one (`qmkIdToKeycode` only
// ever grows, so widening it here would permanently make `M20`
// resolvable for the rest of this file's run).
afterEach(() => {
  useSmallSessionKeyboard()
})

describe('bigramPairLabel', () => {
  it('decodes a numeric pair id into prev → curr labels', () => {
    // KC_A = 4, KC_H = 11.
    expect(bigramPairLabel('4_11')).toBe('A → H')
  })

  it('survives same-key repeats (e.g. backspace held)', () => {
    // KC_BSPC = 0x2A = 42.
    expect(bigramPairLabel('42_42')).toBe('Bksp → Bksp')
  })

  it('falls back to the raw id when the format is malformed', () => {
    expect(bigramPairLabel('not-a-bigram')).toBe('not-a-bigram')
    expect(bigramPairLabel('4_11_42_11')).toBe('4_11_42_11')
    expect(bigramPairLabel('4_')).toBe('4_')
    expect(bigramPairLabel('4__42')).toBe('4__42')
  })

  it('falls back to the raw id when any side is non-numeric', () => {
    expect(bigramPairLabel('foo_11')).toBe('foo_11')
    expect(bigramPairLabel('4_bar')).toBe('4_bar')
    expect(bigramPairLabel('4_11_bar')).toBe('4_11_bar')
  })

  it('decodes a trigram id (k1_k2_k3) into prev → mid → curr labels', () => {
    // KC_A = 4, KC_H = 11, KC_BSPC = 42.
    expect(bigramPairLabel('4_11_42')).toBe('A → H → Bksp')
  })

  it('decodes layer-tap mask codes via the static template fallback', () => {
    // 16684 = 0x412C = LT1(KC_SPACE). Even when the keyboard's layer-
    // count-driven Keycode objects haven't been built yet (analyze
    // rendered before keymap load), the protocol's mask-template
    // reverse map should still produce a meaningful label rather than
    // bare hex.
    const label = bigramPairLabel('16684_4')
    expect(label.startsWith('0x')).toBe(false)
    expect(label).toContain('LT1')
    expect(label).toContain(' → ')
    // Right-hand side is KC_A, which is always populated.
    expect(label.endsWith('A')).toBe(true)
  })

  it('resolves a code from the snapshot\'s own qmk map instead of the session RAWCODES_MAP', () => {
    // Session only knows about 4 layers / 16 macros; the snapshot was
    // recorded by an 8-layer / 32-macro keyboard, so "M20" is a code
    // this session can't round-trip through `serialize` on its own —
    // see Task-speed-ranking-snapshot-labels.md.
    useSmallSessionKeyboard()
    const snapshot = snapshotWithKeymap([[['M20', 'KC_A']]])
    const qmkByCode = buildSnapshotQmkByCode(snapshot, snapshot.vialProtocol)
    const m20Code = [...qmkByCode.entries()].find(([, id]) => id === 'M20')?.[0]
    const aCode = [...qmkByCode.entries()].find(([, id]) => id === 'KC_A')?.[0]
    expect(m20Code).toBeDefined()
    expect(aCode).toBeDefined()

    expect(bigramPairLabel(`${m20Code}_${aCode}`, qmkByCode, snapshot.vialProtocol)).toBe('M20 → A')
  })

  it('still falls back to codeToLabel for a code absent from the map (unedited call keeps working)', () => {
    // No qmkByCode/vialProtocol passed — must match the pre-existing,
    // wrapper-less behavior exactly.
    expect(bigramPairLabel('4_11')).toBe('A → H')
  })
})

describe('bigramPairLabels (batched sibling of bigramPairLabel)', () => {
  it('resolves the same label per id as calling bigramPairLabel individually', () => {
    const ids = ['4_11', '42_42', 'not-a-bigram', '4_11_42']
    expect(bigramPairLabels(ids)).toEqual(ids.map((id) => bigramPairLabel(id)))
  })

  it('resolves every id\'s miss codes under a single shared protocol scope', () => {
    useSmallSessionKeyboard()
    const snapshot = snapshotWithKeymap([[['M20', 'KC_A']]])
    const qmkByCode = buildSnapshotQmkByCode(snapshot, snapshot.vialProtocol)
    const m20Code = [...qmkByCode.entries()].find(([, id]) => id === 'M20')?.[0]
    const aCode = [...qmkByCode.entries()].find(([, id]) => id === 'KC_A')?.[0]

    const labels = bigramPairLabels([`${m20Code}_${aCode}`, '4_11'], qmkByCode, snapshot.vialProtocol)
    expect(labels).toEqual(['M20 → A', 'A → H'])
  })
})

describe('rolloverRatioFromEntry', () => {
  it('delegates to the shared rolloverRatio contract (entry adapter only)', () => {
    expect(rolloverRatioFromEntry({ overlapCount: 1, overlapN: 4 })).toBe(0.25)
  })

  it('returns null when overlapN is null, undefined, or 0 (no determined-overlap sample)', () => {
    expect(rolloverRatioFromEntry({ overlapCount: null, overlapN: null })).toBeNull()
    expect(rolloverRatioFromEntry({})).toBeNull()
    expect(rolloverRatioFromEntry({ overlapCount: 0, overlapN: 0 })).toBeNull()
  })

  it('returns a real 0 when overlapCount is 0 but overlapN is positive', () => {
    expect(rolloverRatioFromEntry({ overlapCount: 0, overlapN: 5 })).toBe(0)
  })

  it('returns null (not a fabricated 0) when overlapCount is missing but overlapN is positive', () => {
    // A malformed/mismatched entry — `overlapCount ?? 0` would silently
    // manufacture a fake 0% here; the local `== null` guard rejects it
    // instead of relying on `rolloverRatio`'s `on` check to catch it.
    expect(rolloverRatioFromEntry({ overlapCount: null, overlapN: 5 })).toBeNull()
    expect(rolloverRatioFromEntry({ overlapN: 5 })).toBeNull()
  })
})
