// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pure rewrite-table engine for the Key Label "apply to keymap" feature
// (Plan-key-label-keymap-apply). A Key Label map only overlays *display*
// labels on top of the existing keymap — this module answers a stricter
// question: is the map a pure QWERTY-keycode permutation (Colemak,
// Dvorak, ...) that can be used to literally rewrite the keymap so the
// physical keys emit the labelled characters directly?
//
// `keymapApplicable` on the stored file (see key-label-store.ts) is only
// an author-supplied hint — this builder is the actual authority: it
// re-derives the same conclusion from the map data and refuses to build
// a table for anything that isn't a clean 1:1 character permutation
// (multi-line shift/altgr labels, unresolvable characters, keycode
// passthrough aliases, non-injective mappings, or a map that isn't CLOSED —
// every replacement target must itself have its own source entry — all
// fail the build).

import { parseLayoutEntry, firstCodePoint, getReverseMap, type LayoutShape } from './layout-parse'
import {
  findKeycode,
  isBasic,
  serialize,
  deserialize,
  isModTapKeycode,
  buildModTapKeycode,
  isLTKeycode,
  extractLTLayer,
  buildLTKeycode,
  isModMaskKeycode,
  extractModMask,
  extractBasicKey,
  buildModMaskKeycode,
} from '../keycodes/keycodes'

/** Source qmkId -> replacement qmkId. Guaranteed injective by `buildKeymapRewriteTable`. */
export type KeymapRewriteTable = ReadonlyMap<string, string>

export type BuildKeymapRewriteTableResult =
  | { ok: true; table: KeymapRewriteTable }
  | { ok: false; error: string }

// A stable reference (not a fresh `{ map: {} }` literal per call) so
// `getReverseMap`'s WeakMap cache in layout-parse.ts actually hits after
// the first build — the QWERTY-baseline reverse map never changes.
const QWERTY_LAYOUT: LayoutShape = { map: {} }

/**
 * Validate + build the qmkId -> qmkId rewrite table from a Key Label
 * `map`. Every entry must resolve to a single QWERTY-baseline character
 * swap; any entry that doesn't fails the whole build (there is no
 * partial/best-effort table — an inapplicable map must not silently
 * rewrite only some keys). The resulting table must also be CLOSED (a
 * true permutation of its own key set) — see the closure check below.
 */
export function buildKeymapRewriteTable(map: Record<string, string>): BuildKeymapRewriteTableResult {
  const reverse = getReverseMap(QWERTY_LAYOUT)
  const table = new Map<string, string>()
  const usedTargets = new Set<string>()

  for (const [qmkId, label] of Object.entries(map)) {
    if (!findKeycode(qmkId)) {
      return { ok: false, error: `Unknown source keycode: ${qmkId}` }
    }

    // A rewrite-table source must be a plain basic keycode. Accepting a
    // masked/composite/one-shot/tap-dance source (e.g. `LSFT(KC_E)`,
    // `OSM(MOD_LSFT)`, `TD(0)`) would let `rewriteNumericKeycode`'s
    // "not a family I understand" fallback later replace the *whole*
    // composite keycode with a plain basic keycode, silently destroying
    // whatever modifier/layer/tap-dance semantics it carried.
    if (!isBasic(qmkId)) {
      return { ok: false, error: `${qmkId} is not a plain basic keycode` }
    }

    // Authoring convention (see DATA-INVENTORY.md §3.6): a label value
    // that is itself a keycode qmkId is a *display alias* pointing at
    // that keycode's built-in label (e.g. compositeLabels["LALT(KC_L)"]
    // = "KC_LALT"), not a character. It can never be a QWERTY char swap.
    if (findKeycode(label)) {
      return { ok: false, error: `${qmkId}: "${label}" is a keycode passthrough, not a character` }
    }

    const entry = parseLayoutEntry(label)
    if (entry.shift !== undefined) {
      return { ok: false, error: `${qmkId}: "${label}" has a shift pair, cannot flatten to one keycode` }
    }

    const first = firstCodePoint(entry.base)
    if (first === undefined || first !== entry.base) {
      return { ok: false, error: `${qmkId}: base "${entry.base}" is not exactly one character` }
    }

    const target = reverse.get(first.toLowerCase())
    if (!target) {
      return { ok: false, error: `${qmkId}: no QWERTY keycode produces "${first}"` }
    }

    if (usedTargets.has(target)) {
      return { ok: false, error: `Duplicate replacement target: ${target}` }
    }
    usedTargets.add(target)
    table.set(qmkId, target)
  }

  // Closure check: every replacement TARGET must itself be a SOURCE key —
  // i.e. the map must be a true permutation of its own key set, not just a
  // one-directional set of swaps. A table applied directly against the
  // live keymap treats any key outside its source domain as untouched —
  // so a target that isn't also a source is a key nothing ever routes
  // traffic *away* from: two different source keys can end up sending its
  // old character (nothing moved it), while the character that key itself
  // used to send disappears entirely (a real Hub Dvorak defect:
  // `KC_RBRACKET -> "="` and `KC_QUOTE -> "-"` with no entries for
  // `KC_EQUAL`/`KC_MINUS` loses `[`/`]` and duplicates `-`/`=`). Reject the
  // whole build rather than silently applying a subset.
  for (const target of table.values()) {
    if (!table.has(target)) {
      return { ok: false, error: `Map is not closed: target keycode ${target} has no source entry of its own (add one, even if it maps back to itself)` }
    }
  }

  return { ok: true, table }
}

/** Look up a plain (non-composite) keycode's replacement, qmkId-side. */
function rewriteBasicNumeric(code: number, table: KeymapRewriteTable): number {
  const replacement = table.get(serialize(code))
  if (!replacement) return code
  return deserialize(replacement)
}

/**
 * Rewrite one numeric keycode using the table. Plain keycodes (below
 * the basic-keycode ceiling, 0x0100) are looked up directly;
 * masked/composite keycodes (`LSFT(kc)`, `LT(n,kc)`, `MT(mod,kc)`) keep
 * their outer layer (modifier mask / layer number) and only swap the
 * inner basic keycode — and only when the table actually produced a
 * different inner keycode, so a no-hit never rebuilds (and potentially
 * mis-collapses, see the zero-mask Mod-Tap case below) a code that
 * should stay bit-identical. Composite families outside this set (e.g.
 * `OSM(MOD_*)`, `TD(n)`, `LM(n,MOD)`) are left completely untouched:
 * `buildKeymapRewriteTable` never accepts them as a source, so this is
 * defense in depth against a table built (or hand-constructed) outside
 * that validator.
 */
export function rewriteNumericKeycode(code: number, table: KeymapRewriteTable): number {
  if (isModTapKeycode(code)) {
    const mod = extractModMask(code)
    // A zero modifier mask means this Mod-Tap-range value isn't really
    // a Mod-Tap composite — `buildModTapKeycode(0, basic)` collapses to
    // a bare basic keycode, stripping the QK_MOD_TAP base even when
    // nothing should change. Treat it as opaque and pass it through.
    if (mod === 0) return code
    const basic = extractBasicKey(code)
    const newBasic = rewriteBasicNumeric(basic, table)
    if (newBasic === basic) return code
    return buildModTapKeycode(mod, newBasic)
  }
  if (isLTKeycode(code)) {
    const layer = extractLTLayer(code)
    const basic = extractBasicKey(code)
    const newBasic = rewriteBasicNumeric(basic, table)
    if (newBasic === basic) return code
    return buildLTKeycode(layer, newBasic)
  }
  if (isModMaskKeycode(code)) {
    const mod = extractModMask(code)
    const basic = extractBasicKey(code)
    const newBasic = rewriteBasicNumeric(basic, table)
    if (newBasic === basic) return code
    return buildModMaskKeycode(mod, newBasic)
  }
  if (code < 0x0100) return rewriteBasicNumeric(code, table)
  return code
}
