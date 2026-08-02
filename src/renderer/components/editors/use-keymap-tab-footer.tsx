// SPDX-License-Identifier: GPL-2.0-or-later

// The keycode picker's per-tab footer buttons (Edit JSON / QMK settings
// shortcuts, e.g. Tap Dance / Combo / Key Override / Alt Repeat Key JSON
// editors and the Mouse Keys / Grave Escape / One Shot Keys / Magic /
// Auto Shift / Combo / Lighting settings shortcuts). Consumed by
// KeymapEditor, which passes the result down to KeymapPickerRegion so
// `TabbedKeycodes` can render the group matching its active tab.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../../shared/types/protocol'
import type { MacroAction } from '../../../preload/macro'
import type { EntryJsonEditor, MacroJsonEditor } from './useKeymapJsonEditors'

export interface UseKeymapTabFooterOptions {
  tapDanceEntries?: TapDanceEntry[]
  comboEntries?: ComboEntry[]
  keyOverrideEntries?: KeyOverrideEntry[]
  altRepeatKeyEntries?: AltRepeatKeyEntry[]
  deserializedMacros?: MacroAction[][] | null
  tapHoldSupported?: boolean
  mouseKeysSupported?: boolean
  magicSupported?: boolean
  graveEscapeSupported?: boolean
  autoShiftSupported?: boolean
  oneShotKeysSupported?: boolean
  comboSettingsSupported?: boolean
  onOpenLighting?: () => void
  openSettings: (key: string) => void
  tdJson: EntryJsonEditor<TapDanceEntry>
  comboJson: EntryJsonEditor<ComboEntry>
  koJson: EntryJsonEditor<KeyOverrideEntry>
  arkJson: EntryJsonEditor<AltRepeatKeyEntry>
  macroJson: MacroJsonEditor
}

/** Per-tab footer buttons (Edit JSON / settings shortcuts) shown under the
 *  keycode picker's tab strip — grouped by which tab each button belongs to
 *  so `TabbedKeycodes` can render only the group matching its active tab. */
export function useKeymapTabFooter({
  tapDanceEntries, comboEntries, keyOverrideEntries, altRepeatKeyEntries, deserializedMacros,
  tapHoldSupported, mouseKeysSupported, magicSupported, graveEscapeSupported, autoShiftSupported, oneShotKeysSupported, comboSettingsSupported,
  onOpenLighting, openSettings, tdJson, comboJson, koJson, arkJson, macroJson,
}: UseKeymapTabFooterOptions): Record<string, React.ReactNode> {
  const { t } = useTranslation()
  return useMemo(() => {
    const btnClass = 'rounded border border-edge px-3 py-1 text-xs text-content-secondary hover:text-content hover:bg-surface-dim'
    const buttonDefs = [
      { tab: 'tapDance', key: 'tdJsonEditor', label: t('editor.tapDance.editJson'), onClick: tdJson.open, testId: 'tap-dance-json-editor-btn', enabled: !!tapDanceEntries && tapDanceEntries.length > 0 },
      { tab: 'tapDance', key: 'tapHold', label: t('editor.keymap.tapHoldLabel'), onClick: () => openSettings('tapHold'), testId: 'tap-hold-settings-btn', enabled: tapHoldSupported },
      { tab: 'system', key: 'mouseKeys', label: t('editor.keymap.mouseKeysLabel'), onClick: () => openSettings('mouseKeys'), testId: 'mouse-keys-settings-btn', enabled: mouseKeysSupported },
      { tab: 'modifiers', key: 'graveEscape', label: t('editor.keymap.graveEscapeLabel'), onClick: () => openSettings('graveEscape'), testId: 'grave-escape-settings-btn', enabled: graveEscapeSupported },
      { tab: 'modifiers', key: 'oneShotKeys', label: t('editor.keymap.oneShotKeysLabel'), onClick: () => openSettings('oneShotKeys'), testId: 'one-shot-keys-settings-btn', enabled: oneShotKeysSupported },
      { tab: 'behavior', key: 'magic', label: t('editor.keymap.magicLabel'), onClick: () => openSettings('magic'), testId: 'magic-settings-btn', enabled: magicSupported },
      { tab: 'behavior', key: 'autoshift', label: t('editor.keymap.autoShiftLabel'), onClick: () => openSettings('autoShift'), testId: 'auto-shift-settings-btn', enabled: autoShiftSupported },
      { tab: 'macro', key: 'macroJsonEditor', label: t('editor.tapDance.editJson'), onClick: macroJson.openGated, testId: 'macro-json-editor-btn', enabled: !!deserializedMacros && deserializedMacros.length > 0 },
      { tab: 'combo', key: 'comboJsonEditor', label: t('editor.tapDance.editJson'), onClick: comboJson.open, testId: 'combo-json-editor-btn', enabled: !!comboEntries && comboEntries.length > 0 },
      { tab: 'combo', key: 'combo', label: t('common.configuration'), onClick: () => openSettings('combo'), testId: 'combo-settings-btn', enabled: comboSettingsSupported },
      { tab: 'keyOverride', key: 'koJsonEditor', label: t('editor.tapDance.editJson'), onClick: koJson.open, testId: 'ko-json-editor-btn', enabled: !!keyOverrideEntries && keyOverrideEntries.length > 0 },
      { tab: 'altRepeatKey', key: 'arkJsonEditor', label: t('editor.tapDance.editJson'), onClick: arkJson.open, testId: 'ark-json-editor-btn', enabled: !!altRepeatKeyEntries && altRepeatKeyEntries.length > 0 },
      { tab: 'lighting', key: 'lighting', label: t('common.configuration'), onClick: onOpenLighting, testId: 'lighting-settings-btn', enabled: !!onOpenLighting },
    ]
    const content: Record<string, React.ReactNode> = {}
    const grouped = new Map<string, typeof buttonDefs>()
    for (const def of buttonDefs) { if (!def.enabled) continue; const existing = grouped.get(def.tab); if (existing) existing.push(def); else grouped.set(def.tab, [def]) }
    for (const [tab, defs] of grouped) {
      content[tab] = (
        <div className="flex items-center gap-2">
          <span className="text-xs text-content-secondary/70">{t('common.settingsLabel')}</span>
          {defs.map((d) => (<button key={d.key} type="button" className={btnClass} onClick={d.onClick} data-testid={d.testId}>{d.label}</button>))}
        </div>
      )
    }
    return content
  }, [tapDanceEntries, comboEntries, keyOverrideEntries, altRepeatKeyEntries, deserializedMacros, tapHoldSupported, mouseKeysSupported, magicSupported, autoShiftSupported, graveEscapeSupported, oneShotKeysSupported, comboSettingsSupported, onOpenLighting, t, openSettings, tdJson.open, comboJson.open, koJson.open, arkJson.open, macroJson.openGated])
}
