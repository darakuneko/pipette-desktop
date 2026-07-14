// SPDX-License-Identifier: GPL-2.0-or-later

// The keymap editor's overlay modal collection — Tap Dance / Macro edit
// modals, the five "Edit JSON" editors, and the QMK settings modal group.
// Pure props in, JSX out; each modal's own show/apply state lives in the
// hooks that own it (`useKeymapSelectionHandlers`, `useKeymapJsonEditors`).

import { useTranslation } from 'react-i18next'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../../shared/types/protocol'
import type { FavoriteType } from '../../../shared/types/favorite-store'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import type { MacroAction } from '../../../preload/macro'
import { TapDanceModal } from './TapDanceModal'
import { MacroModal } from './MacroModal'
import { TapDanceJsonEditor } from './TapDanceJsonEditor'
import { JsonEditorModal } from './JsonEditorModal'
import { comboToJson, parseCombo, keyOverrideToJson, parseKeyOverride, altRepeatKeyToJson, parseAltRepeatKey, macroToJson, parseMacro } from './json-entry-serializers'
import { QmkSettingsModals } from './QmkSettingsModal'
import type { FavHubEntryResult } from './FavoriteHubActions'
import type { EntryJsonEditor, MacroJsonEditor, VisibleQmkModals } from './useKeymapJsonEditors'

export interface KeymapEditorModalsProps {
  // --- Tap Dance modal ---
  tdModalIndex: number | null
  tapDanceEntries?: TapDanceEntry[]
  onSetTapDanceEntry?: (index: number, entry: TapDanceEntry) => Promise<void>
  handleTdModalSave: (index: number, entry: TapDanceEntry) => Promise<void>
  handleTdModalClose: () => void

  // --- Macro modal ---
  macroModalIndex: number | null
  macroBuffer?: number[]
  macroCount?: number
  macroBufferSize?: number
  vialProtocol?: number
  onSaveMacros?: (buffer: number[], parsedMacros?: MacroAction[][]) => Promise<void>
  parsedMacros?: MacroAction[][] | null
  handleMacroModalClose: () => void
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  autoAdvance?: boolean
  layers: number

  // --- Shared by Tap Dance / Macro modals ---
  isDummy?: boolean
  deserializedMacros?: MacroAction[][]
  quickSelect?: boolean
  splitKeyMode?: SplitKeyMode
  basicViewType?: BasicViewType
  favHubOrigin?: string
  favHubNeedsDisplayName?: boolean
  favHubUploading?: string | null
  favHubUploadResult?: FavHubEntryResult | null
  onFavUploadToHub?: (type: FavoriteType, entryId: string) => void
  onFavUpdateOnHub?: (type: FavoriteType, entryId: string) => void
  onFavRemoveFromHub?: (type: FavoriteType, entryId: string) => void
  onFavRenameOnHub?: (entryId: string, hubPostId: string, newLabel: string) => void

  // --- "Edit JSON" modals ---
  comboEntries?: ComboEntry[]
  keyOverrideEntries?: KeyOverrideEntry[]
  altRepeatKeyEntries?: AltRepeatKeyEntry[]
  tdJson: EntryJsonEditor<TapDanceEntry>
  comboJson: EntryJsonEditor<ComboEntry>
  koJson: EntryJsonEditor<KeyOverrideEntry>
  arkJson: EntryJsonEditor<AltRepeatKeyEntry>
  macroJson: MacroJsonEditor

  // --- QMK settings modals ---
  supportedQsids?: Set<number>
  qmkSettingsGet?: (qsid: number) => Promise<number[]>
  qmkSettingsSet?: (qsid: number, data: number[]) => Promise<void>
  qmkSettingsReset?: () => Promise<void>
  onSettingsUpdate?: (qsid: number, data: number[]) => void
  visibleModals: VisibleQmkModals
  closeSettings: (key: string) => void
}

export function KeymapEditorModals({
  tdModalIndex, tapDanceEntries, onSetTapDanceEntry, handleTdModalSave, handleTdModalClose,
  macroModalIndex, macroBuffer, macroCount, macroBufferSize, vialProtocol, onSaveMacros,
  parsedMacros, handleMacroModalClose, unlocked, onUnlock, autoAdvance, layers,
  isDummy, deserializedMacros, quickSelect, splitKeyMode, basicViewType,
  favHubOrigin, favHubNeedsDisplayName, favHubUploading, favHubUploadResult,
  onFavUploadToHub, onFavUpdateOnHub, onFavRemoveFromHub, onFavRenameOnHub,
  comboEntries, keyOverrideEntries, altRepeatKeyEntries,
  tdJson, comboJson, koJson, arkJson, macroJson,
  supportedQsids, qmkSettingsGet, qmkSettingsSet, qmkSettingsReset, onSettingsUpdate, visibleModals, closeSettings,
}: KeymapEditorModalsProps) {
  const { t } = useTranslation()

  return (
    <>
      {tdModalIndex !== null && tapDanceEntries && onSetTapDanceEntry && (
        <TapDanceModal index={tdModalIndex} entry={tapDanceEntries[tdModalIndex]}
          onSave={handleTdModalSave} onClose={handleTdModalClose} isDummy={isDummy}
          tapDanceEntries={tapDanceEntries} deserializedMacros={deserializedMacros}
          quickSelect={quickSelect} splitKeyMode={splitKeyMode} basicViewType={basicViewType}
          vialProtocol={vialProtocol ?? 0}
          hubOrigin={favHubOrigin} hubNeedsDisplayName={favHubNeedsDisplayName}
          hubUploading={favHubUploading} hubUploadResult={favHubUploadResult}
          onUploadToHub={onFavUploadToHub ? (entryId) => onFavUploadToHub('tapDance', entryId) : undefined}
          onUpdateOnHub={onFavUpdateOnHub ? (entryId) => onFavUpdateOnHub('tapDance', entryId) : undefined}
          onRemoveFromHub={onFavRemoveFromHub ? (entryId) => onFavRemoveFromHub('tapDance', entryId) : undefined}
          onRenameOnHub={onFavRenameOnHub} />
      )}

      {macroModalIndex !== null && macroBuffer && macroCount != null && onSaveMacros && (
        <MacroModal index={macroModalIndex} macroCount={macroCount} macroBufferSize={macroBufferSize ?? 0}
          macroBuffer={macroBuffer} vialProtocol={vialProtocol ?? 0} onSaveMacros={onSaveMacros}
          parsedMacros={parsedMacros} onClose={handleMacroModalClose} unlocked={unlocked} onUnlock={onUnlock}
          isDummy={isDummy} tapDanceEntries={tapDanceEntries} deserializedMacros={deserializedMacros}
          quickSelect={quickSelect} autoAdvance={autoAdvance} splitKeyMode={splitKeyMode} basicViewType={basicViewType}
          layers={layers}
          hubOrigin={favHubOrigin} hubNeedsDisplayName={favHubNeedsDisplayName}
          hubUploading={favHubUploading} hubUploadResult={favHubUploadResult}
          onUploadToHub={onFavUploadToHub ? (entryId) => onFavUploadToHub('macro', entryId) : undefined}
          onUpdateOnHub={onFavUpdateOnHub ? (entryId) => onFavUpdateOnHub('macro', entryId) : undefined}
          onRemoveFromHub={onFavRemoveFromHub ? (entryId) => onFavRemoveFromHub('macro', entryId) : undefined}
          onRenameOnHub={onFavRenameOnHub} />
      )}

      {tdJson.show && tapDanceEntries && tapDanceEntries.length > 0 && (
        <TapDanceJsonEditor
          entries={tapDanceEntries}
          onApply={tdJson.apply}
          onClose={tdJson.close}
        />
      )}

      {comboJson.show && comboEntries && comboEntries.length > 0 && (
        <JsonEditorModal<ComboEntry[]>
          title={t('editor.tapDance.editJson')}
          initialText={comboToJson(comboEntries)}
          parse={(text) => parseCombo(text, comboEntries.length, t)}
          onApply={comboJson.apply}
          onClose={comboJson.close}
          testIdPrefix="combo-json-editor"
          exportFileName="combo"
        />
      )}

      {koJson.show && keyOverrideEntries && keyOverrideEntries.length > 0 && (
        <JsonEditorModal<KeyOverrideEntry[]>
          title={t('editor.tapDance.editJson')}
          initialText={keyOverrideToJson(keyOverrideEntries)}
          parse={(text) => parseKeyOverride(text, keyOverrideEntries.length, t)}
          onApply={koJson.apply}
          onClose={koJson.close}
          testIdPrefix="ko-json-editor"
          exportFileName="ko"
        />
      )}

      {arkJson.show && altRepeatKeyEntries && altRepeatKeyEntries.length > 0 && (
        <JsonEditorModal<AltRepeatKeyEntry[]>
          title={t('editor.tapDance.editJson')}
          initialText={altRepeatKeyToJson(altRepeatKeyEntries)}
          parse={(text) => parseAltRepeatKey(text, altRepeatKeyEntries.length, t)}
          onApply={arkJson.apply}
          onClose={arkJson.close}
          testIdPrefix="ark-json-editor"
          exportFileName="ark"
        />
      )}

      {macroJson.show && deserializedMacros && deserializedMacros.length > 0 && (
        <JsonEditorModal<MacroAction[][]>
          title={t('editor.tapDance.editJson')}
          initialText={macroToJson(deserializedMacros)}
          parse={(text) => parseMacro(text, deserializedMacros.length, t)}
          onApply={macroJson.apply}
          onClose={macroJson.close}
          testIdPrefix="macro-json-editor"
          warning={t('editor.macro.unlockWarning')}
          exportFileName="macro"
        />
      )}

      {supportedQsids && qmkSettingsGet && qmkSettingsSet && qmkSettingsReset && (
        <QmkSettingsModals supportedQsids={supportedQsids} qmkSettingsGet={qmkSettingsGet}
          qmkSettingsSet={qmkSettingsSet} qmkSettingsReset={qmkSettingsReset}
          onSettingsUpdate={onSettingsUpdate} visibleModals={visibleModals} onCloseModal={closeSettings} />
      )}
    </>
  )
}
