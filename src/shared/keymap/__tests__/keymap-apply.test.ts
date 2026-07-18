// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { buildKeymapRewriteTable, composeRewriteTables, rewriteNumericKeycode } from '../keymap-apply'
import { deserialize, resolve } from '../../keycodes/keycodes'

// Same fixture as layout-parse.test.ts (real Colemak data).
const COLEMAK: Record<string, string> = {
  KC_E: 'F',
  KC_R: 'P',
  KC_T: 'G',
  KC_Y: 'J',
  KC_U: 'L',
  KC_I: 'U',
  KC_O: 'Y',
  KC_P: ';',
  KC_S: 'R',
  KC_D: 'S',
  KC_F: 'T',
  KC_G: 'D',
  KC_J: 'N',
  KC_K: 'E',
  KC_L: 'I',
  KC_SCOLON: 'O',
  KC_N: 'K',
}

// Real Dvorak entry from pipette-hub's data/key-labels-seed.json (the
// "Dvorak" pack, `keymap_applicable: true`) — 33 entries. NOT closed:
// `KC_RBRACKET -> "="` and `KC_QUOTE -> "-"` resolve to targets KC_EQUAL /
// KC_MINUS, but neither has a source entry of its own (see
// pipette-hub's .claude/plan/key-label-dvorak-closure-fix.md, the real
// bug this fixture reproduces). Applying this map as-is would duplicate
// `-`/`=` on two keys each while no key sends `[`/`]` anymore. KC_A/KC_M
// are present as harmless identity entries in the real pack (not part of
// the defect).
const DVORAK_HUB_REAL: Record<string, string> = {
  KC_Q: "'",
  KC_W: ',',
  KC_E: '.',
  KC_R: 'P',
  KC_T: 'Y',
  KC_Y: 'F',
  KC_U: 'G',
  KC_I: 'C',
  KC_O: 'R',
  KC_P: 'L',
  KC_LBRACKET: '/',
  KC_RBRACKET: '=',
  KC_A: 'A',
  KC_S: 'O',
  KC_D: 'E',
  KC_F: 'U',
  KC_G: 'I',
  KC_H: 'D',
  KC_J: 'H',
  KC_K: 'T',
  KC_L: 'N',
  KC_SCOLON: 'S',
  KC_QUOTE: '-',
  KC_Z: ';',
  KC_X: 'Q',
  KC_C: 'J',
  KC_V: 'K',
  KC_B: 'X',
  KC_N: 'B',
  KC_M: 'M',
  KC_COMMA: 'W',
  KC_DOT: 'V',
  KC_SLASH: 'Z',
}

// The pipette-hub closure-fix plan's remedy applied: add the two missing
// source entries (`KC_MINUS -> "["`, `KC_EQUAL -> "]"`, matching standard
// Dvorak) so every target above is also a source — 35 entries, closed.
const DVORAK_CLOSED: Record<string, string> = {
  ...DVORAK_HUB_REAL,
  KC_MINUS: '[',
  KC_EQUAL: ']',
}

// Real sample-packs/key-labels/japanese_qwerty_ej.json data — QWERTY
// physical layout with shift-pair display labels, not a permutation.
const JAPANESE_QWERTY: Record<string, string> = {
  KC_LBRACKET: '`\n@',
  KC_RBRACKET: '{\n[',
  KC_2: '"\n2',
  KC_6: '&\n6',
  KC_MINUS: '=\n-',
  KC_GRAVE: 'E/J',
}

describe('buildKeymapRewriteTable', () => {
  it('succeeds for the real Colemak map', () => {
    const result = buildKeymapRewriteTable(COLEMAK)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.table.get('KC_E')).toBe('KC_F')
    expect(result.table.get('KC_R')).toBe('KC_P')
    expect(result.table.get('KC_T')).toBe('KC_G')
    expect(result.table.get('KC_Y')).toBe('KC_J')
    expect(result.table.get('KC_U')).toBe('KC_L')
    expect(result.table.get('KC_I')).toBe('KC_U')
    expect(result.table.get('KC_O')).toBe('KC_Y')
    expect(result.table.get('KC_P')).toBe('KC_SCOLON')
    expect(result.table.get('KC_S')).toBe('KC_R')
    expect(result.table.get('KC_D')).toBe('KC_S')
    expect(result.table.get('KC_F')).toBe('KC_T')
    expect(result.table.get('KC_G')).toBe('KC_D')
    expect(result.table.get('KC_J')).toBe('KC_N')
    expect(result.table.get('KC_K')).toBe('KC_E')
    expect(result.table.get('KC_L')).toBe('KC_I')
    expect(result.table.get('KC_SCOLON')).toBe('KC_O')
    expect(result.table.get('KC_N')).toBe('KC_K')
    expect(result.table.size).toBe(17)
    // Every target above (KC_F, KC_P, KC_G, ...) is also one of the 17
    // source keys — Colemak's real map is a closed permutation, so this
    // success also confirms the closure check (added for the Dvorak
    // defect below) doesn't reject a genuinely-closed map.
  })

  it('succeeds for the closed Dvorak map, including quote and lbracket swaps', () => {
    const result = buildKeymapRewriteTable(DVORAK_CLOSED)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.table.get('KC_QUOTE')).toBe('KC_MINUS')
    expect(result.table.get('KC_LBRACKET')).toBe('KC_SLASH')
    expect(result.table.get('KC_RBRACKET')).toBe('KC_EQUAL')
    expect(result.table.get('KC_MINUS')).toBe('KC_LBRACKET')
    expect(result.table.get('KC_EQUAL')).toBe('KC_RBRACKET')
    expect(result.table.size).toBe(35)
  })

  it('fails for the real (unfixed) Hub Dvorak map — not closed: KC_EQUAL/KC_MINUS targets have no source entry', () => {
    const result = buildKeymapRewriteTable(DVORAK_HUB_REAL)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('not closed')
  })

  it('fails when a target keycode has no source entry of its own (minimal non-closed example)', () => {
    // KC_A -> "b" resolves to target KC_B, but nothing maps FROM KC_B.
    const result = buildKeymapRewriteTable({ KC_A: 'b' })
    expect(result.ok).toBe(false)
  })

  it('succeeds for a minimal closed 2-cycle (swap)', () => {
    const result = buildKeymapRewriteTable({ KC_A: 'b', KC_B: 'a' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.table.get('KC_A')).toBe('KC_B')
    expect(result.table.get('KC_B')).toBe('KC_A')
  })

  it('fails for the Japanese (QWERTY) style map — shift-pair labels', () => {
    const result = buildKeymapRewriteTable(JAPANESE_QWERTY)
    expect(result.ok).toBe(false)
  })

  it('fails for a keycode-passthrough label value', () => {
    const result = buildKeymapRewriteTable({ KC_GRAVE: 'KC_LALT' })
    expect(result.ok).toBe(false)
  })

  it('fails for an unknown source qmkId', () => {
    const result = buildKeymapRewriteTable({ NOT_A_REAL_KEYCODE: 'F' })
    expect(result.ok).toBe(false)
  })

  it('fails for a duplicate replacement target', () => {
    const result = buildKeymapRewriteTable({ KC_E: 'F', KC_R: 'F' })
    expect(result.ok).toBe(false)
  })

  it('fails for a char with no QWERTY keycode', () => {
    const result = buildKeymapRewriteTable({ KC_E: 'あ' /* あ */ })
    expect(result.ok).toBe(false)
  })

  it('succeeds (no-op table) for an empty map', () => {
    const result = buildKeymapRewriteTable({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.table.size).toBe(0)
  })

  it('fails for a One-Shot Mod source (OSM) — not a plain basic keycode', () => {
    const result = buildKeymapRewriteTable({ 'OSM(MOD_LSFT)': 'F' })
    expect(result.ok).toBe(false)
  })

  it('fails for a Tap Dance source (TD) — not a plain basic keycode', () => {
    const result = buildKeymapRewriteTable({ 'TD(0)': 'F' })
    expect(result.ok).toBe(false)
  })
})

describe('rewriteNumericKeycode', () => {
  it('rewrites a plain basic keycode', () => {
    const result = buildKeymapRewriteTable(COLEMAK)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(rewriteNumericKeycode(deserialize('KC_E'), result.table)).toBe(deserialize('KC_F'))
  })

  it('leaves keycodes outside the table unchanged', () => {
    const result = buildKeymapRewriteTable(COLEMAK)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(rewriteNumericKeycode(deserialize('KC_ENTER'), result.table)).toBe(deserialize('KC_ENTER'))
  })

  it('swaps only the inner keycode of a modifier-mask composite (LSFT)', () => {
    const result = buildKeymapRewriteTable(COLEMAK)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const input = deserialize('LSFT(KC_E)')
    const expected = deserialize('LSFT(KC_F)')
    expect(rewriteNumericKeycode(input, result.table)).toBe(expected)
  })

  it('swaps only the inner keycode of a Layer-Tap composite (LT)', () => {
    const result = buildKeymapRewriteTable(COLEMAK)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const input = deserialize('LT(1,KC_E)')
    const expected = deserialize('LT(1,KC_F)')
    expect(rewriteNumericKeycode(input, result.table)).toBe(expected)
  })

  it('swaps only the inner keycode of a Mod-Tap composite (MT)', () => {
    const result = buildKeymapRewriteTable(COLEMAK)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const input = deserialize('LSFT_T(KC_E)')
    const expected = deserialize('LSFT_T(KC_F)')
    expect(rewriteNumericKeycode(input, result.table)).toBe(expected)
  })

  // Defense in depth: buildKeymapRewriteTable never accepts a composite
  // source, but rewriteNumericKeycode must independently refuse to touch
  // an unhandled-family code even if a table (built or hand-constructed
  // some other way) happens to carry a matching entry for it.
  it('leaves a One-Shot Mod (OSM) code untouched even when the table has a matching entry', () => {
    const oneShotShift = deserialize('OSM(MOD_LSFT)')
    // A table entry keyed by the OSM code's own serialized qmkId — this
    // is exactly the shape buildKeymapRewriteTable would have produced
    // before the source-side fix, and must not be honoured here.
    const table = new Map([['OSM(MOD_LSFT)', 'KC_A']])
    expect(rewriteNumericKeycode(oneShotShift, table)).toBe(oneShotShift)
  })

  it('leaves an arbitrary unknown-range code untouched', () => {
    // Not plain-basic (< 0x100), not Mod-Tap / Layer-Tap / mod-mask range.
    const unknown = 0x7abc
    const table = new Map([['KC_A', 'KC_B']])
    expect(rewriteNumericKeycode(unknown, table)).toBe(unknown)
  })

  it('returns a Mod-Tap-range code with a zero modifier mask bit-identical', () => {
    // Constructed directly (not via buildModTapKeycode, which special-cases
    // mod===0 by returning a bare basic keycode and never produces a value
    // in this range) to reproduce a raw zero-mask Mod-Tap-range value.
    const modTapBase = resolve('QK_MOD_TAP')
    const zeroMaskModTap = modTapBase | deserialize('KC_E')
    const table = new Map([['KC_E', 'KC_F']])
    expect(rewriteNumericKeycode(zeroMaskModTap, table)).toBe(zeroMaskModTap)
  })
})

// --- 追加要求 (2026-07-18): composeRewriteTables ---

function buildOrThrow(map: Record<string, string>): Map<string, string> {
  const result = buildKeymapRewriteTable(map)
  if (!result.ok) throw new Error(`fixture map failed to build: ${result.error}`)
  return new Map(result.table)
}

const colemakTable = buildOrThrow(COLEMAK)
const dvorakTable = buildOrThrow(DVORAK_CLOSED)

describe('composeRewriteTables', () => {
  it('composing with an empty target inverts the applied table (swaps source <-> target for every entry)', () => {
    const inverted = composeRewriteTables(colemakTable, new Map())
    expect(inverted.size).toBe(colemakTable.size)
    for (const [source, target] of colemakTable) {
      expect(inverted.get(target)).toBe(source)
    }
  })

  it('composing an empty-target inverse twice returns the original table', () => {
    const inverted = composeRewriteTables(colemakTable, new Map())
    const roundTripped = composeRewriteTables(inverted, new Map())
    expect(roundTripped).toEqual(colemakTable)
  })

  it('identity (QWERTY) -> Colemak composition equals the plain Colemak table', () => {
    const composed = composeRewriteTables(new Map(), colemakTable)
    expect(composed).toEqual(colemakTable)
  })

  it('composing a table with itself is always empty', () => {
    expect(composeRewriteTables(colemakTable, colemakTable).size).toBe(0)
    expect(composeRewriteTables(dvorakTable, dvorakTable).size).toBe(0)
  })

  it('Colemak -> Dvorak composition matches hand-derived expectations', () => {
    // Hand-derived from the public Colemak / Dvorak layout definitions
    // (which physical QWERTY position shows which letter), independent of
    // buildKeymapRewriteTable's own output:
    //   - Colemak's E-position key currently emits 'F' (E -> F); Dvorak's
    //     E-position shows '.': the key holding KC_F must become KC_DOT.
    //   - Colemak's F-position emits 'T' (F -> T); Dvorak's F-position
    //     shows 'U': the key holding KC_T must become KC_U.
    //   - Colemak's S-position emits 'R' (S -> R); Dvorak's S-position
    //     shows 'O': the key holding KC_R must become KC_O.
    //   - Colemak's P-position emits ';' (P -> KC_SCOLON); Dvorak's
    //     P-position shows 'L': the key holding KC_SCOLON must become KC_L.
    //   - Colemak's D-position emits 'S' (D -> S); Dvorak's D-position
    //     shows 'E': the key holding KC_S must become KC_E.
    const composed = composeRewriteTables(colemakTable, dvorakTable)
    expect(composed.get('KC_F')).toBe('KC_DOT')
    expect(composed.get('KC_T')).toBe('KC_U')
    expect(composed.get('KC_R')).toBe('KC_O')
    expect(composed.get('KC_SCOLON')).toBe('KC_L')
    expect(composed.get('KC_S')).toBe('KC_E')

    // Both Colemak and Dvorak happen to put 'P' at the physical R position
    // (a real coincidence between the two layouts) — the identity pair
    // this produces (KC_P -> KC_P) must be dropped from the composition.
    expect(composed.has('KC_P')).toBe(false)
  })
})
