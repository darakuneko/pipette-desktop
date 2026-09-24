// SPDX-License-Identifier: GPL-2.0-or-later
//
// The entries the hover bubble can show — macros, Tap Dance, Combo, Key
// Override and Alt Repeat Key — identified by kind + index. The
// "configured" rules are the ones the picker tiles (`TileGrids.tsx`) use to
// choose between a summary and "N/C", so a tile that reads N/C never opens
// a bubble.

import type { MacroAction } from '../../../preload/macro'
import type { AltRepeatKeyEntry, ComboEntry, KeyOverrideEntry, TapDanceEntry } from '../../../shared/types/protocol'

export type HoverEntryKind = 'macro' | 'tapDance' | 'combo' | 'keyOverride' | 'altRepeatKey'

export interface HoverEntrySources {
  macro?: MacroAction[][]
  tapDance?: TapDanceEntry[]
  combo?: ComboEntry[]
  keyOverride?: KeyOverrideEntry[]
  altRepeatKey?: AltRepeatKeyEntry[]
}

export type HoverEntry =
  | { kind: 'macro'; value: MacroAction[] }
  | { kind: 'tapDance'; value: TapDanceEntry }
  | { kind: 'combo'; value: ComboEntry }
  | { kind: 'keyOverride'; value: KeyOverrideEntry }
  | { kind: 'altRepeatKey'; value: AltRepeatKeyEntry }

export function isMacroConfigured(actions: MacroAction[]): boolean {
  return actions.length > 0
}

export function isTapDanceConfigured(e: TapDanceEntry): boolean {
  return e.onTap !== 0 || e.onHold !== 0 || e.onDoubleTap !== 0 || e.onTapHold !== 0
}

export function isComboConfigured(e: ComboEntry): boolean {
  return e.key1 !== 0 || e.key2 !== 0
}

/** A disabled entry that still has keys counts as configured. */
export function isKeyOverrideConfigured(e: KeyOverrideEntry): boolean {
  return e.enabled || e.triggerKey !== 0 || e.replacementKey !== 0
}

/** A disabled entry that still has keys counts as configured. */
export function isAltRepeatKeyConfigured(e: AltRepeatKeyEntry): boolean {
  return e.enabled || e.lastKey !== 0 || e.altKey !== 0
}

/** The configured entry at `index` of `kind`, or null when it is missing
 *  or not configured. */
export function resolveHoverEntry(sources: HoverEntrySources, kind: HoverEntryKind, index: number): HoverEntry | null {
  switch (kind) {
    case 'macro': {
      const value = sources.macro?.[index]
      return value && isMacroConfigured(value) ? { kind, value } : null
    }
    case 'tapDance': {
      const value = sources.tapDance?.[index]
      return value && isTapDanceConfigured(value) ? { kind, value } : null
    }
    case 'combo': {
      const value = sources.combo?.[index]
      return value && isComboConfigured(value) ? { kind, value } : null
    }
    case 'keyOverride': {
      const value = sources.keyOverride?.[index]
      return value && isKeyOverrideConfigured(value) ? { kind, value } : null
    }
    case 'altRepeatKey': {
      const value = sources.altRepeatKey?.[index]
      return value && isAltRepeatKeyConfigured(value) ? { kind, value } : null
    }
  }
}
