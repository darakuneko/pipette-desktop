// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import type { Keycode } from '../../shared/keycodes/keycodes'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../shared/types/protocol'
import type { MacroAction } from '../../preload/macro'
import { TdTileGrid, MacroTileGrid, ComboTileGrid, KeyOverrideTileGrid, AltRepeatKeyTileGrid } from '../components/keycodes/TileGrids'
import { QmkSettings } from '../components/editors/QmkSettings'

interface ComboSettingsProps {
  supportedQsids: Set<number>
  qmkSettingsGet: (qsid: number) => Promise<number[]>
  qmkSettingsSet: (qsid: number, data: number[]) => Promise<void>
  qmkSettingsReset: () => Promise<void>
  onSettingsUpdate?: (qsid: number, data: number[]) => void
}

interface SettingsTabOptions {
  comboEntries?: ComboEntry[]
  onOpenCombo?: (index?: number) => void
  comboSettings?: ComboSettingsProps
  keyOverrideEntries?: KeyOverrideEntry[]
  onOpenKeyOverride?: (index?: number) => void
  altRepeatKeyEntries?: AltRepeatKeyEntry[]
  onOpenAltRepeatKey?: (index?: number) => void
}

/**
 * Builds a `tabContentOverride` record for TabbedKeycodes,
 * rendering TD, Macro, Combo, Key Override, and Alt Repeat Key tile grid previews when data is available.
 */
export function useTileContentOverride(
  tapDanceEntries: TapDanceEntry[] | undefined,
  deserializedMacros: MacroAction[][] | undefined,
  onSelect: (keycode: Keycode) => void,
  settings?: SettingsTabOptions,
): Record<string, React.ReactNode> | undefined {
  return useMemo(() => {
    const hasSettings = settings?.comboEntries?.length || settings?.keyOverrideEntries?.length || settings?.altRepeatKeyEntries?.length
    if (!tapDanceEntries?.length && !deserializedMacros && !hasSettings) return undefined

    const overrides: Record<string, React.ReactNode> = {}
    if (tapDanceEntries?.length) {
      overrides.tapDance = <TdTileGrid entries={tapDanceEntries} onSelect={onSelect} />
    }
    if (deserializedMacros) {
      overrides.macro = <MacroTileGrid macros={deserializedMacros} onSelect={onSelect} />
    }
    if (settings?.comboEntries?.length && settings.onOpenCombo) {
      overrides.combo = (
        <>
          <ComboTileGrid entries={settings.comboEntries} onOpenCombo={settings.onOpenCombo} />
          {settings.comboSettings && (
            <div className="mt-4 border-t border-edge pt-4">
              <QmkSettings
                tabName="Combo"
                supportedQsids={settings.comboSettings.supportedQsids}
                qmkSettingsGet={settings.comboSettings.qmkSettingsGet}
                qmkSettingsSet={settings.comboSettings.qmkSettingsSet}
                qmkSettingsReset={settings.comboSettings.qmkSettingsReset}
                onSettingsUpdate={settings.comboSettings.onSettingsUpdate}
              />
            </div>
          )}
        </>
      )
    }
    if (settings?.keyOverrideEntries?.length && settings.onOpenKeyOverride) {
      overrides.keyOverride = <KeyOverrideTileGrid entries={settings.keyOverrideEntries} onOpen={settings.onOpenKeyOverride} />
    }
    if (settings?.altRepeatKeyEntries?.length && settings.onOpenAltRepeatKey) {
      overrides.altRepeatKey = <AltRepeatKeyTileGrid entries={settings.altRepeatKeyEntries} onOpen={settings.onOpenAltRepeatKey} />
    }
    return overrides
  }, [tapDanceEntries, deserializedMacros, onSelect, settings?.comboEntries, settings?.onOpenCombo, settings?.comboSettings, settings?.keyOverrideEntries, settings?.onOpenKeyOverride, settings?.altRepeatKeyEntries, settings?.onOpenAltRepeatKey])
}
