// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildSnapshotQmkByCode,
  compactLayerOp,
  decodeSnapshotQmkId,
  snapshotCodeLabel,
} from '../analyze-snapshot-codes'
import {
  deserialize,
  getProtocol,
  recreateKeyboardKeycodes,
  setProtocol,
} from '../../../../shared/keycodes/keycodes'
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

/** Resolve `qmkId` to its numeric code under a specific protocol,
 * restoring the global protocol afterwards. */
function deserializeUnderProtocol(qmkId: string, protocol: number): number {
  const prev = getProtocol()
  setProtocol(protocol)
  try {
    return deserialize(qmkId)
  } finally {
    setProtocol(prev)
  }
}

// A deliberately small "current session" keyboard context — 2 layers,
// 4 macros — so `M20` / `LT3(...)` / `MO(6)` are all things this
// session's registry does NOT know about, the same shape-mismatch a
// snapshot from a bigger keyboard produces against a smaller session.
beforeEach(() => {
  recreateKeyboardKeycodes({
    vialProtocol: 6,
    layers: 2,
    macroCount: 4,
    tapDanceCount: 0,
    customKeycodes: null,
    midi: '',
    supportedFeatures: new Set(),
  })
})

describe('decodeSnapshotQmkId', () => {
  it('trusts a nonzero deserialize result directly', () => {
    expect(decodeSnapshotQmkId('KC_A')).toBe(deserialize('KC_A'))
  })

  it('treats KC_NO as a real 0, not a decode failure', () => {
    expect(decodeSnapshotQmkId('KC_NO')).toBe(0)
  })

  it('falls back to resolve() when deserialize silently returns 0 for a macro the session does not know', () => {
    // The session above only registered M0-M3 — deserialize('M20')
    // resolves through decodeAnyKeycode, which doesn't recognize the
    // bare identifier "M20" either (no session Keycode, no AnyKeycode
    // alias/function match) and swallows the parse error, returning 0.
    expect(deserialize('M20')).toBe(0)
    // resolve() reads the protocol's static kc table (M0-M255 always
    // fully generated) instead, so it succeeds where deserialize did not.
    const decoded = decodeSnapshotQmkId('M20')
    expect(decoded).toBeDefined()
    expect(decoded).not.toBe(0)
  })

  it('falls back to resolve() for MO(6) even though the session only registered 2 layers', () => {
    // Unlike M20, deserialize('MO(6)') already succeeds today (it goes
    // through decodeAnyKeycode's generic MO() function, not a
    // session-registered Keycode), so this exercises the "trust a
    // nonzero deserialize result" branch rather than the resolve()
    // fallback -- both paths must agree on the same numeric code.
    const viaDeserialize = deserialize('MO(6)')
    expect(viaDeserialize).not.toBe(0)
    expect(decodeSnapshotQmkId('MO(6)')).toBe(viaDeserialize)
  })

  it('returns undefined when neither deserialize nor resolve can decode the id', () => {
    expect(decodeSnapshotQmkId('NOT_A_REAL_KEYCODE')).toBeUndefined()
  })
})

describe('buildSnapshotQmkByCode', () => {
  it('builds a code -> qmkId map from every layer, not just layer 0', () => {
    const snapshot = snapshotWithKeymap([
      [['KC_A', 'KC_B']],
      [['KC_C', 'M20']],
    ])
    const map = buildSnapshotQmkByCode(snapshot)
    expect(map.get(deserialize('KC_A'))).toBe('KC_A')
    expect(map.get(deserialize('KC_B'))).toBe('KC_B')
    expect(map.get(deserialize('KC_C'))).toBe('KC_C')
    expect(map.get(decodeSnapshotQmkId('M20')!)).toBe('M20')
  })

  it('first-writer-wins on a code recorded by more than one qmkId', () => {
    const snapshot = snapshotWithKeymap([[['KC_A', 'KC_A']]])
    const map = buildSnapshotQmkByCode(snapshot)
    expect(map.size).toBe(1)
    expect(map.get(deserialize('KC_A'))).toBe('KC_A')
  })

  it('skips empty cells and undecodable ids without throwing', () => {
    const snapshot = snapshotWithKeymap([[['', 'NOT_A_REAL_KEYCODE', 'KC_A']]])
    const map = buildSnapshotQmkByCode(snapshot)
    expect(map.size).toBe(1)
    expect(map.get(deserialize('KC_A'))).toBe('KC_A')
  })

  it('resolves under the snapshot\'s own vialProtocol', () => {
    const v5BootCode = deserializeUnderProtocol('QK_BOOT', 5)
    const v6BootCode = deserializeUnderProtocol('QK_BOOT', 6)
    expect(v5BootCode).not.toBe(v6BootCode)

    const snapshot = snapshotWithKeymap([[['QK_BOOT']]], 5)
    const map = buildSnapshotQmkByCode(snapshot, snapshot.vialProtocol)
    expect(map.get(v5BootCode)).toBe('QK_BOOT')
    expect(map.get(v6BootCode)).toBeUndefined()
  })

  it('restores the global protocol after resolving', () => {
    const prev = getProtocol()
    const snapshot = snapshotWithKeymap([[['KC_A']]], 5)
    buildSnapshotQmkByCode(snapshot, snapshot.vialProtocol)
    expect(getProtocol()).toBe(prev)
  })
})

describe('compactLayerOp', () => {
  it('collapses the spaced layer-op form into the compact display form', () => {
    // "LT 3" / "MO 6" — resolveSnapshotLabel's `${op} ${layer}` spaced
    // form (see its LT/LM branch below), not the parens form.
    expect(compactLayerOp('LT 3')).toBe('LT3')
    expect(compactLayerOp('MO 6')).toBe('MO6')
  })

  it('leaves already-compact or unrelated labels unchanged', () => {
    expect(compactLayerOp('A')).toBe('A')
    expect(compactLayerOp('MO(6)')).toBe('MO(6)')
  })
})

describe('snapshotCodeLabel', () => {
  it('renders a masked keycode as outer(inner)', () => {
    expect(snapshotCodeLabel('LSFT(KC_A)')).toBe('LSft(A)')
  })

  it('renders a layer-tap mask with the compact layer digit and inner label', () => {
    // Session above only registered 2 layers, so LT3(kc) isn't a
    // registered Keycode -- this exercises resolveSnapshotLabel's
    // static-template fallback, same as a snapshot's own keymap
    // reporting a layer index the session doesn't know about. Uses the
    // canonical qmkId (KC_SPACE, what `serialize` actually records) —
    // findKeycode isn't alias-aware, so an alias spelling like KC_SPC
    // wouldn't resolve to a label here, but recorded snapshots never
    // contain aliases in the first place.
    expect(snapshotCodeLabel('LT3(KC_SPACE)')).toBe('LT3(Space)')
  })

  it('renders MO(N) for a layer index the session does not have', () => {
    expect(snapshotCodeLabel('MO(6)')).toBe('MO(6)')
  })

  it('collapses to the outer alone when the inner resolves empty (RAG_T(KC_NO))', () => {
    expect(snapshotCodeLabel('RAG_T(KC_NO)')).toBe('RAG_T')
  })

  it('strips newlines from a multi-line keycode label (QK_BOOT)', () => {
    expect(snapshotCodeLabel('QK_BOOT')).toBe('Boot-loader')
  })

  it('falls back to the qmkId string for something resolveSnapshotLabel cannot classify further', () => {
    expect(snapshotCodeLabel('M20')).toBe('M20')
  })
})
