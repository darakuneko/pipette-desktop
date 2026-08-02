// SPDX-License-Identifier: GPL-2.0-or-later
// Shared helper for resolving snapshot-recorded QMK ids against the
// snapshot's own vial protocol version instead of the current session's.
// Lives outside any single Analyze view (heatmap, finger IKI, ...) so
// both can depend on it without one view importing from another.

import { getProtocol, recreateKeycodes, setProtocol } from '../../../shared/keycodes/keycodes'

/** Run `body` with `getProtocol()` temporarily set to `protocol` so
 * keycode string↔number conversion resolves against the snapshot's own
 * protocol version, then restore. Protocol-dependent keycodes (macros,
 * tap dance, QK_BOOT, …) map to different numeric values in v5 and v6,
 * and per-snapshot aggregates (heatmap cells, bigram pairs) store the
 * numeric codes recorded under the snapshot's protocol — resolving with
 * the current global protocol would mismatch a v5 snapshot viewed in a
 * v6 session. Mirrors `withImportProtocol` in
 * `src/main/favorite-store.ts`; `undefined` (older snapshots without
 * `vialProtocol`) keeps the current default.
 *
 * Deliberately skips `recreateKeycodes()` (unlike
 * `withSnapshotSerializeProtocol` below): every current caller only
 * `deserialize`s a qmkId string to a number, which resolves through
 * `qmkIdToKeycode` + `resolve()`/`getProtocolValue()`, never through
 * `RAWCODES_MAP` — there is no frozen snapshot here that needs
 * rebuilding. Use `withSnapshotSerializeProtocol` for any body that
 * calls `serialize`/`codeToLabel` (number → qmkId/label). */
export function withSnapshotProtocol<T>(protocol: number | undefined, body: () => T): T {
  if (protocol === undefined) return body()
  const prev = getProtocol()
  setProtocol(protocol)
  try {
    return body()
  } finally {
    setProtocol(prev)
  }
}

/** Run `body` with `getProtocol()` temporarily set to `protocol` AND
 * `RAWCODES_MAP` rebuilt for it, so `serialize`/`codeToLabel` resolve a
 * snapshot-recorded numeric code against the snapshot's own protocol
 * version instead of the current session's. Restores both in `finally`.
 *
 * `setProtocol` alone is NOT sufficient here: `RAWCODES_MAP` (what
 * `serialize` actually reads for non-trivial/masked codes) is a frozen
 * snapshot built by `recreateKeycodes()` under whatever protocol was
 * active at the time — it has to be rebuilt for the requested protocol
 * before serializing, and rebuilt again on the way back out so callers
 * after this function see the renderer's normal session-protocol
 * tables. Mirrors `withExportProtocol` in `src/main/favorite-store.ts`.
 *
 * `body` MUST be strictly synchronous: `protocol`/`RAWCODES_MAP` are
 * module-global state; an `await` inside `body` would let interleaved
 * work (including a second call into this function) observe or restore
 * the wrong protocol/map.
 *
 * If `protocol` is undefined or already matches the current global
 * protocol, this skips the set/recreate/restore cycle entirely and just
 * runs `body`.
 *
 * NESTING WARNING: the plain `withSnapshotProtocol` above changes
 * protocol WITHOUT rebuilding `RAWCODES_MAP`. Nesting this function
 * inside a `withSnapshotProtocol` scope with a matching protocol would
 * fast-path over a stale map. No such nesting exists today — do not add
 * any. Use the plain wrapper for deserialize-only bodies (cheaper —
 * `deserialize` never reads `RAWCODES_MAP`); use this one only for
 * bodies that serialize numeric codes back to qmkId/label strings. */
export function withSnapshotSerializeProtocol<T>(protocol: number | undefined, body: () => T): T {
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
