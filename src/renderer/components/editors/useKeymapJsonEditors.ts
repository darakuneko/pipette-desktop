// SPDX-License-Identifier: GPL-2.0-or-later

// Owns the "Edit JSON" modal state for Tap Dance / Combo / Key Override /
// Alt Repeat Key / Macro, plus the QMK settings modal open/close state and
// its derived `visibleModals` map. Each JSON editor's show/apply pair is
// gated behind unlock (`useUnlockGate`) the same way the keymap itself is.

import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import { serializeAllMacros, type MacroAction } from '../../../preload/macro'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../../shared/types/protocol'

/** Extracts the raw keycodes an entry holds, for the QK_BOOT unlock check. */
type ExtractCodes<T> = (entry: T) => number[]
/** True when `next` differs from `prev` in any field the setter should push. */
type HasChanged<T> = (prev: T, next: T) => boolean

const tdExtractCodes: ExtractCodes<TapDanceEntry> = (e) => [e.onTap, e.onHold, e.onDoubleTap, e.onTapHold]
const tdHasChanged: HasChanged<TapDanceEntry> = (prev, next) =>
  prev.onTap !== next.onTap || prev.onHold !== next.onHold ||
  prev.onDoubleTap !== next.onDoubleTap || prev.onTapHold !== next.onTapHold ||
  prev.tappingTerm !== next.tappingTerm

const comboExtractCodes: ExtractCodes<ComboEntry> = (e) => [e.key1, e.key2, e.key3, e.key4, e.output]
const comboHasChanged: HasChanged<ComboEntry> = (prev, next) =>
  prev.key1 !== next.key1 || prev.key2 !== next.key2 || prev.key3 !== next.key3 ||
  prev.key4 !== next.key4 || prev.output !== next.output

const koExtractCodes: ExtractCodes<KeyOverrideEntry> = (e) => [e.triggerKey, e.replacementKey]
const koHasChanged: HasChanged<KeyOverrideEntry> = (prev, next) =>
  prev.triggerKey !== next.triggerKey || prev.replacementKey !== next.replacementKey ||
  prev.layers !== next.layers || prev.triggerMods !== next.triggerMods ||
  prev.negativeMods !== next.negativeMods || prev.suppressedMods !== next.suppressedMods ||
  prev.options !== next.options || prev.enabled !== next.enabled

const arkExtractCodes: ExtractCodes<AltRepeatKeyEntry> = (e) => [e.lastKey, e.altKey]
const arkHasChanged: HasChanged<AltRepeatKeyEntry> = (prev, next) =>
  prev.lastKey !== next.lastKey || prev.altKey !== next.altKey ||
  prev.allowedMods !== next.allowedMods || prev.options !== next.options ||
  prev.enabled !== next.enabled

interface UseEntryJsonEditorOptions<T> {
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  entries?: T[]
  onSetEntry?: (index: number, entry: T) => Promise<void>
  extractCodes: ExtractCodes<T>
  hasChanged: HasChanged<T>
}

export interface EntryJsonEditor<T> {
  show: boolean
  open: () => void
  close: () => void
  apply: (entries: T[]) => Promise<void>
}

export interface MacroJsonEditor {
  show: boolean
  /** Opening the macro editor always requires unlock (Vial protocol
   *  gates macro saves unconditionally), unlike the other four editors
   *  which only gate on apply if an entry contains QK_BOOT. */
  openGated: () => void
  close: () => void
  apply: (macros: MacroAction[][]) => Promise<void>
}

/** Shared show/apply state machine behind Tap Dance / Combo / Key Override /
 *  Alt Repeat Key's JSON editors — they differ only in entry type and which
 *  fields count as "changed", threaded in via `extractCodes` / `hasChanged`. */
function useEntryJsonEditor<T>({
  unlocked, onUnlock, entries, onSetEntry, extractCodes, hasChanged,
}: UseEntryJsonEditorOptions<T>): EntryJsonEditor<T> {
  const [show, setShow] = useState(false)
  const gate = useUnlockGate({ unlocked, onUnlock })

  const open = useCallback(() => setShow(true), [])
  const close = useCallback(() => setShow(false), [])

  const apply = useCallback(
    async (nextEntries: T[]) => {
      if (!onSetEntry || !entries) return
      const allCodes = nextEntries.flatMap(extractCodes)
      await gate.guard(allCodes, async () => {
        for (let i = 0; i < nextEntries.length; i++) {
          const prev = entries[i]
          const next = nextEntries[i]
          if (hasChanged(prev, next)) await onSetEntry(i, next)
        }
      })
    },
    [onSetEntry, entries, gate, extractCodes, hasChanged],
  )

  return { show, open, close, apply }
}

export interface UseKeymapJsonEditorsOptions {
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  tapDanceEntries?: TapDanceEntry[]
  onSetTapDanceEntry?: (index: number, entry: TapDanceEntry) => Promise<void>
  comboEntries?: ComboEntry[]
  onSetComboEntry?: (index: number, entry: ComboEntry) => Promise<void>
  keyOverrideEntries?: KeyOverrideEntry[]
  onSetKeyOverrideEntry?: (index: number, entry: KeyOverrideEntry) => Promise<void>
  altRepeatKeyEntries?: AltRepeatKeyEntry[]
  onSetAltRepeatKeyEntry?: (index: number, entry: AltRepeatKeyEntry) => Promise<void>
  onSaveMacros?: (buffer: number[], parsedMacros?: MacroAction[][]) => Promise<void>
  macroBufferSize?: number
  vialProtocol?: number
  tapHoldSupported?: boolean
  mouseKeysSupported?: boolean
  magicSupported?: boolean
  graveEscapeSupported?: boolean
  autoShiftSupported?: boolean
  oneShotKeysSupported?: boolean
  comboSettingsSupported?: boolean
}

// Type alias (not interface) so it stays assignable to the
// `Record<string, boolean>` prop QmkSettingsModals declares — object type
// aliases get an implicit index signature, interfaces do not.
export type VisibleQmkModals = {
  tapHold: boolean
  mouseKeys: boolean
  magic: boolean
  graveEscape: boolean
  autoShift: boolean
  oneShotKeys: boolean
  combo: boolean
}

export interface UseKeymapJsonEditorsReturn {
  openSettings: (key: string) => void
  closeSettings: (key: string) => void
  visibleModals: VisibleQmkModals
  tdJson: EntryJsonEditor<TapDanceEntry>
  comboJson: EntryJsonEditor<ComboEntry>
  koJson: EntryJsonEditor<KeyOverrideEntry>
  arkJson: EntryJsonEditor<AltRepeatKeyEntry>
  macroJson: MacroJsonEditor
}

export function useKeymapJsonEditors({
  unlocked, onUnlock,
  tapDanceEntries, onSetTapDanceEntry,
  comboEntries, onSetComboEntry,
  keyOverrideEntries, onSetKeyOverrideEntry,
  altRepeatKeyEntries, onSetAltRepeatKeyEntry,
  onSaveMacros, macroBufferSize, vialProtocol,
  tapHoldSupported, mouseKeysSupported, magicSupported, graveEscapeSupported,
  autoShiftSupported, oneShotKeysSupported, comboSettingsSupported,
}: UseKeymapJsonEditorsOptions): UseKeymapJsonEditorsReturn {
  const { t } = useTranslation()

  // --- QMK settings modals ---
  const [showSettings, setShowSettings] = useState<Record<string, boolean>>({})
  const openSettings = useCallback((key: string) => setShowSettings((prev) => ({ ...prev, [key]: true })), [])
  const closeSettings = useCallback((key: string) => setShowSettings((prev) => ({ ...prev, [key]: false })), [])

  const visibleModals = useMemo(() => ({
    tapHold: !!showSettings.tapHold && !!tapHoldSupported,
    mouseKeys: !!showSettings.mouseKeys && !!mouseKeysSupported,
    magic: !!showSettings.magic && !!magicSupported,
    graveEscape: !!showSettings.graveEscape && !!graveEscapeSupported,
    autoShift: !!showSettings.autoShift && !!autoShiftSupported,
    oneShotKeys: !!showSettings.oneShotKeys && !!oneShotKeysSupported,
    combo: !!showSettings.combo && !!comboSettingsSupported,
  }), [showSettings, tapHoldSupported, mouseKeysSupported, magicSupported, graveEscapeSupported, autoShiftSupported, oneShotKeysSupported, comboSettingsSupported])

  // --- Tap Dance / Combo / Key Override / Alt Repeat Key JSON editors ---
  const tdJson = useEntryJsonEditor({
    unlocked, onUnlock, entries: tapDanceEntries, onSetEntry: onSetTapDanceEntry,
    extractCodes: tdExtractCodes, hasChanged: tdHasChanged,
  })
  const comboJson = useEntryJsonEditor({
    unlocked, onUnlock, entries: comboEntries, onSetEntry: onSetComboEntry,
    extractCodes: comboExtractCodes, hasChanged: comboHasChanged,
  })
  const koJson = useEntryJsonEditor({
    unlocked, onUnlock, entries: keyOverrideEntries, onSetEntry: onSetKeyOverrideEntry,
    extractCodes: koExtractCodes, hasChanged: koHasChanged,
  })
  const arkJson = useEntryJsonEditor({
    unlocked, onUnlock, entries: altRepeatKeyEntries, onSetEntry: onSetAltRepeatKeyEntry,
    extractCodes: arkExtractCodes, hasChanged: arkHasChanged,
  })

  // --- Macro JSON editor ---
  const [showMacroJsonEditor, setShowMacroJsonEditor] = useState(false)
  const macroJsonGate = useUnlockGate({ unlocked, onUnlock })
  const openMacroJsonGated = useCallback(() => {
    void macroJsonGate.guardAll(async () => setShowMacroJsonEditor(true))
  }, [macroJsonGate])
  const closeMacroJson = useCallback(() => setShowMacroJsonEditor(false), [])
  const handleMacroJsonApply = useCallback(
    async (macros: MacroAction[][]) => {
      if (!onSaveMacros || !macroBufferSize) return
      await macroJsonGate.guardAll(async () => {
        const buffer = serializeAllMacros(macros, vialProtocol ?? 0)
        if (buffer.length > macroBufferSize) {
          throw new Error(t('editor.macro.memoryUsage', { used: buffer.length, total: macroBufferSize }))
        }
        await onSaveMacros(buffer, macros)
      })
    },
    [onSaveMacros, macroBufferSize, vialProtocol, t, macroJsonGate],
  )

  return {
    openSettings, closeSettings, visibleModals,
    tdJson, comboJson, koJson, arkJson,
    macroJson: { show: showMacroJsonEditor, openGated: openMacroJsonGated, close: closeMacroJson, apply: handleMacroJsonApply },
  }
}
