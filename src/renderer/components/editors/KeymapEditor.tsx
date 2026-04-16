// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useMemo, useRef, useImperativeHandle, forwardRef } from 'react'
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
import { ZoomIn, ZoomOut, SlidersHorizontal, Undo2, Redo2 } from 'lucide-react'
import { parseKle } from '../../../shared/kle/kle-parser'
import { decodeLayoutOptions } from '../../../shared/kle/layout-options'
import { isVilFile, isVilFileV1, recordToMap, deriveLayerCount } from '../../../shared/vil-file'
import type { KeyboardLayout } from '../../../shared/kle/types'
import type { StoredKeyboardInfo } from '../../../shared/types/sync'
import type { SnapshotMeta } from '../../../shared/types/snapshot-store'

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
import { useKeymapHistory } from './useKeymapHistory'
import { useAppConfig } from '../../hooks/useAppConfig'
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
  nextKeycode?: number
  onRedo?: () => void
}

function PopoverForState({
  popoverState, keymap, encoderLayout, currentLayer, layers,
  onKeycodeSelect, onRawKeycodeSelect, onModMaskChange, onClose,
  quickSelect, previousKeycode, onUndo, nextKeycode, onRedo,
}: PopoverForStateProps) {
  const currentKeycode = popoverState.kind === 'key'
    ? keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
    : encoderLayout.get(`${currentLayer},${popoverState.idx},${popoverState.dir}`) ?? 0
  const maskOnly = popoverState.maskClicked && isMask(serialize(currentKeycode))
  return (
    <KeyPopover
      anchorRect={popoverState.anchorRect} currentKeycode={currentKeycode} maskOnly={maskOnly} layers={layers}
      onKeycodeSelect={onKeycodeSelect} onRawKeycodeSelect={onRawKeycodeSelect} onModMaskChange={onModMaskChange}
      onClose={onClose} quickSelect={quickSelect} previousKeycode={previousKeycode} onUndo={onUndo}
      nextKeycode={nextKeycode} onRedo={onRedo}
    />
  )
}

export const KeymapEditor = forwardRef<import('./keymap-editor-types').KeymapEditorHandle, Props>(function KeymapEditor({
  keyboardUid, layout, layers, currentLayer, onLayerChange, keymap, encoderLayout, encoderCount,
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
  typingTestMode, onTypingTestModeChange, onSaveTypingTestResult, typingTestHistory,
  typingTestConfig: savedTypingTestConfig, typingTestLanguage: savedTypingTestLanguage,
  onTypingTestConfigChange, onTypingTestLanguageChange,
  typingTestViewOnly, onTypingTestViewOnlyChange,
  typingTestViewOnlyWindowSize, onTypingTestViewOnlyWindowSizeChange,
  typingTestViewOnlyAlwaysOnTop, onTypingTestViewOnlyAlwaysOnTopChange,
  deviceName, isDummy, onExportLayoutPdfAll, onExportLayoutPdfCurrent,
  favHubOrigin, favHubNeedsDisplayName, favHubUploading, favHubUploadResult,
  onFavUploadToHub, onFavUpdateOnHub, onFavRemoveFromHub, onFavRenameOnHub,
  devices, connectedDevice, onDeviceListActiveChange,
}, ref) {
  const { t } = useTranslation()
  const keyboardContentRef = useRef<HTMLDivElement>(null)
  const [pickerLayer, setPickerLayer] = useState(0)
  const [pickerSource, setPickerSource] = useState<'file' | 'device'>('device')
  const [pickerFileData, setPickerFileData] = useState<{
    layout: KeyboardLayout; keymap: Map<string, number>; layers: number
    encoderKeycodes: Map<string, [string, string]>; layoutOptions: Map<number, number>
    name: string; layerNames?: string[]; uid?: string
  } | null>(null)
  const [storedKeyboards, setStoredKeyboards] = useState<StoredKeyboardInfo[]>([])
  const [selectedFileUid, setSelectedFileUid] = useState<string | null>(null)
  const [storedEntries, setStoredEntries] = useState<SnapshotMeta[]>([])
  const [fileBrowseView, setFileBrowseView] = useState<'list' | 'entries'>('list')
  const [pickerLoadError, setPickerLoadError] = useState<string | null>(null)
  const [probeStatus, setProbeStatus] = useState<'idle' | 'probing' | 'error'>('idle')
  const [deviceBrowsing, setDeviceBrowsing] = useState(true)
  const [pickerScale, setPickerScale] = useState<number | undefined>(undefined)
  const [pickerTooltip, setPickerTooltip] = useState<{ keycode: string; top: number; left: number } | null>(null)
  // pickerClickedPositions removed — now tracked via pickerSelectedIndices in useKeymapMultiSelect
  const pickerContainerRef = useRef<HTMLDivElement>(null)

  const handlePickerHover = useCallback((_key: import('../../../shared/kle/types').KleKey, keycode: string, rect: DOMRect) => {
    const containerRect = pickerContainerRef.current?.getBoundingClientRect()
    if (!containerRect) return
    setPickerTooltip({
      keycode,
      top: rect.top - containerRect.top,
      left: rect.left - containerRect.left + rect.width / 2,
    })
  }, [])

  const handlePickerHoverEnd = useCallback(() => { setPickerTooltip(null) }, [])

  // --- Input modes (matrix tester + typing test) ---
  const {
    matrixMode, pressedKeys, everPressedKeys, hasMatrixTester,
    handleMatrixToggle, handleTypingTestToggle,
    typingTest, handleTypingTestConfigChange, handleTypingTestLanguageChange,
  } = useInputModes({
    rows, cols, getMatrixState, unlocked, onUnlock, onMatrixModeChange, keymap,
    typingTestMode, onTypingTestModeChange, savedTypingTestConfig, savedTypingTestLanguage,
    onTypingTestConfigChange, onTypingTestLanguageChange, onSaveTypingTestResult, typingTestHistory,
    typingTestViewOnly,
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

  // --- Keymap history ---
  const { config: appCfg } = useAppConfig()
  const history = useKeymapHistory(appCfg.maxKeymapHistory)

  // Clear history on keyboard/context switch or disconnect
  const prevUidRef = useRef(keyboardUid)
  const keymapSize = keymap.size
  useEffect(() => {
    if (keyboardUid !== prevUidRef.current || keymapSize === 0) {
      prevUidRef.current = keyboardUid
      history.clear()
    }
  }, [keyboardUid, keymapSize, history.clear])

  // --- Selection + handlers ---
  const {
    selectedKey, selectedEncoder, selectedMaskPart, popoverState, setPopoverState,
    selectedKeycode, isMaskKey, isLMMask,
    handleKeyClick, handleEncoderClick, handleKeyDoubleClick, handleEncoderDoubleClick,
    handleKeycodeSelect, handlePopoverKeycodeSelect, handlePopoverRawKeycodeSelect,
    handlePopoverModMaskChange, popoverUndoKeycode, handlePopoverUndo,
    popoverRedoKeycode, handlePopoverRedo,
    handleUndo, handleRedo,
    handleDeselect, handleDeselectClick,
    tdModalIndex, macroModalIndex, handleTdModalSave, handleTdModalClose, handleMacroModalClose,
  } = useKeymapSelectionHandlers({
    layout, keymap, encoderLayout, currentLayer,
    selectableKeys, autoAdvance,
    onSetKey, onSetKeysBulk, onSetEncoder, unlocked, onUnlock,
    multiSelect, history,
    tapDanceEntries, onSetTapDanceEntry,
    macroCount, macroBufferSize, macroBuffer, onSaveMacros,
  })

  hasActiveSingleSelectionRef.current = !!(selectedKey || selectedEncoder)
  const { multiSelectedKeys, pickerSelectedIndices, handlePickerMultiSelect } = multiSelect

  // --- Notify parent when device list browsing state changes ---
  useEffect(() => {
    onDeviceListActiveChange?.(pickerSource === 'device' && deviceBrowsing)
  }, [pickerSource, deviceBrowsing, onDeviceListActiveChange])

  // Save picker zoom back to target keyboard's settings
  useEffect(() => {
    const uid = pickerFileData?.uid
    if (pickerScale == null || !uid) return
    window.vialAPI.pipetteSettingsGet(uid).then((prefs) => {
      if (prefs) {
        window.vialAPI.pipetteSettingsSet(uid, { ...prefs, keymapScale: pickerScale }).catch(() => {})
      }
    }).catch(() => {})
  }, [pickerScale, pickerFileData?.uid])

  // --- Escape clears picker selection ---
  useEffect(() => {
    if (pickerSelectedIndices.size === 0) return
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') multiSelect.clearPickerSelection() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pickerSelectedIndices.size, multiSelect])

  // --- Layout picker: stored keyboards browsing ---
  useEffect(() => {
    if (pickerSource !== 'file') return
    window.vialAPI.listStoredKeyboards().then(setStoredKeyboards).catch(() => {})
  }, [pickerSource])

  useEffect(() => {
    if (!selectedFileUid) { setStoredEntries([]); return }
    window.vialAPI.snapshotStoreList(selectedFileUid).then((r) => {
      if (r.success && r.entries) setStoredEntries(r.entries.filter((e) => !e.deletedAt && e.vilVersion !== 1))
    }).catch(() => {})
  }, [selectedFileUid])

  // --- Layout picker file loading ---
  const loadPickerFromJson = useCallback((jsonStr: string) => {
    try {
      const parsed = JSON.parse(jsonStr)
      if (!isVilFile(parsed)) {
        setPickerLoadError(t('error.loadFailed'))
        return false
      }
      if (isVilFileV1(parsed) || !parsed.definition) {
        setPickerLoadError(t('error.vilV1NotSupported'))
        return false
      }
      const fileLayout = parseKle(parsed.definition.layouts.keymap)
      const fileKeymap = recordToMap(parsed.keymap)
      const fileLayers = deriveLayerCount(parsed.keymap)
      const remap = remapLabel ?? ((id: string) => id)
      const encoderKeycodes = new Map<string, [string, string]>()
      if (parsed.encoderLayout) {
        const encMap = recordToMap(parsed.encoderLayout)
        const encCount = new Set([...encMap.keys()].map((k) => k.split(',')[1])).size
        for (let i = 0; i < encCount; i++) {
          for (let layer = 0; layer < fileLayers; layer++) {
            const cw = encMap.get(`${layer},${i},0`) ?? 0
            const ccw = encMap.get(`${layer},${i},1`) ?? 0
            encoderKeycodes.set(`${layer},${i}`, [remap(serialize(cw)), remap(serialize(ccw))])
          }
        }
      }
      const fileUid = typeof parsed.uid === 'string' ? parsed.uid : undefined
      setPickerFileData({
        layout: fileLayout, keymap: fileKeymap, layers: fileLayers, encoderKeycodes,
        layoutOptions: parsed.definition.layouts?.labels
          ? decodeLayoutOptions(parsed.layoutOptions ?? 0, parsed.definition.layouts.labels) : new Map(),
        name: parsed.definition.name ?? 'File', layerNames: parsed.layerNames, uid: fileUid,
      })
      if (fileUid) {
        window.vialAPI.pipetteSettingsGet(fileUid).then((prefs) => {
          if (prefs?.keymapScale != null) setPickerScale(prefs.keymapScale)
        }).catch(() => {})
      } else {
        setPickerScale(undefined)
      }
      setPickerLayer(0)
      setFileBrowseView('list')
      return true
    } catch {
      setPickerLoadError(t('error.loadFailed'))
      return false
    }
  }, [remapLabel, t])

  const handleLoadPickerFile = useCallback(async () => {
    setPickerLoadError(null)
    const result = await window.vialAPI.loadLayout(t('editor.keymap.pickerLoadFile'), ['.pipette', '.vil'])
    if (!result.success || !result.data) {
      if (result.error !== 'cancelled') setPickerLoadError(t('error.loadFailed'))
      return
    }
    loadPickerFromJson(result.data)
  }, [t, loadPickerFromJson])

  const handleLoadSnapshotEntry = useCallback(async (uid: string, entryId: string) => {
    setPickerLoadError(null)
    const result = await window.vialAPI.snapshotStoreLoad(uid, entryId)
    if (!result.success || !result.data) {
      setPickerLoadError(t('error.loadFailed'))
      return
    }
    loadPickerFromJson(result.data)
  }, [t, loadPickerFromJson])

  // --- Device probe handler ---
  const handleProbeDevice = useCallback(async (vendorId: number, productId: number, serialNumber: string) => {
    setProbeStatus('probing')
    try {
      const result = await window.vialAPI.probeDevice(vendorId, productId, serialNumber)
      const fileLayout = parseKle(result.definition.layouts.keymap)
      const fileKeymap = new Map<string, number>(Object.entries(result.keymap))
      const remap = remapLabel ?? ((id: string) => id)
      const encoderKeycodes = new Map<string, [string, string]>()
      const encMap = new Map<string, number>(Object.entries(result.encoderLayout))
      for (let i = 0; i < result.encoderCount; i++) {
        for (let layer = 0; layer < result.layers; layer++) {
          const cw = encMap.get(`${layer},${i},0`) ?? 0
          const ccw = encMap.get(`${layer},${i},1`) ?? 0
          encoderKeycodes.set(`${layer},${i}`, [remap(serialize(cw)), remap(serialize(ccw))])
        }
      }
      let probeKeymapScale: number | undefined
      if (result.uid) {
        try {
          const prefs = await window.vialAPI.pipetteSettingsGet(result.uid)
          if (prefs?.keymapScale != null) probeKeymapScale = prefs.keymapScale
        } catch { /* best-effort */ }
      }
      setPickerScale(probeKeymapScale)
      setPickerFileData({
        layout: fileLayout, keymap: fileKeymap, layers: result.layers, encoderKeycodes,
        layoutOptions: result.definition.layouts?.labels
          ? decodeLayoutOptions(result.layoutOptions, result.definition.layouts.labels) : new Map(),
        name: result.name, uid: result.uid,
      })
      setPickerLayer(0)
      setProbeStatus('idle')
    } catch {
      setProbeStatus('error')
    }
  }, [remapLabel])

  // --- Device list for probe picker (includes connected device) ---
  const isConnectedDevice = useCallback((d: import('../../../shared/types/protocol').DeviceInfo) => {
    return !!connectedDevice && d.vendorId === connectedDevice.vendorId && d.productId === connectedDevice.productId && d.serialNumber === connectedDevice.serialNumber
  }, [connectedDevice])

  const handleDeviceSelect = useCallback((d: import('../../../shared/types/protocol').DeviceInfo) => {
    if (isConnectedDevice(d)) {
      // Connected device → use existing keymap/layout (clear pickerFileData)
      setPickerFileData(null)
      setPickerScale(undefined)
      setPickerLayer(0)
      setDeviceBrowsing(false)
    } else {
      setDeviceBrowsing(false)
      handleProbeDevice(d.vendorId, d.productId, d.serialNumber)
    }
  }, [isConnectedDevice, handleProbeDevice])

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

  // Build ordered keycode numbers for picker multi-select (Shift+click range)
  const pickerTabKeycodeNumbers = useMemo(() => {
    const sourceKeymap = pickerFileData ? pickerFileData.keymap : keymap
    const keys = pickerFileData ? pickerFileData.layout.keys : layout?.keys ?? []
    const numbers: number[] = []
    for (const key of keys) {
      if (key.row == null || key.col == null) continue
      const code = sourceKeymap.get(`${pickerLayer},${key.row},${key.col}`)
      if (code != null) numbers.push(code)
    }
    return numbers
  }, [pickerFileData, keymap, pickerLayer, layout])

  const handlePickerKeyClick = useCallback((key: import('../../../shared/kle/types').KleKey, _maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => {
    const sourceKeymap = pickerFileData ? pickerFileData.keymap : keymap
    const code = sourceKeymap.get(`${pickerLayer},${key.row},${key.col}`)
    if (code == null) return
    // Always assign the full composite keycode (e.g. LT1(KC_SPC) as-is)
    const qmkId = serialize(code)
    const kc = findKeycode(qmkId) ?? { qmkId, label: qmkId, keycode: code }
    const isModified = event && (event.ctrlKey || event.shiftKey)
    if (isModified && handlePickerMultiSelect) {
      // Find the index of this key in the picker's ordered list
      const keys = pickerFileData ? pickerFileData.layout.keys : layout?.keys ?? []
      let index = 0
      for (const k of keys) {
        if (k.row == null || k.col == null) continue
        if (k.row === key.row && k.col === key.col) break
        if (sourceKeymap.has(`${pickerLayer},${k.row},${k.col}`)) index++
      }
      handlePickerMultiSelect(index, code, { ctrlKey: !!event.ctrlKey, shiftKey: !!event.shiftKey }, pickerTabKeycodeNumbers)
    } else if (handlePickerMultiSelect && !selectedKey && !selectedEncoder) {
      // Normal click (no key selected): select single key and set anchor
      const keys = pickerFileData ? pickerFileData.layout.keys : layout?.keys ?? []
      let index = 0
      for (const k of keys) {
        if (k.row == null || k.col == null) continue
        if (k.row === key.row && k.col === key.col) break
        if (sourceKeymap.has(`${pickerLayer},${k.row},${k.col}`)) index++
      }
      handlePickerMultiSelect(index, code, { ctrlKey: false, shiftKey: false }, pickerTabKeycodeNumbers)
    } else {
      handleKeycodeSelect(kc)
    }
  }, [keymap, pickerLayer, pickerFileData, layout, handleKeycodeSelect, handlePickerMultiSelect, pickerTabKeycodeNumbers])

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

  // For file/device mode, build keycodes per-layer on the fly
  const filePickerKeycodes = useMemo(() => {
    if (!pickerFileData) return pickerKeycodes
    const remap = remapLabel ?? ((id: string) => id)
    const keycodes = new Map<string, string>()
    for (const [key, code] of pickerFileData.keymap) {
      const [l, r, c] = key.split(',')
      if (Number(l) === pickerLayer) keycodes.set(`${r},${c}`, remap(serialize(code)))
    }
    return keycodes
  }, [pickerFileData, pickerLayer, remapLabel, pickerKeycodes])

  // Convert picker selected indices to position strings for keyboard widget highlight
  const pickerHighlightPositions = useMemo(() => {
    if (pickerSelectedIndices.size === 0) return undefined
    const keys = pickerFileData ? pickerFileData.layout.keys : layout?.keys ?? []
    const sourceKeymap = pickerFileData ? pickerFileData.keymap : keymap
    const positions = new Set<string>()
    let idx = 0
    for (const key of keys) {
      if (key.row == null || key.col == null) continue
      if (!sourceKeymap.has(`${pickerLayer},${key.row},${key.col}`)) continue
      if (pickerSelectedIndices.has(idx)) positions.add(`${key.row},${key.col}`)
      idx++
    }
    return positions.size > 0 ? positions : undefined
  }, [pickerSelectedIndices, pickerFileData, layout, keymap, pickerLayer])

  if (!layout) return <div className="p-4 text-content-muted">{t('common.loading')}</div>

  function layerLabel(layer: number): string {
    return layerNames?.[layer] || t('editor.keymap.layerN', { n: layer })
  }

  // Layout picker: keyboard-as-keycode-picker shown inside the picker panel
  const pickerData = pickerFileData
    ? { keys: pickerFileData.layout.keys, keycodes: pickerKeycodes, encoderKeycodes: pickerEncoderKeycodes, remapped: pickerRemapped, layoutOpts: pickerFileData.layoutOptions, totalLayers: pickerFileData.layers, names: pickerFileData.layerNames }
    : { keys: layout.keys, keycodes: pickerKeycodes, encoderKeycodes: pickerEncoderKeycodes, remapped: pickerRemapped, layoutOpts: effectiveLayoutOptions, totalLayers: layers, names: layerNames }

  const pickerEffectiveScale = pickerFileData ? (pickerScale ?? scaleProp) : scaleProp
  const activPickerKeycodes = pickerFileData ? filePickerKeycodes : pickerKeycodes

  const layerBtnClass = (active: boolean) =>
    `min-w-7 max-w-20 shrink-0 truncate rounded-md border px-1.5 py-1 text-center text-[12px] font-semibold tabular-nums transition-colors ${
      active ? 'border-accent bg-accent text-content-inverse' : 'border-edge bg-surface/20 text-content-muted hover:bg-surface-dim'
    }`
  const sourceBtnClass = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
      active ? 'bg-surface-dim text-content' : 'text-content-muted hover:text-content hover:bg-surface-dim/50'
    }`

  const pickerBrowseMode = (pickerSource === 'device' && deviceBrowsing) || (pickerSource === 'file' && !pickerFileData)

  const layoutPickerContent = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {pickerSource === 'device' && deviceBrowsing ? (
          /* --- Device browse view --- */
          <div className="mx-auto flex w-full max-w-md flex-col px-3 py-3">
            <div className="flex min-h-[340px] max-h-[340px] flex-col gap-1.5 overflow-y-auto pb-2 pr-1">
              <span className="mb-1 text-xs text-content-secondary">{t('editor.keymap.pickerCurrentState')}</span>
              {probeStatus === 'probing' ? (
                <p className="py-4 text-center text-xs text-content-muted">{t('editor.keymap.pickerProbing')}</p>
              ) : probeStatus === 'error' ? (
                <p className="py-4 text-center text-xs text-danger">{t('editor.keymap.pickerProbeError')}</p>
              ) : devices?.length ? devices.map((d) => (
                <button key={`${d.vendorId}:${d.productId}:${d.serialNumber}`} type="button"
                  className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-surface-dim ${isConnectedDevice(d) ? 'border-accent/40 bg-accent/5' : 'border-edge'}`}
                  onClick={() => handleDeviceSelect(d)}>
                  <span className="font-medium text-content">{d.productName || `${d.vendorId.toString(16)}:${d.productId.toString(16)}`}</span>
                  <span className="text-xs text-content-muted">›</span>
                </button>
              )) : (
                <p className="py-4 text-center text-xs text-content-muted">{t('editor.keymap.pickerNoDevices')}</p>
              )}
            </div>
            <div className="mt-2 rounded-lg border border-dashed border-transparent px-3 py-2 text-center text-xs invisible">&#8203;</div>
          </div>
        ) : pickerSource === 'file' && !pickerFileData ? (
          /* --- File browse view --- */
          <div className="mx-auto flex w-full max-w-md flex-col px-3 py-3">
            <div className="flex min-h-[340px] max-h-[340px] flex-col gap-1.5 overflow-y-auto pb-2 pr-1">
            {pickerLoadError && (
              <div className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
                {pickerLoadError}
              </div>
            )}
            {fileBrowseView === 'list' && (
              <span className="mb-1 text-xs text-content-secondary">{t('editor.keymap.pickerSavedFiles')}</span>
            )}
            {fileBrowseView === 'entries' && (
              <button type="button" className="mb-2 self-start text-xs text-content-secondary hover:text-content"
                onClick={() => { setFileBrowseView('list'); setSelectedFileUid(null); setPickerLoadError(null) }}>
                ← {t('common.back')}
              </button>
            )}
            {fileBrowseView === 'list' ? (
              storedKeyboards.length > 0 ? storedKeyboards.map((kb) => (
                <button key={kb.uid} type="button"
                  className="flex items-center justify-between rounded-lg border border-edge px-3 py-2 text-left text-sm transition-colors hover:bg-surface-dim"
                  onClick={() => { setSelectedFileUid(kb.uid); setFileBrowseView('entries'); setPickerLoadError(null) }}>
                  <span className="font-medium text-content">{kb.name}</span>
                  <span className="text-xs text-content-muted">›</span>
                </button>
              )) : (
                <p className="py-4 text-center text-xs text-content-muted">{t('editor.keymap.pickerNoSavedFiles')}</p>
              )
            ) : (
              storedEntries.length > 0 ? storedEntries.map((entry) => (
                <button key={entry.id} type="button"
                  className="flex flex-col rounded-lg border border-edge px-3 py-2 text-left text-sm transition-colors hover:bg-surface-dim"
                  onClick={() => handleLoadSnapshotEntry(selectedFileUid!, entry.id)}>
                  <span className="font-medium text-content">{entry.label || entry.filename}</span>
                  <span className="text-[11px] text-content-muted">{new Date(entry.savedAt).toLocaleString()}</span>
                </button>
              )) : (
                <p className="py-4 text-center text-xs text-content-muted">{t('editor.keymap.pickerNoEntries')}</p>
              )
            )}
            </div>
            <button type="button"
              className="mt-2 rounded-lg border border-dashed border-edge px-3 py-2 text-center text-xs text-content-muted transition-colors hover:border-edge hover:bg-surface-dim hover:text-content"
              onClick={handleLoadPickerFile}>
              {t('editor.keymap.pickerLoadFile')}
            </button>
          </div>
        ) : (
          /* --- Keyboard view (current / loaded file / probed device) --- */
          <div ref={pickerContainerRef} className="picker-hover-keys relative flex h-full min-h-0 items-center justify-center">
            <KeyboardPane
              paneId="secondary" isActive={true}              keys={pickerData.keys} keycodes={activPickerKeycodes} encoderKeycodes={pickerData.encoderKeycodes}
              selectedKey={null} selectedEncoder={null} selectedMaskPart={false} selectedKeycode={null}
              remappedKeys={pickerData.remapped} multiSelectedKeys={pickerHighlightPositions}
              layoutOptions={pickerData.layoutOpts} scale={pickerEffectiveScale}
              layerLabel={(pickerData.names?.[pickerLayer] || t('editor.keymap.layerN', { n: pickerLayer })) + (pickerFileData ? ` — ${pickerFileData.name}` : '')}
              layerLabelTestId="picker-layer-label"
              onKeyClick={handlePickerKeyClick}
              onKeyHover={handlePickerHover}
              onKeyHoverEnd={handlePickerHoverEnd}
            />
            {pickerTooltip && (
              <div
                className="pointer-events-none absolute z-50 rounded-md border border-edge bg-surface-alt px-2.5 py-1.5 shadow-lg"
                style={{ top: pickerTooltip.top - 4, left: pickerTooltip.left, transform: 'translate(-50%, -100%)' }}
              >
                <div className="text-[10px] leading-snug text-content-muted whitespace-nowrap">{pickerTooltip.keycode}</div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between px-2 pb-1">
        <div className="flex items-center gap-1">
          <button type="button" className={sourceBtnClass(pickerSource === 'device')}
            onClick={() => {
              setPickerSource('device'); setPickerLayer(0); setPickerFileData(null); setPickerScale(undefined); setDeviceBrowsing(true); setProbeStatus('idle'); setPickerLoadError(null)
            }}>
            {pickerSource === 'device' && !deviceBrowsing
              ? t('editor.keymap.pickerBackToDevices')
              : t('editor.keymap.pickerSourceDevice')}
          </button>
          <button type="button" className={sourceBtnClass(pickerSource === 'file')}
            onClick={() => { setPickerSource('file'); setPickerLayer(0); setPickerFileData(null); setPickerScale(undefined); setFileBrowseView('list'); setDeviceBrowsing(false); setPickerLoadError(null) }}>
            {pickerSource === 'file' && pickerFileData ? t('editor.keymap.pickerBackToFiles') : t('editor.keymap.pickerSourceFile')}
          </button>
        </div>
        <div className={`flex items-center gap-1 ${pickerBrowseMode ? 'invisible' : ''}`}>
          <button type="button" aria-label={t('editor.keymap.zoomIn')}
            className="rounded-md p-1 text-content-muted transition-colors hover:bg-surface-dim hover:text-content disabled:opacity-30 disabled:pointer-events-none"
            disabled={pickerEffectiveScale >= MAX_SCALE}
            onClick={() => { if (pickerFileData) setPickerScale(Math.min(MAX_SCALE, +(pickerEffectiveScale + 0.1).toFixed(1))); else onScaleChange?.(0.1) }}>
            <ZoomIn size={14} aria-hidden="true" />
          </button>
          <ScaleInput scale={pickerEffectiveScale} onScaleChange={(delta) => {
            if (pickerFileData) setPickerScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, +(pickerEffectiveScale + delta).toFixed(1))))
            else onScaleChange?.(delta)
          }} />
          <button type="button" aria-label={t('editor.keymap.zoomOut')}
            className="rounded-md p-1 text-content-muted transition-colors hover:bg-surface-dim hover:text-content disabled:opacity-30 disabled:pointer-events-none"
            disabled={pickerEffectiveScale <= MIN_SCALE}
            onClick={() => { if (pickerFileData) setPickerScale(Math.max(MIN_SCALE, +(pickerEffectiveScale - 0.1).toFixed(1))); else onScaleChange?.(-0.1) }}>
            <ZoomOut size={14} aria-hidden="true" />
          </button>
        </div>
        <div className={`flex min-w-0 items-center gap-1 overflow-x-auto ${pickerBrowseMode ? 'invisible' : ''}`}>
          {Array.from({ length: pickerData.totalLayers }, (_, i) => {
            const label = pickerData.names?.[i]?.trim()
            return (
              <button key={i} type="button" className={layerBtnClass(pickerLayer === i)}
                title={label || undefined}
                onClick={() => { setPickerLayer(i); multiSelect.clearPickerSelection() }}>
                {label || i}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )

  const zoomButtonClass = `${toggleButtonClass(false)} disabled:opacity-30 disabled:pointer-events-none`

  const toolbar = (
    <div className="flex shrink-0 flex-col items-center gap-3 self-stretch" style={{ width: PANEL_COLLAPSED_WIDTH }}>
      {!typingTestMode && (
        <>
          <IconTooltip label={t('editor.keymap.undo')}>
            <button type="button" data-testid="undo-button" aria-label={t('editor.keymap.undo')} className={zoomButtonClass} disabled={!history.canUndo} onClick={() => void handleUndo()}>
              <Undo2 size={16} aria-hidden="true" />
            </button>
          </IconTooltip>
          <IconTooltip label={t('editor.keymap.redo')}>
            <button type="button" data-testid="redo-button" aria-label={t('editor.keymap.redo')} className={zoomButtonClass} disabled={!history.canRedo} onClick={() => void handleRedo()}>
              <Redo2 size={16} aria-hidden="true" />
            </button>
          </IconTooltip>
        </>
      )}
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
    <div className={`flex min-h-0 flex-1 flex-col ${typingTestMode && typingTestViewOnly ? '' : 'gap-3'}`}>
      <div
        className={typingTestMode && typingTestViewOnly ? 'flex flex-1 items-stretch gap-2' : 'flex items-start gap-2 overflow-auto'}
        style={!typingTestMode && keyboardAreaMinHeight ? { minHeight: keyboardAreaMinHeight } : undefined}
        onClick={!typingTestMode ? handleDeselectClick : undefined}
      >
        {!(typingTestMode && typingTestViewOnly) && toolbar}
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
              viewOnly={typingTestViewOnly}
              onViewOnlyChange={onTypingTestViewOnlyChange}
              viewOnlyWindowSize={typingTestViewOnlyWindowSize}
              onViewOnlyWindowSizeChange={onTypingTestViewOnlyWindowSizeChange}
              viewOnlyAlwaysOnTop={typingTestViewOnlyAlwaysOnTop}
              onViewOnlyAlwaysOnTopChange={onTypingTestViewOnlyAlwaysOnTopChange}
            />
          ) : (
            <KeyboardPane
              paneId="primary" isActive={true}              keys={layout.keys} keycodes={layerKeycodes} encoderKeycodes={layerEncoderKeycodes}
              selectedKey={selectedKey} selectedEncoder={selectedEncoder} selectedMaskPart={selectedMaskPart} selectedKeycode={selectedKeycode}
              pressedKeys={matrixMode ? pressedKeys : undefined} everPressedKeys={matrixMode ? everPressedKeys : undefined}
              remappedKeys={remappedKeys} multiSelectedKeys={multiSelectedKeys}
              layoutOptions={effectiveLayoutOptions} scale={scaleProp}
              layerLabel={layerLabel(currentLayer)} layerLabelTestId="layer-label"
              onKeyClick={handleKeyClick} onKeyDoubleClick={handleKeyDoubleClick}
              onEncoderClick={handleEncoderClick} onEncoderDoubleClick={handleEncoderDoubleClick}
              onDeselect={handleDeselect} contentRef={keyboardContentRef}
            />
          )}
        </div>
        {!typingTestMode && <div style={{ width: PANEL_COLLAPSED_WIDTH }} className="shrink-0" />}
      </div>

      {!typingTestMode && popoverState && (
        <PopoverForState
          popoverState={popoverState} keymap={keymap} encoderLayout={encoderLayout}
          currentLayer={currentLayer} layers={layers}
          onKeycodeSelect={handlePopoverKeycodeSelect} onRawKeycodeSelect={handlePopoverRawKeycodeSelect}
          onModMaskChange={handlePopoverModMaskChange}
          onClose={() => setPopoverState(null)} quickSelect={quickSelect}
          previousKeycode={popoverUndoKeycode} onUndo={handlePopoverUndo}
          nextKeycode={popoverRedoKeycode} onRedo={handlePopoverRedo}
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
            pickerSelectedIndices={pickerSelectedIndices}
            pickerMultiSelectEnabled={!selectedKey && !selectedEncoder}
            onBackgroundClick={handleDeselect}
            onTabChange={() => { multiSelect.clearPickerSelection() }}
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
          quickSelect={quickSelect} autoAdvance={autoAdvance} splitKeyMode={splitKeyMode} basicViewType={basicViewType}
          layers={layers}
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
