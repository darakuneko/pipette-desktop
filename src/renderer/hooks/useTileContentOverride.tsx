// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import type { Keycode } from '../../shared/keycodes/keycodes'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../shared/types/protocol'
import type { MacroAction } from '../../preload/macro'
import { TdTileGrid, MacroTileGrid, ComboTileGrid, KeyOverrideTileGrid, AltRepeatKeyTileGrid } from '../components/keycodes/TileGrids'
import { useEntryHoverPreviewEnabled } from '../components/keycodes/entry-hover-context'

interface SettingsTabOptions {
  comboEntries?: ComboEntry[]
  onOpenCombo?: (index: number) => void
  keyOverrideEntries?: KeyOverrideEntry[]
  onOpenKeyOverride?: (index: number) => void
  altRepeatKeyEntries?: AltRepeatKeyEntry[]
  onOpenAltRepeatKey?: (index: number) => void
}

// Stable fallback when the caller omits `onSelect` (the simulation tab is
// read-only, so `KeymapEditor` passes no handler at all rather than
// threading a `packTabReadOnly` ternary down into this hook) —
// `TdTileGrid`/`MacroTileGrid` both require a real function, so this is
// what actually lands on the tile's click instead of
// `gatedHandleKeycodeSelect`.
function noopSelect(): void {}

interface UseTileContentOverrideOptions {
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
  /** Omit to make every TD/Macro tile in the override non-interactive
   *  (falls back to `noopSelect` below) rather than threading a read-only
   *  flag through this hook. */
  onSelect?: (keycode: Keycode) => void
  /** Picker modals pass `pickerDoubleClick` to enable double-click / Enter
   * commit on TD and Macro tiles. The keymap editor omits it because single
   * click there already commits. */
  onDoubleClick?: (keycode: Keycode) => void
  settings?: SettingsTabOptions
}

/** Builds a `tabContentOverride` record for TabbedKeycodes, rendering TD,
 * Macro, Combo, Key Override, and Alt Repeat Key tile grid previews when data
 * is available. */
export function useTileContentOverride({
  tapDanceEntries,
  deserializedMacros,
  onSelect,
  onDoubleClick,
  settings,
}: UseTileContentOverrideOptions): Record<string, React.ReactNode> | undefined {
  const entryHoverPreview = useEntryHoverPreviewEnabled()
  return useMemo(() => {
    const hasSettings = settings?.comboEntries?.length || settings?.keyOverrideEntries?.length || settings?.altRepeatKeyEntries?.length
    if (!tapDanceEntries?.length && !deserializedMacros && !hasSettings) return undefined

    const handleSelect = onSelect ?? noopSelect
    const overrides: Record<string, React.ReactNode> = {}
    if (tapDanceEntries?.length) {
      overrides.tapDance = <TdTileGrid entries={tapDanceEntries} onSelect={handleSelect} onDoubleClick={onDoubleClick} hoverPreview={entryHoverPreview} />
    }
    if (deserializedMacros) {
      overrides.macro = <MacroTileGrid macros={deserializedMacros} onSelect={handleSelect} onDoubleClick={onDoubleClick} hoverPreview={entryHoverPreview} />
    }
    if (settings?.comboEntries?.length && settings.onOpenCombo) {
      overrides.combo = <ComboTileGrid entries={settings.comboEntries} onOpen={settings.onOpenCombo} hoverPreview={entryHoverPreview} />
    }
    if (settings?.keyOverrideEntries?.length && settings.onOpenKeyOverride) {
      overrides.keyOverride = <KeyOverrideTileGrid entries={settings.keyOverrideEntries} onOpen={settings.onOpenKeyOverride} hoverPreview={entryHoverPreview} />
    }
    if (settings?.altRepeatKeyEntries?.length && settings.onOpenAltRepeatKey) {
      overrides.altRepeatKey = <AltRepeatKeyTileGrid entries={settings.altRepeatKeyEntries} onOpen={settings.onOpenAltRepeatKey} hoverPreview={entryHoverPreview} />
    }
    return overrides
  }, [tapDanceEntries, deserializedMacros, onSelect, onDoubleClick, entryHoverPreview, settings?.comboEntries, settings?.onOpenCombo, settings?.keyOverrideEntries, settings?.onOpenKeyOverride, settings?.altRepeatKeyEntries, settings?.onOpenAltRepeatKey])
}
