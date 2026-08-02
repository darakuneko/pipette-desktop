// SPDX-License-Identifier: GPL-2.0-or-later
// Shared protocol-scoping helpers for keycode serialize/deserialize.
// Both main (favorite import/export) and renderer (Analyze snapshot
// resolution) need to run a body under a specific vial protocol version
// -- not the current global one -- then restore. Consolidates what used
// to be four near-duplicate per-module helpers into the two semantics
// that actually differ: deserialize-only (no RAWCODES_MAP rebuild
// needed) and serialize-safe (rebuild required).

import { getProtocol, setProtocol, recreateKeycodes } from './keycodes'

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
 * No `protocol === getProtocol()` fast path here (unlike
 * `withSerializeProtocol` below) — intentionally not added in this
 * pass. It would be an observable no-op (`setProtocolValue` is a plain
 * assignment), but is left out to keep this a pure carry-over of the
 * two deserialize-only helpers it replaces, both of which always ran
 * the set/finally-restore cycle whenever `protocol` was defined.
 */
export function withDeserializeProtocol<T>(protocol: number | undefined, body: () => T): T {
  if (protocol === undefined) return body()
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
 * If `protocol` is undefined or already matches the current global
 * protocol, this skips the set/recreate/restore cycle entirely and just
 * runs `body`.
 *
 * NESTING WARNING: `withDeserializeProtocol` above changes protocol
 * WITHOUT rebuilding `RAWCODES_MAP`. Nesting this function inside a
 * `withDeserializeProtocol` scope with a matching protocol would
 * fast-path over a stale map. No such nesting exists today -- do not
 * add any. Use `withDeserializeProtocol` for deserialize-only bodies
 * (cheaper -- `deserialize` never reads `RAWCODES_MAP`); use this one
 * only for bodies that serialize numeric codes back to qmkId/label
 * strings.
 */
export function withSerializeProtocol<T>(protocol: number | undefined, body: () => T): T {
  const prev = getProtocol()
  if (protocol === undefined || protocol === prev) return body()
  setProtocol(protocol)
  recreateKeycodes()
  try {
    return body()
  } finally {
    setProtocol(prev)
    recreateKeycodes()
  }
}
