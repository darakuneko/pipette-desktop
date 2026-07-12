// SPDX-License-Identifier: GPL-2.0-or-later
// Shared helper for resolving snapshot-recorded QMK ids against the
// snapshot's own vial protocol version instead of the current session's.
// Lives outside any single Analyze view (heatmap, finger IKI, ...) so
// both can depend on it without one view importing from another.

import { getProtocol, setProtocol } from '../../../shared/keycodes/keycodes'

/** Run `body` with `getProtocol()` temporarily set to `protocol` so
 * keycode string↔number conversion resolves against the snapshot's own
 * protocol version, then restore. Protocol-dependent keycodes (macros,
 * tap dance, QK_BOOT, …) map to different numeric values in v5 and v6,
 * and per-snapshot aggregates (heatmap cells, bigram pairs) store the
 * numeric codes recorded under the snapshot's protocol — resolving with
 * the current global protocol would mismatch a v5 snapshot viewed in a
 * v6 session. Mirrors `withImportProtocol` in
 * `src/main/favorite-store.ts`; `undefined` (older snapshots without
 * `vialProtocol`) keeps the current default. */
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
