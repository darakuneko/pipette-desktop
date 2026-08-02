// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, afterEach } from 'vitest'
import { deserialize, getProtocol, recreateKeycodes, serialize, setProtocol } from '../keycodes'
import { withDeserializeProtocol, withSerializeProtocol } from '../with-protocol'

// 0x7c00 is a deliberate protocol collision (see
// src/main/__tests__/favorite-store.test.ts:511 and
// src/renderer/components/analyze/__tests__/key-heatmap-helpers-speed.test.ts:214):
// QK_BOOT under v6, but the masked keycode RAG_T(kc) with a KC_NO inner
// under v5. Serializing it only proves anything if RAWCODES_MAP was
// actually rebuilt for the requested protocol -- a stale v6 map would
// silently still resolve it to 'QK_BOOT'.
const COLLISION_CODE = 0x7c00

// Every test in this file runs at session protocol 6 (module default).
// Restore it afterwards so state doesn't leak into other test files.
afterEach(() => {
  setProtocol(6)
  recreateKeycodes()
})

describe('withSerializeProtocol', () => {
  it('serializes at the requested protocol and fully restores the map and protocol on return', () => {
    setProtocol(6)
    recreateKeycodes()

    const v5Label = withSerializeProtocol(5, () => serialize(COLLISION_CODE))
    expect(v5Label).toBe('RAG_T(KC_NO)')

    // Exit state: both the protocol variable and RAWCODES_MAP are back
    // to the session's v6 build (not just the variable -- re-serializing
    // proves the map itself was rebuilt on the way out).
    expect(getProtocol()).toBe(6)
    expect(serialize(COLLISION_CODE)).toBe('QK_BOOT')
  })

  it('passes undefined through without touching global protocol state', () => {
    setProtocol(6)
    recreateKeycodes()

    const result = withSerializeProtocol(undefined, () => serialize(COLLISION_CODE))
    expect(result).toBe('QK_BOOT')
    expect(getProtocol()).toBe(6)
  })

  // THE NESTED CASE -- the reason this PR exists.
  //
  // Pre-hardening, withSerializeProtocol's fast path only checked
  // `protocol === getProtocol()`. Nested inside withDeserializeProtocol(5,
  // ...), the protocol variable is already 5 by the time the inner
  // withSerializeProtocol(5, ...) runs, so the pre-hardening fast path
  // would fire and skip the rebuild entirely -- even though RAWCODES_MAP
  // is still the outer scope's session-6 build. serialize(0x7c00) would
  // then wrongly resolve through the stale v6 map and return 'QK_BOOT'.
  //
  // Post-hardening, the fast path also requires
  // `protocol === getRawcodesProtocol()`. The map was last built at 6,
  // not 5, so that second condition fails and the rebuild runs for real.
  it('rebuilds RAWCODES_MAP when nested inside a withDeserializeProtocol scope at the same protocol', () => {
    setProtocol(6)
    recreateKeycodes()

    const result = withDeserializeProtocol(5, () =>
      withSerializeProtocol(5, () => serialize(COLLISION_CODE)),
    )
    expect(result).toBe('RAG_T(KC_NO)')

    // Exit state: fully unwound back to the session default, including
    // RAWCODES_MAP (not just the protocol variable).
    expect(getProtocol()).toBe(6)
    expect(serialize(COLLISION_CODE)).toBe('QK_BOOT')
  })
})

describe('withDeserializeProtocol', () => {
  it('equality fast path: body observes the current protocol unchanged when it already matches', () => {
    setProtocol(6)
    recreateKeycodes()

    const observed = withDeserializeProtocol(6, () => deserialize('QK_BOOT'))
    expect(observed).toBe(0x7c00)
    expect(getProtocol()).toBe(6)
  })

  it('sets and restores the protocol variable for a body run at a different protocol', () => {
    setProtocol(6)
    recreateKeycodes()

    const observed = withDeserializeProtocol(5, () => deserialize('QK_BOOT'))
    expect(observed).toBe(0x5c00)
    expect(getProtocol()).toBe(6)
  })

  it('passes undefined through without touching global protocol state', () => {
    setProtocol(6)
    recreateKeycodes()

    const observed = withDeserializeProtocol(undefined, () => deserialize('QK_BOOT'))
    expect(observed).toBe(0x7c00)
    expect(getProtocol()).toBe(6)
  })
})
