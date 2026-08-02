// SPDX-License-Identifier: GPL-2.0-or-later
// Shared protocol-scoping helpers for keycode serialize/deserialize.
// Both main (favorite import/export) and renderer (Analyze snapshot
// resolution) need to run a body under a specific vial protocol version
// -- not the current global one -- then restore. Consolidates what used
// to be four near-duplicate per-module helpers into the two semantics
// that actually differ: deserialize-only (no RAWCODES_MAP rebuild
// needed) and serialize-safe (rebuild required).

import { getProtocol, getRawcodesProtocol, setProtocol, recreateKeycodes } from './keycodes'

/**
 * Run `body` with `getProtocol()` temporarily set to `protocol` so
 * `deserialize` resolves keycode strings against `protocol` instead of
 * the current global one. Restores the previous protocol in `finally`.
 *
 * If `protocol` is undefined (legacy v2 favorite file, out-of-spec v3
 * without `vial_protocol`, or an older Analyze snapshot with no
 * recorded `vialProtocol`), runs `body` with the current default
 * protocol unchanged.
 *
 * Deliberately skips `recreateKeycodes()` (unlike `withSerializeProtocol`
 * below): `deserialize` resolves qmkId strings through `qmkIdToKeycode`
 * + `resolve()`/`getProtocolValue()`, never through `RAWCODES_MAP`, so
 * there is no frozen snapshot here that needs rebuilding. Use this for
 * any body that only `deserialize`s (string -> number); use
 * `withSerializeProtocol` for a body that calls
 * `serialize`/`codeToLabel` (number -> qmkId/label).
 *
 * Fast path: if `protocol` is undefined or already matches the current
 * global protocol, skips the set/restore cycle and just runs `body`.
 * Unlike `withSerializeProtocol` below, this checks protocol-variable
 * equality ONLY -- there is no second `RAWCODES_MAP`-freshness
 * condition to check, because (per the module doc above) `deserialize`
 * never reads `RAWCODES_MAP`; the protocol variable is the only piece
 * of state this helper's body can observe.
 */
export function withDeserializeProtocol<T>(protocol: number | undefined, body: () => T): T {
  if (protocol === undefined || protocol === getProtocol()) return body()
  const prev = getProtocol()
  setProtocol(protocol)
  try {
    return body()
  } finally {
    setProtocol(prev)
  }
}

/**
 * Run `body` with `getProtocol()` temporarily set to `protocol` AND
 * `RAWCODES_MAP` rebuilt for it, so `serialize`/`codeToLabel` resolve a
 * numeric code against `protocol` instead of the current session's.
 * Restores both in `finally`.
 *
 * `setProtocol` alone is NOT sufficient: `RAWCODES_MAP` (what
 * `serialize` actually reads for non-trivial/masked codes) is a frozen
 * snapshot built by `recreateKeycodes()` under whatever protocol was
 * active at the time -- it has to be rebuilt for the requested protocol
 * before serializing, and rebuilt again on the way back out so callers
 * after this function see the caller's normal protocol tables.
 *
 * `body` MUST be strictly synchronous: `protocol`/`RAWCODES_MAP` are
 * module-global state shared by every caller in flight; an `await`
 * inside `body` would let interleaved work (including a second,
 * concurrent call into this function) observe or restore the wrong
 * protocol/map.
 *
 * Fast path requires BOTH conditions to hold, unlike
 * `withDeserializeProtocol`'s single check: `body` may itself call
 * `deserialize` (which reads the protocol variable via
 * `getProtocolValue()`), AND `serialize` needs `RAWCODES_MAP` built at
 * that same protocol. So this skips the set/recreate/restore cycle
 * only when `protocol` is undefined, or matches BOTH the current
 * protocol variable AND the protocol `RAWCODES_MAP` was last
 * successfully built at (`getRawcodesProtocol()`). If the map is stale
 * relative to the protocol variable -- which happens when this call is
 * nested inside a `withDeserializeProtocol` scope that changed the
 * protocol variable without rebuilding the map -- the second condition
 * fails and the full rebuild runs, even though the first condition
 * alone would have looked like a match.
 *
 * On the way out, the `finally` restores `RAWCODES_MAP` to the protocol
 * it was built at on entry (`prevBuilt`), then restores the protocol
 * variable to its entry value (`prevProtocol`). Restoring in that order
 * means that under nesting inside `withDeserializeProtocol`, this
 * reproduces the exact state the outer scope had set up -- the map
 * rebuild targets the outer scope's protocol, not the just-restored
 * variable. The inner `try/finally` guarantees `prevProtocol` is
 * restored even if the restore-leg `recreateKeycodes()` itself throws.
 *
 * ENFORCED INVARIANT (formerly a nesting warning): nesting this
 * function inside a `withDeserializeProtocol` scope with a matching
 * protocol no longer fast-paths over a stale map -- the `prevBuilt`
 * check above forces the rebuild whenever the map doesn't already match
 * `protocol`. Use `withDeserializeProtocol` for deserialize-only bodies
 * (cheaper -- `deserialize` never reads `RAWCODES_MAP`); use this one
 * for bodies that serialize numeric codes back to qmkId/label strings.
 */
export function withSerializeProtocol<T>(protocol: number | undefined, body: () => T): T {
  const prevProtocol = getProtocol()
  const prevBuilt = getRawcodesProtocol()
  if (protocol === undefined || (protocol === prevProtocol && protocol === prevBuilt)) return body()
  setProtocol(protocol)
  recreateKeycodes()
  try {
    return body()
  } finally {
    setProtocol(prevBuilt)
    try {
      recreateKeycodes()
    } finally {
      setProtocol(prevProtocol)
    }
  }
}
