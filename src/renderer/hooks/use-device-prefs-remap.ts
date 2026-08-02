// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useMemo } from 'react'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import { useKeyLabelLookup } from './useKeyLabelLookup'
import { buildKeymapRewriteTable, type KeymapRewriteTable } from '../../shared/keymap/keymap-apply'
import type { RemapKind } from '../components/keyboard/constants'

export function useDevicePrefsRemap(layout: KeyboardLayoutId) {
  const lookup = useKeyLabelLookup()

  // Trigger an IPC fetch for non-built-in layouts so the remap callbacks
  // see the map / compositeLabels as soon as the store responds.
  useEffect(() => {
    void lookup.ensure(layout)
  }, [lookup, layout])

  // Single source of truth for "does this pack's map build a rewrite
  // table" — `packIsPurePermutation` (Phase P, picker gate) needs the same
  // `.ok` verdict `buildKeymapRewriteTable` computes for the Key Label
  // "apply to keymap" rewrite.
  //
  // Memoized on the pack map's own object reference (stable per cache
  // entry, see `useKeyLabelLookup.getMap`) rather than on `lookup` itself
  // (a fresh object literal every render), so this only rebuilds when the
  // pack data actually changes. QWERTY/no pack: `map` is `undefined` (not
  // yet loaded) or an empty object (built-in QWERTY, or an uninstalled
  // pack that never resolves) — an empty map trivially passes
  // `buildKeymapRewriteTable` (there is nothing to permute).
  const activeMap = lookup.getMap(layout)
  const rewriteTableResult = useMemo(
    () => (activeMap ? buildKeymapRewriteTable(activeMap) : undefined),
    [activeMap],
  )

  // Picker-only gate (Plan-qwerty-select-no-rewrite v6, Phase P): a pure
  // QWERTY-keycode permutation pack (Colemak, Eucalyn, Dvorak, ...) must
  // leave the key PICKER raw — see `pickerRemapLabel`'s doc comment below.
  // Re-derives the same `.ok` verdict `buildKeymapRewriteTable` already
  // computes for the Key Label "apply to keymap" rewrite, rather than
  // consulting `getKeymapApplicable` (an author-supplied hint the rewrite
  // path deliberately treats as advisory only, not authoritative). An
  // undefined `rewriteTableResult` (no pack loaded) defaults to "pure
  // permutation" too since `remapLabel` is already identity in that state
  // regardless of this flag.
  const packIsPurePermutation = !rewriteTableResult || rewriteTableResult.ok

  // Author-supplied "wants a keymap rewrite" hint (Plan-key-label-keymap-
  // apply) — `false` for built-in QWERTY and for any pack not yet loaded.
  // Combined with `packIsPurePermutation` below (the structural `.ok`
  // verdict) into the single Plan-qwerty-select-no-rewrite v7 predicate:
  // `keymapApplicable && buildKeymapRewriteTable(map).ok`. That predicate —
  // not `.ok` alone — is what `remapKind` now gates on, so it doubles as
  // the simulation-tab / Apply-eligibility signal `KeymapEditor` consumes
  // via `remapKind === 'simulated'` (tab visibility, Apply button, and the
  // simulated tint all read the exact same boolean, never three separately
  // maintained checks).
  const keymapApplicable = !!activeMap && lookup.getKeymapApplicable(layout)

  // Which remap tint `isRemapped`-tinted keys use on the keymap surface
  // (see the `remapKind` field's own doc comment on the return type).
  // "An active pack map is loaded" is checked directly against `activeMap`
  // rather than `rewriteTableResult` — QWERTY's map is `{}` (truthy,
  // trivially a pure permutation) but has nothing to tint, so gating on
  // "non-empty" here avoids relying on `rewriteTableResult`'s undefined-
  // ness to mean "no pack" (it doesn't for QWERTY, which is why
  // `packIsPurePermutation`'s own doc comment calls that state out
  // separately). `keymapApplicable` is the addition over the old
  // `.ok`-only check: a pack that structurally permutes but was never
  // flagged applicable (the author's own opt-out) now renders with the
  // ACTUAL tint in place, same as a JIS-type deviation pack, instead of
  // simulating a Rewrite nothing downstream will actually offer.
  const remapKind: RemapKind = useMemo(() => {
    const hasActivePackMap = !!activeMap && Object.keys(activeMap).length > 0
    return hasActivePackMap && keymapApplicable && packIsPurePermutation ? 'simulated' : 'actual'
  }, [activeMap, keymapApplicable, packIsPurePermutation])

  // The active pack's own rewrite table, exposed ONLY while it's actually
  // eligible for a keymap Rewrite (`remapKind === 'simulated'` — the exact
  // state `KeymapEditor` requires before it ever renders the simulation
  // tab / Apply button in the first place). `useKeymapApplyPrompt
  // .requestApply` reads this directly instead of re-resolving the same
  // map through its own `useKeyLabelLookup` instance: by the time the
  // Apply button is reachable at all, `rewriteTableResult` above has
  // already built successfully for this exact `layout`, so there is
  // nothing left to look up. `undefined` (not `remapKind !== 'simulated'`
  // alone) is the guard `requestApply` no-ops on, mirroring the old
  // resolver's own null-return contract.
  const activeRewriteTable = remapKind === 'simulated' && rewriteTableResult?.ok
    ? rewriteTableResult.table
    : undefined

  // Display name for the active pack — used by `KeymapEditor`'s simulation
  // tab label when `remapKind === 'simulated'`. Falls back to the raw id
  // (same fallback `useKeyLabelLookup.getName` documents) so a not-yet-
  // loaded pack never renders an empty tab.
  const activeLayoutName = lookup.getName(layout) ?? layout

  // The active Key Label pack's own labels, resolved through its
  // compositeLabels -> map lookup order and falling back to qmkId itself
  // when neither has an entry. QWERTY's map/compositeLabels are always
  // empty (`BUILTIN_QWERTY_LAYOUT_ID` in keyboard-layouts.ts), so it
  // resolves to identity without a separate guard. Feeds the key picker
  // unconditionally, and the keymap surface too EXCEPT `KeymapEditor`'s
  // Base tab, which reads its own raw/identity keycode builder instead of
  // calling this at all (Plan-qwerty-select-no-rewrite v7 — シミュレーション
  // タブ方式: the simulation tab shows exactly what this resolves to, Base
  // shows the real keymap regardless of it). A Rewrite never leaves
  // anything for this to simulate — it resets `layout` back to QWERTY on
  // success (raw characters, no color, no tabs), the same clean state a
  // snapshot/.vil restore leaves.
  const remapLabel = useCallback(
    (qmkId: string): string => {
      const composite = lookup.getCompositeLabels(layout)?.[qmkId]
      if (composite !== undefined) return composite
      const mapped = lookup.getMap(layout)?.[qmkId]
      if (mapped !== undefined) return mapped
      return qmkId
    },
    [lookup, layout],
  )

  // The blue "remapped" tint: true whenever the resolved label differs from
  // the qmkId itself — the same `remapLabel(x) !== x` rule every picker/
  // palette consumer (KeycodeGrid.getRemapDisplayLabel) already uses.
  const isRemapped = useCallback(
    (qmkId: string): boolean => remapLabel(qmkId) !== qmkId,
    [remapLabel],
  )

  // Delegates to `remapLabel` itself for the deviation-pack branch (rather
  // than re-resolving compositeLabels/map independently) so the picker and
  // keymap legend can never disagree on what a deviation pack's label is —
  // only WHETHER it's shown differs between the two surfaces.
  const pickerRemapLabel = useCallback(
    (qmkId: string): string => (packIsPurePermutation ? qmkId : remapLabel(qmkId)),
    [packIsPurePermutation, remapLabel],
  )

  return {
    remapLabel,
    isRemapped,
    remapKind,
    activeRewriteTable: activeRewriteTable as KeymapRewriteTable | undefined,
    activeLayoutName,
    pickerRemapLabel,
  }
}
