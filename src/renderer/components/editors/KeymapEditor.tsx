// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo, useRef, useImperativeHandle, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import { serialize, isMask, findKeycode } from '../../../shared/keycodes/keycodes'
import { useTileContentOverride } from '../../hooks/useTileContentOverride'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../../shared/types/protocol'
import { deserializeAllMacros, serializeAllMacros, type MacroAction } from '../../../preload/macro'
import { TapDanceModal } from './TapDanceModal'
import { MacroModal } from './MacroModal'
import { TapDanceJsonEditor } from './TapDanceJsonEditor'
import { JsonEditorModal } from './JsonEditorModal'
import { comboToJson, parseCombo, keyOverrideToJson, parseKeyOverride, altRepeatKeyToJson, parseAltRepeatKey, macroToJson, parseMacro } from './json-entry-serializers'
import { KeycodesOverlayPanel } from './KeycodesOverlayPanel'
import { ZoomIn, ZoomOut, SlidersHorizontal } from 'lucide-react'

// Extracted modules
import type { KeymapEditorProps as Props, PopoverState } from './keymap-editor-types'
import { MIN_SCALE, MAX_SCALE, PANEL_COLLAPSED_WIDTH, EMPTY_KEYCODES, EMPTY_REMAPPED, EMPTY_ENCODER_KEYCODES } from './keymap-editor-types'
export type { KeymapEditorHandle } from './keymap-editor-types'
import { KeyboardPane } from './KeyboardPane'
import { LayerListPanel } from './LayerListPanel'
import { IconTooltip, ScaleInput, toggleButtonClass } from './keymap-editor-toolbar'
import { QmkSettingsModals } from './QmkSettingsModal'
import { useInputModes } from './useInputModes'
import { useKeymapMultiSelect } from './useKeymapMultiSelect'
import { useLayoutOptionsPanel } from './useLayoutOptionsPanel'
import { useKeymapSelectionHandlers } from './useKeymapSelectionHandlers'
import { TypingTestPane } from './TypingTestPane'


interface PopoverForStateProps {
  popoverState: NonNullable<PopoverState>
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  currentLayer: number
  layers: number
  onKeycodeSelect: (kc: Keycode) => void
  onRawKeycodeSelect: (code: number) => void
  onModMaskChange?: (newMask: number) => void
  onClose: () => void
  quickSelect?: boolean
  previousKeycode?: number
  onUndo?: () => void
}

function PopoverForState({
  popoverState, keymap, encoderLayout, currentLayer, layers,
  onKeycodeSelect, onRawKeycodeSelect, onModMaskChange, onClose,
  quickSelect, previousKeycode, onUndo,
}: PopoverForStateProps) {
  const currentKeycode = popoverState.kind === 'key'
    ? keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
    : encoderLayout.get(`${currentLayer},${popoverState.idx},${popoverState.dir}`) ?? 0
  const maskOnly = popoverState.kind === 'key' && popoverState.maskClicked && isMask(serialize(currentKeycode))
  return (
    <KeyPopover
      anchorRect={popoverState.anchorRect} currentKeycode={currentKeycode} maskOnly={maskOnly} layers={layers}
      onKeycodeSelect={onKeycodeSelect} onRawKeycodeSelect={onRawKeycodeSelect} onModMaskChange={onModMaskChange}
      onClose={onClose} quickSelect={quickSelect} previousKeycode={previousKeycode} onUndo={onUndo}
    />
  )
}

export const KeymapEditor = forwardRef<import('./keymap-editor-types').KeymapEditorHandle, Props>(function KeymapEditor({
  layout, layers, currentLayer, onLayerChange, keymap, encoderLayout, encoderCount,
  layoutOptions, layoutLabels, packedLayoutOptions, onSetLayoutOptions,
  remapLabel, isRemapped, onSetKey, onSetKeysBulk, onSetEncoder,
  rows, cols, getMatrixState, unlocked, onUnlock,
  tapDanceEntries, onSetTapDanceEntry,
  macroCount, macroBufferSize, macroBuffer, vialProtocol, parsedMacros, onSaveMacros,
  tapHoldSupported, mouseKeysSupported, magicSupported, graveEscapeSupported,
  autoShiftSupported, oneShotKeysSupported, comboSettingsSupported,
  supportedQsids, qmkSettingsGet, qmkSettingsSet, qmkSettingsReset, onSettingsUpdate,
  autoAdvance = true, onAutoAdvanceChange,
  basicViewType, onBasicViewTypeChange, splitKeyMode, onSplitKeyModeChange,
  quickSelect, onQuickSelectChange, keyboardLayout = 'qwerty', onKeyboardLayoutChange,
  onLock, onMatrixModeChange, onOpenLighting,
  comboEntries, onOpenCombo, onSetComboEntry,
  keyOverrideEntries, onOpenKeyOverride, onSetKeyOverrideEntry,
  altRepeatKeyEntries, onOpenAltRepeatKey, onSetAltRepeatKeyEntry,
  toolsExtra, dataPanel, onOverlayOpen,
  layerNames, onSetLayerName,
  layerPanelOpen: layerPanelOpenProp, onLayerPanelOpenChange,
  scale: scaleProp = 1, onScaleChange,
  splitEdit, onSplitEditChange: _onSplitEditChange, activePane = 'primary', onActivePaneChange,
  primaryLayer: primaryLayerProp, secondaryLayer: secondaryLayerProp,
  typingTestMode, onTypingTestModeChange, onSaveTypingTestResult, typingTestHistory,
  typingTestConfig: savedTypingTestConfig, typingTestLanguage: savedTypingTestLanguage,
  onTypingTestConfigChange, onTypingTestLanguageChange,
  deviceName, isDummy, onExportLayoutPdfAll, onExportLayoutPdfCurrent,
  favHubOrigin, favHubNeedsDisplayName, favHubUploading, favHubUploadResult,
  onFavUploadToHub, onFavUpdateOnHub, onFavRemoveFromHub, onFavRenameOnHub,
}, ref) {
  const { t } = useTranslation()
  const keyboardContentRef = useRef<HTMLDivElement>(null)
  const [pickerLayer, setPickerLayer] = useState(0)

  // --- Input modes (matrix tester + typing test) ---
  const {
    matrixMode, pressedKeys, everPressedKeys, hasMatrixTester,
    handleMatrixToggle, handleTypingTestToggle,
    typingTest, handleTypingTestConfigChange, handleTypingTestLanguageChange,
  } = useInputModes({
    rows, cols, getMatrixState, unlocked, onUnlock, onMatrixModeChange, keymap,
    typingTestMode, onTypingTestModeChange, savedTypingTestConfig, savedTypingTestLanguage,
    onTypingTestConfigChange, onTypingTestLanguageChange, onSaveTypingTestResult, typingTestHistory,
  })

  // --- Layout options ---
  const {
    parsedOptions, hasLayoutOptions, layoutValues, effectiveLayoutOptions,
    handleLayoutOptionChange, keyboardAreaMinHeight, selectableKeys,
    layoutPanelOpen, setLayoutPanelOpen, layoutPanelRef, layoutButtonRef,
  } = useLayoutOptionsPanel({ layout, layoutLabels, packedLayoutOptions, onSetLayoutOptions, layoutOptions, scale: scaleProp })

  // --- Multi-selection ---
  const hasActiveSingleSelectionRef = useRef(false)
  const multiSelect = useKeymapMultiSelect({ hasActiveSingleSelectionRef })

  // --- Split edit layer resolution ---
  const effectivePrimaryLayer = primaryLayerProp ?? currentLayer
  const effectiveSecondaryLayer = secondaryLayerProp ?? currentLayer
  const inactivePaneLayer = splitEdit
    ? (activePane === 'primary' ? effectiveSecondaryLayer : effectivePrimaryLayer)
    : undefined

  // --- Selection + handlers ---
  const {
    selectedKey, selectedEncoder, selectedMaskPart, popoverState, setPopoverState,
    selectedKeycode, isMaskKey, isLMMask,
    handleKeyClick, handleEncoderClick, handleKeyDoubleClick, handleEncoderDoubleClick,
    handleKeycodeSelect, handlePopoverKeycodeSelect, handlePopoverRawKeycodeSelect,
    handlePopoverModMaskChange, popoverUndoKeycode, handlePopoverUndo,
    handleDeselect, handleDeselectClick,
    isCopying, copyLayerPending, handleCopyLayerClick,
    tdModalIndex, macroModalIndex, handleTdModalSave, handleTdModalClose, handleMacroModalClose,
  } = useKeymapSelectionHandlers({
    layout, keymap, encoderLayout, encoderCount, currentLayer,
    splitEdit, activePane, effectivePrimaryLayer, effectiveSecondaryLayer,
    inactivePaneLayer, selectableKeys, autoAdvance,
    onSetKey, onSetKeysBulk, onSetEncoder, unlocked, onUnlock,
    multiSelect,
    tapDanceEntries, onSetTapDanceEntry,
    macroCount, macroBufferSize, macroBuffer, onSaveMacros,
  })

  hasActiveSingleSelectionRef.current = !!(selectedKey || selectedEncoder)
  const { multiSelectedKeys, selectionSourcePane, pickerSelectedSet, handlePickerMultiSelect } = multiSelect

  // --- QMK settings modals ---
  const [showSettings, setShowSettings] = useState<Record<string, boolean>>({})
  const openSettings = useCallback((key: string) => setShowSettings((prev) => ({ ...prev, [key]: true })), [])
  const closeSettings = useCallback((key: string) => setShowSettings((prev) => ({ ...prev, [key]: false })), [])

  // --- Tap Dance JSON editor ---
  const [showTdJsonEditor, setShowTdJsonEditor] = useState(false)
  const tdJsonGate = useUnlockGate({ unlocked, onUnlock })
  const handleTdJsonApply = useCallback(
    async (entries: TapDanceEntry[]) => {
      if (!onSetTapDanceEntry || !tapDanceEntries) return
      const allCodes = entries.flatMap((e) => [e.onTap, e.onHold, e.onDoubleTap, e.onTapHold])
      await tdJsonGate.guard(allCodes, async () => {
        for (let i = 0; i < entries.length; i++) {
          const prev = tapDanceEntries[i]
          const next = entries[i]
          if (prev.onTap !== next.onTap || prev.onHold !== next.onHold ||
              prev.onDoubleTap !== next.onDoubleTap || prev.onTapHold !== next.onTapHold ||
              prev.tappingTerm !== next.tappingTerm) {
            await onSetTapDanceEntry(i, next)
          }
        }
      })
    },
    [onSetTapDanceEntry, tapDanceEntries, tdJsonGate],
  )

  // --- Combo JSON editor ---
  const [showComboJsonEditor, setShowComboJsonEditor] = useState(false)
  const comboJsonGate = useUnlockGate({ unlocked, onUnlock })
  const handleComboJsonApply = useCallback(
    async (entries: ComboEntry[]) => {
      if (!onSetComboEntry || !comboEntries) return
      const allCodes = entries.flatMap((e) => [e.key1, e.key2, e.key3, e.key4, e.output])
      await comboJsonGate.guard(allCodes, async () => {
        for (let i = 0; i < entries.length; i++) {
          const prev = comboEntries[i]
          const next = entries[i]
          if (prev.key1 !== next.key1 || prev.key2 !== next.key2 || prev.key3 !== next.key3 ||
              prev.key4 !== next.key4 || prev.output !== next.output) {
            await onSetComboEntry(i, next)
          }
        }
      })
    },
    [onSetComboEntry, comboEntries, comboJsonGate],
  )

  // --- Key Override JSON editor ---
  const [showKoJsonEditor, setShowKoJsonEditor] = useState(false)
  const koJsonGate = useUnlockGate({ unlocked, onUnlock })
  const handleKoJsonApply = useCallback(
    async (entries: KeyOverrideEntry[]) => {
      if (!onSetKeyOverrideEntry || !keyOverrideEntries) return
      const allCodes = entries.flatMap((e) => [e.triggerKey, e.replacementKey])
      await koJsonGate.guard(allCodes, async () => {
        for (let i = 0; i < entries.length; i++) {
          const prev = keyOverrideEntries[i]
          const next = entries[i]
          if (prev.triggerKey !== next.triggerKey || prev.replacementKey !== next.replacementKey ||
              prev.layers !== next.layers || prev.triggerMods !== next.triggerMods ||
              prev.negativeMods !== next.negativeMods || prev.suppressedMods !== next.suppressedMods ||
              prev.options !== next.options || prev.enabled !== next.enabled) {
            await onSetKeyOverrideEntry(i, next)
          }
        }
      })
    },
    [onSetKeyOverrideEntry, keyOverrideEntries, koJsonGate],
  )

  // --- Alt Repeat Key JSON editor ---
  const [showArkJsonEditor, setShowArkJsonEditor] = useState(false)
  const arkJsonGate = useUnlockGate({ unlocked, onUnlock })
  const handleArkJsonApply = useCallback(
    async (entries: AltRepeatKeyEntry[]) => {
      if (!onSetAltRepeatKeyEntry || !altRepeatKeyEntries) return
      const allCodes = entries.flatMap((e) => [e.lastKey, e.altKey])
      await arkJsonGate.guard(allCodes, async () => {
        for (let i = 0; i < entries.length; i++) {
          const prev = altRepeatKeyEntries[i]
          const next = entries[i]
          if (prev.lastKey !== next.lastKey || prev.altKey !== next.altKey ||
              prev.allowedMods !== next.allowedMods || prev.options !== next.options ||
              prev.enabled !== next.enabled) {
            await onSetAltRepeatKeyEntry(i, next)
          }
        }
      })
    },
    [onSetAltRepeatKeyEntry, altRepeatKeyEntries, arkJsonGate],
  )

  // --- Macro JSON editor ---
  const [showMacroJsonEditor, setShowMacroJsonEditor] = useState(false)
  const macroJsonGate = useUnlockGate({ unlocked, onUnlock })
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

  const visibleModals = useMemo(() => ({
    tapHold: !!showSettings.tapHold && !!tapHoldSupported,
    mouseKeys: !!showSettings.mouseKeys && !!mouseKeysSupported,
    magic: !!showSettings.magic && !!magicSupported,
    graveEscape: !!showSettings.graveEscape && !!graveEscapeSupported,
    autoShift: !!showSettings.autoShift && !!autoShiftSupported,
    oneShotKeys: !!showSettings.oneShotKeys && !!oneShotKeysSupported,
    combo: !!showSettings.combo && !!comboSettingsSupported,
  }), [showSettings, tapHoldSupported, mouseKeysSupported, magicSupported, graveEscapeSupported, autoShiftSupported, oneShotKeysSupported, comboSettingsSupported])

  // --- Layer panel ---
  const layerPanelCollapsed = layerPanelOpenProp === false
  const toggleLayerPanel = useCallback(() => { onLayerPanelOpenChange?.(!layerPanelOpenProp) }, [onLayerPanelOpenChange, layerPanelOpenProp])

  // --- Macros ---
  const deserializedMacros = useMemo(
    () => parsedMacros ?? (macroBuffer && macroCount ? deserializeAllMacros(macroBuffer, vialProtocol ?? 0, macroCount) : undefined),
    [parsedMacros, macroBuffer, macroCount, vialProtocol],
  )

  const configuredKeycodes = useMemo(() => {
    const set = new Set<string>()
    if (tapDanceEntries) {
      for (let i = 0; i < tapDanceEntries.length; i++) {
        const e = tapDanceEntries[i]
        if (e.onTap || e.onHold || e.onDoubleTap || e.onTapHold) set.add(`TD(${i})`)
      }
    }
    if (deserializedMacros) {
      for (let i = 0; i < deserializedMacros.length; i++) {
        if (deserializedMacros[i].length > 0) set.add(`M${i}`)
      }
    }
    return set.size > 0 ? set : undefined
  }, [tapDanceEntries, deserializedMacros])

  const remap = remapLabel ?? ((id: string) => id)

  useImperativeHandle(ref, () => ({
    toggleMatrix: handleMatrixToggle, toggleTypingTest: handleTypingTestToggle,
    matrixMode, hasMatrixTester,
  }), [handleMatrixToggle, handleTypingTestToggle, matrixMode, hasMatrixTester])

  // --- Build keycodes for layers ---
  const buildKeycodesForLayer = useCallback((layer: number) => {
    const keycodes = new Map<string, string>()
    const remapped = new Set<string>()
    const checkRemapped = isRemapped ?? (() => false)
    for (const [key, code] of keymap) {
      const [l, r, c] = key.split(',')
      if (Number(l) === layer) {
        const posKey = `${r},${c}`
        const qmkId = serialize(code)
        keycodes.set(posKey, remap(qmkId))
        if (!isMask(qmkId) && checkRemapped(qmkId)) remapped.add(posKey)
      }
    }
    return { keycodes, remapped }
  }, [keymap, remap, isRemapped])

  const buildEncoderKeycodesForLayer = useCallback((layer: number) => {
    const map = new Map<string, [string, string]>()
    for (let i = 0; i < encoderCount; i++) {
      const cw = encoderLayout.get(`${layer},${i},0`) ?? 0
      const ccw = encoderLayout.get(`${layer},${i},1`) ?? 0
      map.set(String(i), [remap(serialize(cw)), remap(serialize(ccw))])
    }
    return map
  }, [encoderLayout, encoderCount, remap])

  const { keycodes: layerKeycodes, remapped: remappedKeys } = useMemo(() => buildKeycodesForLayer(currentLayer), [buildKeycodesForLayer, currentLayer])
  const layerEncoderKeycodes = useMemo(() => buildEncoderKeycodesForLayer(currentLayer), [buildEncoderKeycodesForLayer, currentLayer])

  const { keycodes: inactiveLayerKeycodes, remapped: inactiveRemappedKeys } = useMemo(
    () => inactivePaneLayer != null ? buildKeycodesForLayer(inactivePaneLayer) : { keycodes: EMPTY_KEYCODES, remapped: EMPTY_REMAPPED },
    [buildKeycodesForLayer, inactivePaneLayer])
  const inactiveEncoderKeycodes = useMemo(
    () => inactivePaneLayer != null ? buildEncoderKeycodesForLayer(inactivePaneLayer) : EMPTY_ENCODER_KEYCODES,
    [buildEncoderKeycodesForLayer, inactivePaneLayer])

  const { keycodes: typingTestKeycodes, remapped: typingTestRemapped } = useMemo(
    () => typingTestMode ? buildKeycodesForLayer(typingTest.effectiveLayer) : { keycodes: EMPTY_KEYCODES, remapped: EMPTY_REMAPPED },
    [buildKeycodesForLayer, typingTest.effectiveLayer, typingTestMode])
  const typingTestEncoderKeycodes = useMemo(
    () => typingTestMode ? buildEncoderKeycodesForLayer(typingTest.effectiveLayer) : EMPTY_ENCODER_KEYCODES,
    [buildEncoderKeycodesForLayer, typingTest.effectiveLayer, typingTestMode])

  // --- Layout picker keycodes ---
  const { keycodes: pickerKeycodes, remapped: pickerRemapped } = useMemo(
    () => buildKeycodesForLayer(pickerLayer), [buildKeycodesForLayer, pickerLayer])
  const pickerEncoderKeycodes = useMemo(
    () => buildEncoderKeycodesForLayer(pickerLayer), [buildEncoderKeycodesForLayer, pickerLayer])

  const handlePickerKeyClick = useCallback((key: import('../../../shared/kle/types').KleKey) => {
    const code = keymap.get(`${pickerLayer},${key.row},${key.col}`)
    if (code == null) return
    const kc = findKeycode(serialize(code))
    if (kc) handleKeycodeSelect(kc)
  }, [keymap, pickerLayer, handleKeycodeSelect])

  // --- Tab footer ---
  const tabFooterContent = useMemo(() => {
    const btnClass = 'rounded border border-edge px-3 py-1 text-xs text-content-secondary hover:text-content hover:bg-surface-dim'
    const buttonDefs = [
      { tab: 'tapDance', key: 'tdJsonEditor', label: t('editor.tapDance.editJson'), onClick: () => setShowTdJsonEditor(true), testId: 'tap-dance-json-editor-btn', enabled: !!tapDanceEntries && tapDanceEntries.length > 0 },
      { tab: 'tapDance', key: 'tapHold', label: t('editor.keymap.tapHoldLabel'), onClick: () => openSettings('tapHold'), testId: 'tap-hold-settings-btn', enabled: tapHoldSupported },
      { tab: 'system', key: 'mouseKeys', label: t('editor.keymap.mouseKeysLabel'), onClick: () => openSettings('mouseKeys'), testId: 'mouse-keys-settings-btn', enabled: mouseKeysSupported },
      { tab: 'modifiers', key: 'graveEscape', label: t('editor.keymap.graveEscapeLabel'), onClick: () => openSettings('graveEscape'), testId: 'grave-escape-settings-btn', enabled: graveEscapeSupported },
      { tab: 'modifiers', key: 'oneShotKeys', label: t('editor.keymap.oneShotKeysLabel'), onClick: () => openSettings('oneShotKeys'), testId: 'one-shot-keys-settings-btn', enabled: oneShotKeysSupported },
      { tab: 'behavior', key: 'magic', label: t('editor.keymap.magicLabel'), onClick: () => openSettings('magic'), testId: 'magic-settings-btn', enabled: magicSupported },
      { tab: 'behavior', key: 'autoshift', label: t('editor.keymap.autoShiftLabel'), onClick: () => openSettings('autoShift'), testId: 'auto-shift-settings-btn', enabled: autoShiftSupported },
      { tab: 'macro', key: 'macroJsonEditor', label: t('editor.tapDance.editJson'), onClick: () => void macroJsonGate.guardAll(async () => setShowMacroJsonEditor(true)), testId: 'macro-json-editor-btn', enabled: !!deserializedMacros && deserializedMacros.length > 0 },
      { tab: 'combo', key: 'comboJsonEditor', label: t('editor.tapDance.editJson'), onClick: () => setShowComboJsonEditor(true), testId: 'combo-json-editor-btn', enabled: !!comboEntries && comboEntries.length > 0 },
      { tab: 'combo', key: 'combo', label: t('common.configuration'), onClick: () => openSettings('combo'), testId: 'combo-settings-btn', enabled: comboSettingsSupported },
      { tab: 'keyOverride', key: 'koJsonEditor', label: t('editor.tapDance.editJson'), onClick: () => setShowKoJsonEditor(true), testId: 'ko-json-editor-btn', enabled: !!keyOverrideEntries && keyOverrideEntries.length > 0 },
      { tab: 'altRepeatKey', key: 'arkJsonEditor', label: t('editor.tapDance.editJson'), onClick: () => setShowArkJsonEditor(true), testId: 'ark-json-editor-btn', enabled: !!altRepeatKeyEntries && altRepeatKeyEntries.length > 0 },
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
  }, [tapDanceEntries, comboEntries, keyOverrideEntries, altRepeatKeyEntries, deserializedMacros, tapHoldSupported, mouseKeysSupported, magicSupported, autoShiftSupported, graveEscapeSupported, oneShotKeysSupported, comboSettingsSupported, onOpenLighting, t, openSettings])

  const tabContentOverride = useTileContentOverride(tapDanceEntries, deserializedMacros, handleKeycodeSelect, {
    comboEntries, onOpenCombo, keyOverrideEntries, onOpenKeyOverride, altRepeatKeyEntries, onOpenAltRepeatKey,
  })

  if (!layout) return <div className="p-4 text-content-muted">{t('common.loading')}</div>

  function layerLabel(layer: number): string {
    return layerNames?.[layer] || t('editor.keymap.layerN', { n: layer })
  }

  // --- Pane data mapping ---
  const primaryIsCurrent = !splitEdit || activePane === 'primary'
  const primaryKeycodes = primaryIsCurrent ? layerKeycodes : inactiveLayerKeycodes
  const primaryEncoderKeycodes = primaryIsCurrent ? layerEncoderKeycodes : inactiveEncoderKeycodes
  const primaryRemapped = primaryIsCurrent ? remappedKeys : inactiveRemappedKeys
  const secondaryKeycodes = primaryIsCurrent ? inactiveLayerKeycodes : layerKeycodes
  const secondaryEncoderKeycodes = primaryIsCurrent ? inactiveEncoderKeycodes : layerEncoderKeycodes
  const secondaryRemapped = primaryIsCurrent ? inactiveRemappedKeys : remappedKeys

  const canCopy = !!splitEdit && effectivePrimaryLayer !== effectiveSecondaryLayer
  const panePasteReady = canCopy && selectionSourcePane != null && selectionSourcePane !== activePane && multiSelectedKeys.size > 0
  const showCopyLayer = canCopy && !panePasteReady
  const copyLayerConfirmText = inactivePaneLayer != null
    ? t('editor.keymap.copyLayerConfirm', { source: layerLabel(currentLayer), target: layerLabel(inactivePaneLayer) })
    : undefined

  // Layout picker: keyboard-as-keycode-picker shown inside the picker panel
  const layoutPickerContent = (
    <div className="flex min-h-0 flex-1 flex-col" onClick={(e) => e.stopPropagation()}>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
        <KeyboardPane
          paneId="secondary" isActive={true} isSplitEdit={false}
          keys={layout.keys} keycodes={pickerKeycodes} encoderKeycodes={pickerEncoderKeycodes}
          selectedKey={null} selectedEncoder={null} selectedMaskPart={false} selectedKeycode={null}
          remappedKeys={pickerRemapped}
          layoutOptions={effectiveLayoutOptions} scale={scaleProp}
          layerLabel={layerLabel(pickerLayer)} layerLabelTestId="picker-layer-label"
          onKeyClick={handlePickerKeyClick}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1 self-end px-2 pb-1">
        {Array.from({ length: layers }, (_, i) => (
          <button key={i} type="button"
            className={`w-7 rounded-md border py-1 text-center text-[12px] font-semibold tabular-nums transition-colors ${
              pickerLayer === i
                ? 'border-accent bg-accent text-content-inverse'
                : 'border-edge bg-surface/20 text-content-muted hover:bg-surface-dim'
            }`}
            onClick={() => setPickerLayer(i)}
          >
            {layerNames?.[i] || i}
          </button>
        ))}
      </div>
    </div>
  )

  const zoomButtonClass = `${toggleButtonClass(false)} disabled:opacity-30 disabled:pointer-events-none`

  const toolbar = (
    <div className="flex shrink-0 flex-col items-center gap-3 self-stretch" style={{ width: PANEL_COLLAPSED_WIDTH }}>
      <div className="flex-1" />
      {!typingTestMode && onScaleChange && (
        <>
          <IconTooltip label={t('editor.keymap.zoomIn')}>
            <button type="button" data-testid="zoom-in-button" aria-label={t('editor.keymap.zoomIn')} className={zoomButtonClass} disabled={scaleProp >= MAX_SCALE} onClick={() => onScaleChange(0.1)}>
              <ZoomIn size={16} aria-hidden="true" />
            </button>
          </IconTooltip>
          <ScaleInput scale={scaleProp} onScaleChange={onScaleChange} />
          <IconTooltip label={t('editor.keymap.zoomOut')}>
            <button type="button" data-testid="zoom-out-button" aria-label={t('editor.keymap.zoomOut')} className={zoomButtonClass} disabled={scaleProp <= MIN_SCALE} onClick={() => onScaleChange(-0.1)}>
              <ZoomOut size={16} aria-hidden="true" />
            </button>
          </IconTooltip>
        </>
      )}
      <div className="flex-1" />
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        className="flex items-start gap-2 overflow-auto"
        style={!typingTestMode && keyboardAreaMinHeight ? { minHeight: keyboardAreaMinHeight } : undefined}
        onClick={!typingTestMode ? handleDeselectClick : undefined}
      >
        {toolbar}
        <div className={typingTestMode ? 'flex min-w-0 flex-1 flex-col gap-3' : 'flex min-w-0 flex-1 items-center justify-center gap-4 overflow-auto'}>
          {typingTestMode ? (
            <TypingTestPane
              typingTest={typingTest}
              onConfigChange={handleTypingTestConfigChange}
              onLanguageChange={handleTypingTestLanguageChange}
              layers={layers}
              layerNames={layerNames}
              typingTestHistory={typingTestHistory}
              deviceName={deviceName}
              pressedKeys={pressedKeys}
              keycodes={typingTestKeycodes}
              encoderKeycodes={typingTestEncoderKeycodes}
              remappedKeys={typingTestRemapped}
              layoutOptions={effectiveLayoutOptions}
              scale={scaleProp}
              keys={layout.keys}
              layerLabel={layerLabel(typingTest.effectiveLayer)}
              contentRef={keyboardContentRef}
            />
          ) : (
            <>
              <KeyboardPane
                paneId="primary" isActive={activePane === 'primary'} isSplitEdit={splitEdit ?? false}
                keys={layout.keys} keycodes={primaryKeycodes} encoderKeycodes={primaryEncoderKeycodes}
                selectedKey={selectedKey} selectedEncoder={selectedEncoder} selectedMaskPart={selectedMaskPart} selectedKeycode={selectedKeycode}
                pressedKeys={matrixMode ? pressedKeys : undefined} everPressedKeys={matrixMode ? everPressedKeys : undefined}
                remappedKeys={primaryRemapped} multiSelectedKeys={selectionSourcePane === 'primary' ? multiSelectedKeys : undefined}
                layoutOptions={effectiveLayoutOptions} scale={scaleProp}
                layerLabel={layerLabel(effectivePrimaryLayer)} layerLabelTestId="layer-label"
                onKeyClick={handleKeyClick} onKeyDoubleClick={handleKeyDoubleClick}
                onEncoderClick={handleEncoderClick} onEncoderDoubleClick={handleEncoderDoubleClick}
                onCopyLayer={showCopyLayer && activePane === 'primary' ? handleCopyLayerClick : undefined}
                copyLayerPending={activePane === 'primary' && splitEdit && copyLayerPending ? copyLayerConfirmText : undefined}
                isCopying={isCopying} onDeselect={handleDeselect}
                onActivate={() => onActivePaneChange?.('primary')} contentRef={keyboardContentRef}
              />
              {splitEdit && (
                <KeyboardPane
                  paneId="secondary" isActive={activePane === 'secondary'} isSplitEdit={true}
                  keys={layout.keys} keycodes={secondaryKeycodes} encoderKeycodes={secondaryEncoderKeycodes}
                  selectedKey={selectedKey} selectedEncoder={selectedEncoder} selectedMaskPart={selectedMaskPart} selectedKeycode={selectedKeycode}
                  pressedKeys={matrixMode ? pressedKeys : undefined} everPressedKeys={matrixMode ? everPressedKeys : undefined}
                  remappedKeys={secondaryRemapped} multiSelectedKeys={selectionSourcePane === 'secondary' ? multiSelectedKeys : undefined}
                  layoutOptions={effectiveLayoutOptions} scale={scaleProp}
                  layerLabel={layerLabel(effectiveSecondaryLayer)} layerLabelTestId="secondary-layer-label"
                  onKeyClick={handleKeyClick} onKeyDoubleClick={handleKeyDoubleClick}
                  onEncoderClick={handleEncoderClick} onEncoderDoubleClick={handleEncoderDoubleClick}
                  onCopyLayer={showCopyLayer && activePane === 'secondary' ? handleCopyLayerClick : undefined}
                  copyLayerPending={activePane === 'secondary' && splitEdit && copyLayerPending ? copyLayerConfirmText : undefined}
                  isCopying={isCopying} onDeselect={handleDeselect}
                  onActivate={() => onActivePaneChange?.('secondary')}
                />
              )}
            </>
          )}
        </div>
        {!splitEdit && !typingTestMode && <div style={{ width: PANEL_COLLAPSED_WIDTH }} className="shrink-0" />}
      </div>

      {!typingTestMode && popoverState && (
        <PopoverForState
          popoverState={popoverState} keymap={keymap} encoderLayout={encoderLayout}
          currentLayer={currentLayer} layers={layers}
          onKeycodeSelect={handlePopoverKeycodeSelect} onRawKeycodeSelect={handlePopoverRawKeycodeSelect}
          onModMaskChange={popoverState.kind === 'key' ? handlePopoverModMaskChange : undefined}
          onClose={() => setPopoverState(null)} quickSelect={quickSelect}
          previousKeycode={popoverUndoKeycode} onUndo={handlePopoverUndo}
        />
      )}

      {!typingTestMode && (
        <div className="flex min-h-0 flex-1 gap-2">
          {onLayerChange && layers > 1 && (
            <LayerListPanel layers={layers} currentLayer={currentLayer} onLayerChange={onLayerChange}
              layerNames={layerNames} onSetLayerName={onSetLayerName} collapsed={layerPanelCollapsed} onToggleCollapse={toggleLayerPanel} />
          )}
          <TabbedKeycodes
            keyboardPickerContent={layoutPickerContent}
            onKeycodeSelect={handleKeycodeSelect} onKeycodeMultiSelect={handlePickerMultiSelect}
            pickerSelectedKeycodes={pickerSelectedSet} onBackgroundClick={handleDeselect}
            highlightedKeycodes={configuredKeycodes} maskOnly={isMaskKey} lmMode={isLMMask} showHint={!isMaskKey}
            tabFooterContent={tabFooterContent} tabContentOverride={tabContentOverride}
            basicViewType={basicViewType} splitKeyMode={splitKeyMode} remapLabel={remapLabel}
            tabBarRight={
              <button ref={layoutButtonRef} type="button" aria-label={t('editorSettings.title')}
                aria-expanded={layoutPanelOpen} aria-controls="keycodes-overlay-panel"
                className={`rounded p-1 transition-colors ${layoutPanelOpen ? 'bg-surface-dim text-accent' : 'text-content-secondary hover:bg-surface-dim hover:text-content'}`}
                onClick={() => { setLayoutPanelOpen((prev) => { if (!prev) onOverlayOpen?.(); return !prev }) }}
              >
                <SlidersHorizontal size={16} aria-hidden="true" />
              </button>
            }
            panelOverlay={
              <div id="keycodes-overlay-panel" ref={layoutPanelRef}
                className={`absolute inset-y-0 right-0 z-10 w-fit min-w-[320px] rounded-l-lg rounded-r-[10px] border-l border-edge-subtle bg-surface-alt shadow-lg transition-transform duration-200 ease-out ${layoutPanelOpen ? 'translate-x-0' : 'translate-x-full'}`}
                inert={!layoutPanelOpen || undefined}
              >
                <KeycodesOverlayPanel
                  hasLayoutOptions={hasLayoutOptions} layoutOptions={parsedOptions} layoutValues={layoutValues}
                  onLayoutOptionChange={handleLayoutOptionChange} keyboardLayout={keyboardLayout}
                  onKeyboardLayoutChange={onKeyboardLayoutChange} autoAdvance={autoAdvance} onAutoAdvanceChange={onAutoAdvanceChange}
                  basicViewType={basicViewType} onBasicViewTypeChange={onBasicViewTypeChange}
                  splitKeyMode={splitKeyMode} onSplitKeyModeChange={onSplitKeyModeChange}
                  quickSelect={quickSelect} onQuickSelectChange={onQuickSelectChange}
                  matrixMode={matrixMode} hasMatrixTester={hasMatrixTester} onToggleMatrix={handleMatrixToggle}
                  unlocked={unlocked ?? false} onLock={onLock} isDummy={isDummy}
                  toolsExtra={toolsExtra} dataPanel={dataPanel}
                  onExportLayoutPdfAll={onExportLayoutPdfAll} onExportLayoutPdfCurrent={onExportLayoutPdfCurrent}
                />
              </div>
            }
          />
        </div>
      )}

      {tdModalIndex !== null && tapDanceEntries && onSetTapDanceEntry && (
        <TapDanceModal index={tdModalIndex} entry={tapDanceEntries[tdModalIndex]}
          onSave={handleTdModalSave} onClose={handleTdModalClose} isDummy={isDummy}
          tapDanceEntries={tapDanceEntries} deserializedMacros={deserializedMacros}
          quickSelect={quickSelect} splitKeyMode={splitKeyMode} basicViewType={basicViewType}
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
          quickSelect={quickSelect} splitKeyMode={splitKeyMode} basicViewType={basicViewType}
          hubOrigin={favHubOrigin} hubNeedsDisplayName={favHubNeedsDisplayName}
          hubUploading={favHubUploading} hubUploadResult={favHubUploadResult}
          onUploadToHub={onFavUploadToHub ? (entryId) => onFavUploadToHub('macro', entryId) : undefined}
          onUpdateOnHub={onFavUpdateOnHub ? (entryId) => onFavUpdateOnHub('macro', entryId) : undefined}
          onRemoveFromHub={onFavRemoveFromHub ? (entryId) => onFavRemoveFromHub('macro', entryId) : undefined}
          onRenameOnHub={onFavRenameOnHub} />
      )}

      {showTdJsonEditor && tapDanceEntries && tapDanceEntries.length > 0 && (
        <TapDanceJsonEditor
          entries={tapDanceEntries}
          onApply={handleTdJsonApply}
          onClose={() => setShowTdJsonEditor(false)}
        />
      )}

      {showComboJsonEditor && comboEntries && comboEntries.length > 0 && (
        <JsonEditorModal<ComboEntry[]>
          title={t('editor.tapDance.editJson')}
          initialText={comboToJson(comboEntries)}
          parse={(text) => parseCombo(text, comboEntries.length, t)}
          onApply={handleComboJsonApply}
          onClose={() => setShowComboJsonEditor(false)}
          testIdPrefix="combo-json-editor"
          exportFileName="combo"
        />
      )}

      {showKoJsonEditor && keyOverrideEntries && keyOverrideEntries.length > 0 && (
        <JsonEditorModal<KeyOverrideEntry[]>
          title={t('editor.tapDance.editJson')}
          initialText={keyOverrideToJson(keyOverrideEntries)}
          parse={(text) => parseKeyOverride(text, keyOverrideEntries.length, t)}
          onApply={handleKoJsonApply}
          onClose={() => setShowKoJsonEditor(false)}
          testIdPrefix="ko-json-editor"
          exportFileName="ko"
        />
      )}

      {showArkJsonEditor && altRepeatKeyEntries && altRepeatKeyEntries.length > 0 && (
        <JsonEditorModal<AltRepeatKeyEntry[]>
          title={t('editor.tapDance.editJson')}
          initialText={altRepeatKeyToJson(altRepeatKeyEntries)}
          parse={(text) => parseAltRepeatKey(text, altRepeatKeyEntries.length, t)}
          onApply={handleArkJsonApply}
          onClose={() => setShowArkJsonEditor(false)}
          testIdPrefix="ark-json-editor"
          exportFileName="ark"
        />
      )}

      {showMacroJsonEditor && deserializedMacros && deserializedMacros.length > 0 && (
        <JsonEditorModal<MacroAction[][]>
          title={t('editor.tapDance.editJson')}
          initialText={macroToJson(deserializedMacros)}
          parse={(text) => parseMacro(text, deserializedMacros.length, t)}
          onApply={handleMacroJsonApply}
          onClose={() => setShowMacroJsonEditor(false)}
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
    </div>
  )
})
