// SPDX-License-Identifier: GPL-2.0-or-later
//
// Display names for the bit masks of Key Override / Alt Repeat Key entries,
// shared by their editors (`ModifierPicker.tsx`, `KeyOverridePanelModal.tsx`,
// `AltRepeatKeyPanelModal.tsx`) and the hover bubble
// (`hover-entry-content.ts`) so both name the same bits the same way.

import { AltRepeatKeyOptions, KeyOverrideOptions } from '../../../shared/types/protocol'

/** Modifier names by bit, low bit first. */
export const MODIFIER_LABELS = [
  'LCtrl',
  'LShift',
  'LAlt',
  'LGui',
  'RCtrl',
  'RShift',
  'RAlt',
  'RGui',
] as const

/** Layers a Key Override layer mask can hold. */
export const LAYER_MASK_COUNT = 16

function numericEnumEntries(e: Record<string, string | number>): [string, number][] {
  return Object.entries(e).filter((pair): pair is [string, number] => typeof pair[1] === 'number')
}

/** `[name, flag]` pairs, in declaration order, shown as the option names. */
export const KEY_OVERRIDE_OPTION_ENTRIES = numericEnumEntries(KeyOverrideOptions)
export const ALT_REPEAT_KEY_OPTION_ENTRIES = numericEnumEntries(AltRepeatKeyOptions)

/** Names of the modifiers set in `mask`. */
export function modifierNames(mask: number): string[] {
  return MODIFIER_LABELS.filter((_, bit) => (mask & (1 << bit)) !== 0)
}

/** Names of the options set in `mask`. */
export function optionNames(mask: number, entries: readonly [string, number][]): string[] {
  return entries.filter(([, flag]) => (mask & flag) !== 0).map(([name]) => name)
}

/** Layer numbers set in a layer mask. */
export function layerNumbers(mask: number): number[] {
  return Array.from({ length: LAYER_MASK_COUNT }, (_, bit) => bit).filter((bit) => (mask & (1 << bit)) !== 0)
}
