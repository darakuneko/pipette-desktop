// SPDX-License-Identifier: GPL-2.0-or-later
// Resolves Speed-ranking / bigram-pair labels straight from a
// snapshot's OWN recorded qmk strings, instead of round-tripping a
// numeric code back through the CURRENT session's `RAWCODES_MAP`
// (option B from .claude/tasks/backlog/Task-speed-ranking-snapshot-labels.md,
// the keyboard-shape follow-up to #359's protocol-version fix).
//
// The round-trip breaks whenever the snapshot's keyboard had more
// layers/macros/tap-dances than the currently connected session:
// `RAWCODES_MAP` is only populated for what the session's keyboard
// context registered (see `recreateKeyboardKeycodes`), so a code like
// `M20` recorded by a 32-macro keyboard falls through to raw hex, and
// `MO(6)` on a keyboard the session sees as having < 7 layers lands in
// the wrong group bucket (`serialize` can't find an exact
// `RAWCODES_MAP` entry and returns bare hex instead of `"MO(6)"`).
// Building `code -> qmkId` directly from the snapshot's own keymap
// strings sidesteps that entirely: the string was already right at
// record time, so this only ever needs the forward (string -> number)
// direction, which is protocol-static rather than session-registry
// dependent.

import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import { deserialize, resolve, resolveSnapshotLabel } from '../../../shared/keycodes/keycodes'
import { withDeserializeProtocol } from '../../../shared/keycodes/with-protocol'

// LT/LM write the layer digit directly after the op (`LT1 3`); MO-family
// ops keep the digit inside parens (`MO(3)`) and never match this —
// mirrors the layer-op compaction key-heatmap-helpers.ts's ranking rows
// already apply to `resolveSnapshotLabel().outer`.
const COMPACT_LAYER_OP_RE = /^(LT|LM|MO|DF|PDF|TG|TT|OSL|TO)\s(\d+)$/

/** Collapses `resolveSnapshotLabel`'s spaced `"LT1 3"` outer form into
 * the compact `"LT13"` display form the Analyze rankings use. A no-op
 * for anything that doesn't match (already-compact ops, plain labels).
 * Shared by `key-heatmap-helpers.ts`'s Count-mode rankings and
 * `snapshotCodeLabel` below so both label styles agree. */
export function compactLayerOp(label: string): string {
  const m = label.match(COMPACT_LAYER_OP_RE)
  return m ? `${m[1]}${m[2]}` : label
}

/**
 * Decode one snapshot qmkId string to its numeric code, trusting a
 * nonzero `deserialize` result and only falling back to `resolve` when
 * `deserialize` reports 0 for something other than the real "no key"
 * sentinel `KC_NO`.
 *
 * `deserialize('M20')` silently returns `0` (not a throw) whenever the
 * CURRENT session's connected keyboard registered fewer than 21
 * macros: `qmkIdToKeycode` only has `M0..M(macroCount-1)` entries for
 * this session (see `recreateKeyboardKeycodes`), so the direct lookup
 * misses and `deserialize` falls through to
 * `decodeAnyKeycode('M20')` — which also doesn't know the bare
 * identifier `M20` (only registered aliases and function-call forms
 * resolve), swallows the parse error internally, and returns 0.
 * `resolve('M20')`, in contrast, reads the protocol's static `kc`
 * table (`keycodesV5`/`keycodesV6`), where `M0..M255` (and
 * `TD(0..255)`) are always fully generated regardless of what the
 * session's keyboard happens to report — so it succeeds exactly where
 * `deserialize` silently didn't.
 *
 * Returns `undefined` when both resolution paths fail (a truly
 * unrecognized qmkId) so callers can skip the entry instead of
 * polluting a code map with a bogus 0.
 */
export function decodeSnapshotQmkId(qmkId: string): number | undefined {
  let viaDeserialize: number
  try {
    viaDeserialize = deserialize(qmkId)
  } catch {
    viaDeserialize = 0
  }
  if (viaDeserialize !== 0 || qmkId === 'KC_NO') return viaDeserialize
  try {
    return resolve(qmkId)
  } catch {
    return undefined
  }
}

/**
 * Builds a `code -> qmkId` reverse map from every layer of the
 * snapshot's own keymap (not just the layers currently selected in the
 * Heatmap tab — see `KeyHeatmapChart.tsx`'s `layerKeycodes` memo for
 * that narrower, selection-scoped map). Runs under the snapshot's own
 * `vialProtocol` since `deserialize`/`resolve` read the protocol
 * variable for protocol-dependent bases (`QK_BOOT` et al.).
 *
 * First-writer-wins on a code recorded by more than one qmkId (layer
 * order, then row-major within a layer) — an arbitrary but stable tie
 * break; nothing in the recorded keymap distinguishes "which qmkId is
 * canonical" for a colliding code.
 */
export function buildSnapshotQmkByCode(
  snapshot: TypingKeymapSnapshot,
  vialProtocol?: number,
): ReadonlyMap<number, string> {
  return withDeserializeProtocol(vialProtocol, () => {
    const result = new Map<number, string>()
    if (!Array.isArray(snapshot.keymap)) return result
    for (const layer of snapshot.keymap) {
      if (!Array.isArray(layer)) continue
      for (const row of layer) {
        if (!Array.isArray(row)) continue
        for (const qmkId of row) {
          if (typeof qmkId !== 'string' || qmkId.length === 0) continue
          const code = decodeSnapshotQmkId(qmkId)
          if (code === undefined || result.has(code)) continue
          result.set(code, qmkId)
        }
      }
    }
    return result
  })
}

/**
 * Display label for a snapshot qmkId string — the label counterpart to
 * `decodeSnapshotQmkId`'s numeric decode. Unlike `codeToLabel` (number
 * -> label via `serialize`, which needs the session's `RAWCODES_MAP` to
 * have registered the exact code), this starts from the qmkId string
 * the snapshot already recorded, so it never depends on the session's
 * keyboard shape.
 *
 * Masked ids render `outer(inner)` (`LSFT(KC_A)` -> `"LSft(A)"`,
 * `LT3(KC_SPC)` -> `"LT3(Space)"`); an empty inner (e.g. `RAG_T(KC_NO)`,
 * whose `KC_NO` inner resolves to an empty label) collapses to the
 * outer alone (`"RAG_T"`) rather than leaving dangling parens. Newlines
 * baked into a keycode's display label (`"Boot-\nloader"`) are joined
 * without a space, matching how the label reads on a single-line
 * physical keycap (`"Boot-loader"`) — deliberately different from
 * `codeToLabel`'s space-joined fallback, since this is the "read the
 * key as printed" path.
 */
export function snapshotCodeLabel(qmkId: string): string {
  const resolved = resolveSnapshotLabel(qmkId)
  const outer = compactLayerOp(resolved.outer)
  const combined = resolved.inner ? `${outer}(${resolved.inner})` : outer
  return combined.replace(/\n/g, '')
}
