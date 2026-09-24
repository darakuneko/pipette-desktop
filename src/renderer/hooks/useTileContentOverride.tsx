// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import type { Keycode } from '../../shared/keycodes/keycodes'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../shared/types/protocol'
import type { MacroAction } from '../../preload/macro'
import { TdTileGrid, MacroTileGrid, ComboTileGrid, KeyOverrideTileGrid, AltRepeatKeyTileGrid } from '../components/keycodes/TileGrids'
import { useEntryHoverPreviewEnabled } from '../components/keycodes/entry-hover-context'
import { TileEntryHoverBubble, useTileEntryHover } from '../components/keycodes/tile-entry-hover'
import type { HoverEntrySources } from '../components/keycodes/hover-entry'
import type { TabContentOverride } from '../components/keycodes/tabbed-keycodes-model'

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

/** Builds the `tabContentOverride` for TabbedKeycodes, rendering TD,
 * Macro, Combo, Key Override, and Alt Repeat Key tile grid previews when data
 * is available, plus one entry hover bubble shared by all of them. The
 * bubble's open / closed state lives in the bubble node alone, so hovering
 * never re-renders the caller or the grids. */
export function useTileContentOverride({
  tapDanceEntries,
  deserializedMacros,
  onSelect,
  onDoubleClick,
  settings,
}: UseTileContentOverrideOptions): TabContentOverride | undefined {
  const entryHoverPreview = useEntryHoverPreviewEnabled()
  const hover = useTileEntryHover()
  return useMemo(() => {
    const hasSettings = settings?.comboEntries?.length || settings?.keyOverrideEntries?.length || settings?.altRepeatKeyEntries?.length
    if (!tapDanceEntries?.length && !deserializedMacros && !hasSettings) return undefined

    const handleSelect = onSelect ?? noopSelect
    const handlers = entryHoverPreview ? hover.handlers : undefined
    const tabs: Record<string, React.ReactNode> = {}
    const sources: HoverEntrySources = {}
    if (tapDanceEntries?.length) {
      tabs.tapDance = <TdTileGrid entries={tapDanceEntries} onSelect={handleSelect} onDoubleClick={onDoubleClick} hover={handlers} />
      sources.tapDance = tapDanceEntries
    }
    if (deserializedMacros) {
      tabs.macro = <MacroTileGrid macros={deserializedMacros} onSelect={handleSelect} onDoubleClick={onDoubleClick} hover={handlers} />
      sources.macro = deserializedMacros
    }
    if (settings?.comboEntries?.length && settings.onOpenCombo) {
      tabs.combo = <ComboTileGrid entries={settings.comboEntries} onOpen={settings.onOpenCombo} hover={handlers} />
      sources.combo = settings.comboEntries
    }
    if (settings?.keyOverrideEntries?.length && settings.onOpenKeyOverride) {
      tabs.keyOverride = <KeyOverrideTileGrid entries={settings.keyOverrideEntries} onOpen={settings.onOpenKeyOverride} hover={handlers} />
      sources.keyOverride = settings.keyOverrideEntries
    }
    if (settings?.altRepeatKeyEntries?.length && settings.onOpenAltRepeatKey) {
      tabs.altRepeatKey = <AltRepeatKeyTileGrid entries={settings.altRepeatKeyEntries} onOpen={settings.onOpenAltRepeatKey} hover={handlers} />
      sources.altRepeatKey = settings.altRepeatKeyEntries
    }
    const bubble = <TileEntryHoverBubble hover={hover} sources={sources} enabled={entryHoverPreview} />
    return { tabs, bubble, hideBubble: hover.hide }
  }, [hover, tapDanceEntries, deserializedMacros, onSelect, onDoubleClick, entryHoverPreview, settings?.comboEntries, settings?.onOpenCombo, settings?.keyOverrideEntries, settings?.onOpenKeyOverride, settings?.altRepeatKeyEntries, settings?.onOpenAltRepeatKey])
}
