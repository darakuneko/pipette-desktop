// SPDX-License-Identifier: GPL-2.0-or-later

// Owns the picker panel's "Keyboard" tab state — browsing a connected
// device, probing another detected device, or loading a saved/exported
// layout file — plus the derived keycode data it renders. Returns the
// fully-wired JSX (via `LayoutPickerContent`) so KeymapEditor only needs
// to thread it into `TabbedKeycodes`' `keyboardPickerContent` prop.

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { serialize, findKeycode } from '../../../shared/keycodes/keycodes'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { parseKle } from '../../../shared/kle/kle-parser'
import { decodeLayoutOptions } from '../../../shared/kle/layout-options'
import { posKey } from '../../../shared/kle/pos-key'
import { isVilFile, isVilFileV1, recordToMap, deriveLayerCount } from '../../../shared/vil-file'
import type { KleKey, KeyboardLayout } from '../../../shared/kle/types'
import type { DeviceInfo } from '../../../shared/types/protocol'
import type { StoredKeyboardInfo } from '../../../shared/types/sync'
import type { SnapshotMeta } from '../../../shared/types/snapshot-store'
import { LayoutPickerContent } from './LayoutPickerContent'
import type { PickerData, PickerFileData } from './keymap-editor-types'

export interface UseLayoutPickerOptions {
  layout: KeyboardLayout | null
  layers: number
  layerNames?: string[]
  keymap: Map<string, number>
  effectiveLayoutOptions: Map<number, number>
  remapLabel?: (qmkId: string) => string
  scale: number
  onScaleChange?: (delta: number) => void
  devices?: DeviceInfo[]
  connectedDevice?: DeviceInfo | null
  onDeviceListActiveChange?: (active: boolean) => void
  selectedKey: { row: number; col: number } | null
  selectedEncoder: { idx: number; dir: number } | null
  /** Omit to make the Keyboard tab's keyboard-as-picker completely
   *  non-interactive (Plan-qwerty-select-no-rewrite v7 — simulation tab
   *  read-only enforcement): clicking a key there normally either pastes
   *  into whatever `selectedKey`/`selectedEncoder` is (shared state, so
   *  still reachable even while THIS surface shows nothing selected) or
   *  starts a picker multi-select. `handlePickerKeyClick` falls through to
   *  a no-op when both this and `handlePickerMultiSelect` are omitted. */
  handleKeycodeSelect?: (kc: Pick<Keycode, 'qmkId'>) => Promise<void>
  handlePickerMultiSelect?: (
    index: number,
    keycode: number,
    event: { ctrlKey: boolean; shiftKey: boolean },
    tabKeycodeNumbers: number[],
  ) => void
  pickerSelectedIndices: Set<number>
  clearPickerSelection: () => void
  buildKeycodesForLayer: (layer: number) => { keycodes: Map<string, string>; remapped: Set<string> }
  buildEncoderKeycodesForLayer: (layer: number) => Map<string, [string, string]>
}

export interface UseLayoutPickerReturn {
  layoutPickerContent: React.ReactNode
}

export function useLayoutPicker({
  layout, layers, layerNames, keymap, effectiveLayoutOptions, remapLabel, scale, onScaleChange,
  devices, connectedDevice, onDeviceListActiveChange,
  selectedKey, selectedEncoder, handleKeycodeSelect, handlePickerMultiSelect,
  pickerSelectedIndices, clearPickerSelection,
  buildKeycodesForLayer, buildEncoderKeycodesForLayer,
}: UseLayoutPickerOptions): UseLayoutPickerReturn {
  const { t } = useTranslation()

  const [pickerLayer, setPickerLayer] = useState(0)
  const [pickerSource, setPickerSource] = useState<'file' | 'device'>('device')
  const [pickerFileData, setPickerFileData] = useState<PickerFileData>(null)
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

  const handlePickerHover = useCallback((_key: KleKey, keycode: string, rect: DOMRect) => {
    const containerRect = pickerContainerRef.current?.getBoundingClientRect()
    if (!containerRect) return
    setPickerTooltip({
      keycode,
      top: rect.top - containerRect.top,
      left: rect.left - containerRect.left + rect.width / 2,
    })
  }, [])

  const handlePickerHoverEnd = useCallback(() => { setPickerTooltip(null) }, [])

  // --- Notify parent when device list browsing state changes ---
  useEffect(() => {
    onDeviceListActiveChange?.(pickerSource === 'device' && deviceBrowsing)
  }, [pickerSource, deviceBrowsing, onDeviceListActiveChange])

  // Save picker zoom back to target keyboard's settings
  useEffect(() => {
    const uid = pickerFileData?.uid
    if (pickerScale == null || !uid) return
    // PATCH only keymapScale so this can't clobber other fields on the
    // target keyboard's settings.
    window.vialAPI.pipetteSettingsPatch(uid, { keymapScale: pickerScale }).catch(() => {})
  }, [pickerScale, pickerFileData?.uid])

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
  const isConnectedDevice = useCallback((d: DeviceInfo) => {
    return !!connectedDevice && d.vendorId === connectedDevice.vendorId && d.productId === connectedDevice.productId && d.serialNumber === connectedDevice.serialNumber
  }, [connectedDevice])

  const handleDeviceSelect = useCallback((d: DeviceInfo) => {
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

  const handlePickerKeyClick = useCallback((key: KleKey, _maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => {
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
      handleKeycodeSelect?.(kc)
    }
  }, [keymap, pickerLayer, pickerFileData, layout, handleKeycodeSelect, handlePickerMultiSelect, pickerTabKeycodeNumbers])

  // For file/device mode, build keycodes per-layer on the fly
  const filePickerKeycodes = useMemo(() => {
    if (!pickerFileData) return pickerKeycodes
    const remap = remapLabel ?? ((id: string) => id)
    const keycodes = new Map<string, string>()
    for (const [key, code] of pickerFileData.keymap) {
      const [l, r, c] = key.split(',')
      if (Number(l) === pickerLayer) keycodes.set(posKey(Number(r), Number(c)), remap(serialize(code)))
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

  // Layout picker: keyboard-as-keycode-picker shown inside the picker panel
  const pickerData: PickerData = pickerFileData
    ? { keys: pickerFileData.layout.keys, keycodes: pickerKeycodes, encoderKeycodes: pickerEncoderKeycodes, remapped: pickerRemapped, layoutOpts: pickerFileData.layoutOptions, totalLayers: pickerFileData.layers, names: pickerFileData.layerNames }
    : { keys: layout?.keys ?? [], keycodes: pickerKeycodes, encoderKeycodes: pickerEncoderKeycodes, remapped: pickerRemapped, layoutOpts: effectiveLayoutOptions, totalLayers: layers, names: layerNames }

  const pickerEffectiveScale = pickerFileData ? (pickerScale ?? scale) : scale
  const activPickerKeycodes = pickerFileData ? filePickerKeycodes : pickerKeycodes

  const pickerBrowseMode = (pickerSource === 'device' && deviceBrowsing) || (pickerSource === 'file' && !pickerFileData)

  const layoutPickerContent = (
    <LayoutPickerContent
      pickerSource={pickerSource} deviceBrowsing={deviceBrowsing} probeStatus={probeStatus}
      devices={devices} isConnectedDevice={isConnectedDevice} handleDeviceSelect={handleDeviceSelect}
      pickerLoadError={pickerLoadError} fileBrowseView={fileBrowseView} setFileBrowseView={setFileBrowseView}
      setSelectedFileUid={setSelectedFileUid} setPickerLoadError={setPickerLoadError}
      storedKeyboards={storedKeyboards} selectedFileUid={selectedFileUid} storedEntries={storedEntries}
      handleLoadSnapshotEntry={handleLoadSnapshotEntry} handleLoadPickerFile={handleLoadPickerFile}
      pickerContainerRef={pickerContainerRef} pickerData={pickerData} activPickerKeycodes={activPickerKeycodes}
      pickerHighlightPositions={pickerHighlightPositions} pickerEffectiveScale={pickerEffectiveScale}
      pickerLayer={pickerLayer} pickerFileData={pickerFileData} handlePickerKeyClick={handlePickerKeyClick}
      handlePickerHover={handlePickerHover} handlePickerHoverEnd={handlePickerHoverEnd} pickerTooltip={pickerTooltip}
      setPickerSource={setPickerSource} setPickerLayer={setPickerLayer} setPickerFileData={setPickerFileData}
      setPickerScale={setPickerScale} setDeviceBrowsing={setDeviceBrowsing} setProbeStatus={setProbeStatus}
      pickerBrowseMode={pickerBrowseMode} onScaleChange={onScaleChange} clearPickerSelection={clearPickerSelection}
    />
  )

  return { layoutPickerContent }
}
