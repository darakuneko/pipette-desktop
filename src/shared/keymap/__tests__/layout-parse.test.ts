// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  getForwardMap,
  getReverseMap,
  parseLayoutEntry,
  type LayoutShape,
} from '../layout-parse'

const QWERTY: LayoutShape = { map: {} }

const COLEMAK: LayoutShape = {
  map: {
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
  },
}

const CANADIAN: LayoutShape = {
  map: {
    KC_GRAVE: '\\\n/    |',
    KC_RBRACKET: 'Ç    ~',
    KC_6: '?\n6',
  },
}

describe('parseLayoutEntry', () => {
  it('returns empty base for empty input', () => {
    expect(parseLayoutEntry('')).toEqual({ base: '' })
  })

  it('treats a single line as base only', () => {
    expect(parseLayoutEntry('F')).toEqual({ base: 'F' })
  })

  it('splits shift\\nbase', () => {
    expect(parseLayoutEntry('?\n6')).toEqual({ base: '6', shift: '?' })
  })

  it('splits altgr after 4 spaces on a single base line', () => {
    expect(parseLayoutEntry('Ç    ~')).toEqual({ base: 'Ç', altgr: '~' })
  })

  it('splits shift, base, and altgr together', () => {
    expect(parseLayoutEntry('\\\n/    |')).toEqual({
      base: '/',
      shift: '\\',
      altgr: '|',
    })
  })

  it('keeps multi-character base segments intact', () => {
    expect(parseLayoutEntry('AB    C')).toEqual({ base: 'AB', altgr: 'C' })
  })

  it('preserves non-ASCII first character without truncation', () => {
    expect(parseLayoutEntry('Ç')).toEqual({ base: 'Ç' })
  })
})

describe('getForwardMap', () => {
  it('seeds QWERTY baseline for un-overridden keys', () => {
    const fwd = getForwardMap(QWERTY)
    expect(fwd.get('KC_A')?.base).toBe('a')
    expect(fwd.get('KC_R')?.base).toBe('r')
  })

  it('applies layout overrides on top of the QWERTY baseline', () => {
    const fwd = getForwardMap(COLEMAK)
    expect(fwd.get('KC_E')?.base).toBe('F')
    expect(fwd.get('KC_R')?.base).toBe('P')
    // Un-overridden Colemak key still falls back to QWERTY base.
    expect(fwd.get('KC_A')?.base).toBe('a')
  })

  it('memoizes per layout reference', () => {
    const a = getForwardMap(COLEMAK)
    const b = getForwardMap(COLEMAK)
    expect(a).toBe(b)
  })
})

describe('getReverseMap', () => {
  it('reverses QWERTY baseline (lowercased)', () => {
    const rev = getReverseMap(QWERTY)
    expect(rev.get('a')).toBe('KC_A')
    expect(rev.get('r')).toBe('KC_R')
  })

  it('reflects layout overrides for Colemak', () => {
    const rev = getReverseMap(COLEMAK)
    // "p" is produced by the QWERTY R position on Colemak.
    expect(rev.get('p')).toBe('KC_R')
    // "f" is produced by the QWERTY E position on Colemak.
    expect(rev.get('f')).toBe('KC_E')
    // "r" is produced by the QWERTY S position on Colemak.
    expect(rev.get('r')).toBe('KC_S')
  })

  it('respects altgr / shift parses without indexing them', () => {
    const rev = getReverseMap(CANADIAN)
    // KC_RBRACKET base "Ç" → reverse "ç" → KC_RBRACKET
    expect(rev.get('ç')).toBe('KC_RBRACKET')
    // KC_GRAVE altgr "|" should NOT be in the reverse map (base-only).
    expect(rev.get('|')).toBeUndefined()
    // KC_6 shift "?" appears only as a shift label, not as anyone's
    // base — must not leak into the reverse map.
    expect(rev.get('?')).toBeUndefined()
  })

  it('memoizes per layout reference', () => {
    const a = getReverseMap(CANADIAN)
    const b = getReverseMap(CANADIAN)
    expect(a).toBe(b)
  })
})
