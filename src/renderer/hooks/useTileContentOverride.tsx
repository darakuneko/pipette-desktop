// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import type { Keycode } from '../../shared/keycodes/keycodes'
import type { TapDanceEntry } from '../../shared/types/protocol'
import type { MacroAction } from '../../preload/macro'
import { TdTileGrid, MacroTileGrid } from '../components/keycodes/TileGrids'

/**
 * Builds a `tabContentOverride` record for TabbedKeycodes,
 * rendering TD and Macro tile grid previews when data is available.
 */
export function useTileContentOverride(
  tapDanceEntries: TapDanceEntry[] | undefined,
  deserializedMacros: MacroAction[][] | undefined,
  onSelect: (keycode: Keycode) => void,
): Record<string, React.ReactNode> | undefined {
  return useMemo(() => {
    if (!tapDanceEntries?.length && !deserializedMacros) return undefined

    const overrides: Record<string, React.ReactNode> = {}
    if (tapDanceEntries?.length) {
      overrides.tapDance = <TdTileGrid entries={tapDanceEntries} onSelect={onSelect} />
    }
    if (deserializedMacros) {
      overrides.macro = <MacroTileGrid macros={deserializedMacros} onSelect={onSelect} />
    }
    return overrides
  }, [tapDanceEntries, deserializedMacros, onSelect])
}
