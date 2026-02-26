// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppConfig } from './hooks/useAppConfig'
import { useDeviceConnection } from './hooks/useDeviceConnection'
import { useKeyboard } from './hooks/useKeyboard'
import { useFileIO } from './hooks/useFileIO'
import { useLayoutStore } from './hooks/useLayoutStore'
import { useSideloadJson, isKeyboardDefinition } from './hooks/useSideloadJson'
import { useTheme } from './hooks/useTheme'
import { useDevicePrefs } from './hooks/useDevicePrefs'
import { useAutoLock } from './hooks/useAutoLock'
import { DeviceSelector } from './components/DeviceSelector'
import { SettingsModal } from './components/SettingsModal'
import { DataModal } from './components/DataModal'
import { NotificationModal } from './components/NotificationModal'
import { ConnectingOverlay } from './components/ConnectingOverlay'
import { useSync } from './hooks/useSync'
import { useStartupNotification } from './hooks/useStartupNotification'
import { StatusBar } from './components/StatusBar'
import { ComboPanelModal } from './components/editors/ComboPanelModal'
import { AltRepeatKeyPanelModal } from './components/editors/AltRepeatKeyPanelModal'
import { KeyOverridePanelModal } from './components/editors/KeyOverridePanelModal'
import { RGBConfigurator } from './components/editors/RGBConfigurator'
import { UnlockDialog } from './components/editors/UnlockDialog'
import { KeymapEditor, type KeymapEditorHandle } from './components/editors/KeymapEditor'
import { LayoutStoreContent, type FileStatus, type HubEntryResult } from './components/editors/LayoutStoreModal'
import { ROW_CLASS } from './components/editors/modal-controls'
import { ModalCloseButton } from './components/editors/ModalCloseButton'
import { decodeLayoutOptions } from '../shared/kle/layout-options'
import { generateKeymapC } from '../shared/keymap-export'
import { generateKeymapPdf } from '../shared/pdf-export'
import { generateAllLayoutOptionsPdf, generateCurrentLayoutPdf, type LayoutPdfInput } from '../shared/pdf-layout-export'
import { parseLayoutLabels } from '../shared/layout-options'
import { generatePdfThumbnail } from './utils/pdf-thumbnail'
import { isVilFile, recordToMap, deriveLayerCount } from '../shared/vil-file'
import { vilToVialGuiJson } from '../shared/vil-compat'
import { splitMacroBuffer, deserializeMacro, deserializeAllMacros, macroActionsToJson, jsonToMacroActions } from '../preload/macro'
import {
  serialize as serializeKeycode,
  serializeForCExport,
  keycodeLabel,
  isMask,
  findOuterKeycode,
  findInnerKeycode,
} from '../shared/keycodes/keycodes'
import type { DeviceInfo, QmkSettingsTab, VilFile } from '../shared/types/protocol'
import { EMPTY_UID } from '../shared/constants/protocol'
import type { SnapshotMeta } from '../shared/types/snapshot-store'
import { HUB_ERROR_DISPLAY_NAME_CONFLICT, HUB_ERROR_ACCOUNT_DEACTIVATED, HUB_ERROR_RATE_LIMITED } from '../shared/types/hub'
import type { HubMyPost, HubUploadResult, HubPaginationMeta, HubFetchMyPostsParams } from '../shared/types/hub'
import type { FavoriteType, SavedFavoriteMeta } from '../shared/types/favorite-store'
import type { FavHubEntryResult } from './components/editors/FavoriteHubActions'
import settingsDefs from '../shared/qmk-settings-defs.json'

// Lighting types that require the RGBConfigurator modal
const LIGHTING_TYPES = new Set(['qmk_backlight', 'qmk_rgblight', 'qmk_backlight_rgblight', 'vialrgb'])

function formatDeviceId(dev: DeviceInfo): string {
  const vid = dev.vendorId.toString(16).padStart(4, '0')
  const pid = dev.productId.toString(16).padStart(4, '0')
  return `${vid}:${pid}`
}

export function App() {
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const themeCtx = useTheme()
  const devicePrefs = useDevicePrefs()
  const device = useDeviceConnection()
  const keyboard = useKeyboard()
  const sync = useSync()
  const startupNotification = useStartupNotification()

  const deserializedMacros = useMemo(
    () => keyboard.parsedMacros
      ?? (keyboard.macroBuffer && keyboard.macroCount
        ? deserializeAllMacros(keyboard.macroBuffer, keyboard.vialProtocol, keyboard.macroCount)
        : undefined),
    [keyboard.parsedMacros, keyboard.macroBuffer, keyboard.macroCount, keyboard.vialProtocol],
  )

  // Wire keyboard's layer name persistence through devicePrefs
  useEffect(() => {
    keyboard.setSaveLayerNamesCallback(devicePrefs.setLayerNames)
  }, [keyboard.setSaveLayerNamesCallback, devicePrefs.setLayerNames])

  const [showSettings, setShowSettings] = useState(false)
  const [showDataModal, setShowDataModal] = useState(false)
  const [dummyError, setDummyError] = useState<string | null>(null)
  const [deviceLoadError, setDeviceLoadError] = useState<string | null>(null)
  const [deviceSyncing, setDeviceSyncing] = useState(false)
  const hasSyncedRef = useRef(false)
  const hasFavSyncedForDataRef = useRef(false)
  const hasKeyboardSyncedRef = useRef<string | null>(null)
  const [resettingData, setResettingData] = useState(false)
  const [hubUploading, setHubUploading] = useState<string | null>(null)
  const hubUploadingRef = useRef(false)
  const [hubUploadResult, setHubUploadResult] = useState<HubEntryResult | null>(null)
  const [favHubUploading, setFavHubUploading] = useState<string | null>(null)
  const favHubUploadingRef = useRef(false)
  const [favHubUploadResult, setFavHubUploadResult] = useState<FavHubEntryResult | null>(null)
  const [lastLoadedLabel, setLastLoadedLabel] = useState('')
  // Clear loaded label when device identity changes (USB unplug/replug, device switch)
  useEffect(() => { setLastLoadedLabel('') }, [keyboard.uid])
  const [hubMyPosts, setHubMyPosts] = useState<HubMyPost[]>([])
  const [hubMyPostsPagination, setHubMyPostsPagination] = useState<HubPaginationMeta | undefined>()
  const [hubKeyboardPosts, setHubKeyboardPosts] = useState<HubMyPost[]>([])
  const [hubOrigin, setHubOrigin] = useState('')
  useEffect(() => { window.vialAPI.hubGetOrigin().then(setHubOrigin).catch(() => {}) }, [])
  const [hubConnected, setHubConnected] = useState(false)
  const [hubDisplayName, setHubDisplayName] = useState<string | null>(null)
  const [hubAuthConflict, setHubAuthConflict] = useState(false)
  const [hubAccountDeactivated, setHubAccountDeactivated] = useState(false)

  // Device-triggered auto-sync — download favorites + keyboard files in one call
  useEffect(() => {
    // Not connected: reset flags so next connection triggers sync
    if (!device.connectedDevice) {
      if (!deviceSyncing) {
        hasSyncedRef.current = false
        hasKeyboardSyncedRef.current = null
      }
      return
    }

    // Wait for UID (available ~22ms into reload)
    if (!keyboard.uid || keyboard.uid === EMPTY_UID) {
      hasKeyboardSyncedRef.current = null
      return
    }

    if (hasKeyboardSyncedRef.current === keyboard.uid) return
    if (!sync.config.autoSync || !sync.authStatus.authenticated || !sync.hasPassword) return
    if (sync.loading || deviceSyncing) return

    hasSyncedRef.current = true
    hasKeyboardSyncedRef.current = keyboard.uid
    setDeviceSyncing(true)
    sync.syncNow('download', { favorites: true as const, keyboard: keyboard.uid })
      .catch(() => { hasSyncedRef.current = false; hasKeyboardSyncedRef.current = null })
      .finally(() => setDeviceSyncing(false))
  }, [device.connectedDevice, keyboard.uid, keyboard.loading,
      sync.loading, sync.config.autoSync, sync.authStatus.authenticated, sync.hasPassword,
      sync.syncNow, deviceSyncing])

  const decodedLayoutOptions = useMemo(() => {
    const labels = keyboard.definition?.layouts?.labels
    if (!labels) return new Map<number, number>()
    return decodeLayoutOptions(keyboard.layoutOptions, labels)
  }, [keyboard.definition, keyboard.layoutOptions])

  const keymapCGenerator = useCallback(
    () => generateKeymapC({
      layers: keyboard.layers,
      keys: keyboard.layout?.keys ?? [],
      keymap: keyboard.keymap,
      encoderLayout: keyboard.encoderLayout,
      encoderCount: keyboard.encoderCount,
      layoutOptions: decodedLayoutOptions,
      serializeKeycode: serializeForCExport,
    }),
    [
      keyboard.layers,
      keyboard.layout,
      keyboard.keymap,
      keyboard.encoderLayout,
      keyboard.encoderCount,
      decodedLayoutOptions,
    ],
  )

  const deviceName = device.connectedDevice?.productName || 'keyboard'

  const pdfGenerator = useCallback(
    () => generateKeymapPdf({
      deviceName,
      layers: keyboard.layers,
      keys: keyboard.layout?.keys ?? [],
      keymap: keyboard.keymap,
      encoderLayout: keyboard.encoderLayout,
      encoderCount: keyboard.encoderCount,
      layoutOptions: decodedLayoutOptions,
      serializeKeycode,
      keycodeLabel,
      isMask,
      findOuterKeycode,
      findInnerKeycode,
      tapDance: keyboard.tapDanceEntries,
      combo: keyboard.comboEntries,
      keyOverride: keyboard.keyOverrideEntries,
      altRepeatKey: keyboard.altRepeatKeyEntries,
      macros: deserializedMacros,
    }),
    [
      deviceName,
      keyboard.layers,
      keyboard.layout,
      keyboard.keymap,
      keyboard.encoderLayout,
      keyboard.encoderCount,
      decodedLayoutOptions,
      keyboard.tapDanceEntries,
      keyboard.comboEntries,
      keyboard.keyOverrideEntries,
      keyboard.altRepeatKeyEntries,
      deserializedMacros,
    ],
  )

  const fileIO = useFileIO({
    deviceUid: keyboard.uid,
    deviceName: `${deviceName}_current`,
    serialize: keyboard.serialize,
    serializeVialGui: keyboard.serializeVialGui,
    applyVilFile: keyboard.applyVilFile,
    keymapCGenerator,
    pdfGenerator,
  })
  const sideload = useSideloadJson(keyboard.applyDefinition)
  const layoutStore = useLayoutStore({
    deviceUid: keyboard.uid,
    deviceName,
    serialize: keyboard.serialize,
    applyVilFile: keyboard.applyVilFile,
  })
  const keymapEditorRef = useRef<KeymapEditorHandle>(null)
  const [showUnlockDialog, setShowUnlockDialog] = useState(false)
  const [unlockMacroWarning, setUnlockMacroWarning] = useState(false)
  const [matrixState, setMatrixState] = useState({ matrixMode: false, hasMatrixTester: false })
  const [keymapScale, setKeymapScale] = useState(1)

  const adjustKeymapScale = useCallback((delta: number) => {
    setKeymapScale((prev) => {
      const clamped = Math.max(0.3, Math.min(2.0, prev + delta))
      return Math.round(clamped * 10) / 10
    })
  }, [])

  const handleMatrixModeChange = useCallback((matrixMode: boolean, hasMatrixTester: boolean) => {
    setMatrixState({ matrixMode, hasMatrixTester })
  }, [])

  const comboTimeoutSupported = !device.isDummy && keyboard.supportedQsids.has(2)

  // Collect visible settings tab names for per-feature support checks
  const visibleSettingsNames = useMemo(() => {
    if (device.isDummy || keyboard.supportedQsids.size === 0) return new Set<string>()
    const tabs = (settingsDefs as { tabs: QmkSettingsTab[] }).tabs
    return new Set(
      tabs
        .filter((tab) => tab.fields.some((f) => keyboard.supportedQsids.has(f.qsid)))
        .map((tab) => tab.name),
    )
  }, [keyboard.supportedQsids, device.isDummy])

  const tapHoldSupported = visibleSettingsNames.has('Tap-Hold')
  const mouseKeysSupported = visibleSettingsNames.has('Mouse keys')
  const magicSupported = visibleSettingsNames.has('Magic')
  const graveEscapeSupported = visibleSettingsNames.has('Grave Escape')
  const autoShiftSupported = visibleSettingsNames.has('Auto Shift')
  const oneShotKeysSupported = visibleSettingsNames.has('One Shot Keys')
  const hasIntegratedSettings =
    tapHoldSupported || mouseKeysSupported || magicSupported ||
    graveEscapeSupported || autoShiftSupported || oneShotKeysSupported

  const lightingSupported = !device.isDummy && LIGHTING_TYPES.has(keyboard.definition?.lighting ?? '')

  const [typingTestMode, setTypingTestMode] = useState(false)

  const handleTypingTestModeChange = useCallback((enabled: boolean) => {
    setTypingTestMode(enabled)
    if (enabled) {
      setDualMode(false)
      setActivePane('primary')
    }
  }, [])

  const [dualMode, setDualMode] = useState(false)
  const [activePane, setActivePane] = useState<'primary' | 'secondary'>('primary')
  const [primaryLayer, setPrimaryLayer] = useState(0)
  const [secondaryLayer, setSecondaryLayer] = useState(0)

  const handleDualModeChange = useCallback((enabled: boolean) => {
    setDualMode(enabled)
    setActivePane('primary')
    if (enabled) setSecondaryLayer(primaryLayer)
  }, [primaryLayer])

  const currentLayer = dualMode && activePane === 'secondary' ? secondaryLayer : primaryLayer
  const setCurrentLayer = useCallback((l: number) => {
    if (dualMode && activePane === 'secondary') setSecondaryLayer(l)
    else setPrimaryLayer(l)
  }, [dualMode, activePane])

  const [fileSuccessKind, setFileSuccessKind] = useState<'import' | 'export' | null>(null)
  const [showLightingModal, setShowLightingModal] = useState(false)
  const [showComboModal, setShowComboModal] = useState(false)
  const [showAltRepeatKeyModal, setShowAltRepeatKeyModal] = useState(false)
  const [showKeyOverrideModal, setShowKeyOverrideModal] = useState(false)

  const showFileSuccess = useCallback((kind: 'import' | 'export') => {
    setFileSuccessKind(kind)
  }, [])

  const clearFileStatus = useCallback(() => {
    setFileSuccessKind(null)
  }, [])

  const fetchHubUser = useCallback(async () => {
    if (!appConfig.config.hubEnabled || !sync.authStatus.authenticated) return
    try {
      const result = await window.vialAPI.hubFetchAuthMe()
      if (result.success && result.user) {
        setHubDisplayName(result.user.display_name)
      }
    } catch {}
  }, [appConfig.config.hubEnabled, sync.authStatus.authenticated])

  const handleUpdateHubDisplayName = useCallback(async (name: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await window.vialAPI.hubPatchAuthMe(name)
      if (result.success && result.user) {
        setHubDisplayName(result.user.display_name)
        return { success: true }
      }
      return { success: false, error: result.error }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : undefined }
    }
  }, [])

  const clearHubPostsState = useCallback(() => {
    setHubMyPosts([])
    setHubMyPostsPagination(undefined)
    setHubConnected(false)
  }, [])

  const markAccountDeactivated = useCallback(() => {
    setHubAccountDeactivated(true)
    clearHubPostsState()
  }, [clearHubPostsState])

  const refreshHubMyPosts = useCallback(async (params?: HubFetchMyPostsParams) => {
    if (appConfig.config.hubEnabled && sync.authStatus.authenticated) {
      try {
        const result = await window.vialAPI.hubFetchMyPosts(params)
        if (result.success && Array.isArray(result.posts)) {
          setHubMyPosts(result.posts)
          setHubMyPostsPagination(result.pagination)
          setHubConnected(true)
          setHubAuthConflict(false)
          setHubAccountDeactivated(false)
          return
        }
        if (result.error === HUB_ERROR_DISPLAY_NAME_CONFLICT) {
          setHubAuthConflict(true)
          clearHubPostsState()
          return
        }
        if (result.error === HUB_ERROR_ACCOUNT_DEACTIVATED) {
          markAccountDeactivated()
          return
        }
      } catch {}
    }
    clearHubPostsState()
  }, [appConfig.config.hubEnabled, sync.authStatus.authenticated, clearHubPostsState, markAccountDeactivated])

  const refreshHubKeyboardPosts = useCallback(async () => {
    if (!appConfig.config.hubEnabled || !sync.authStatus.authenticated || !deviceName || device.isDummy) {
      setHubKeyboardPosts([])
      return
    }
    try {
      const result = await window.vialAPI.hubFetchMyKeyboardPosts(deviceName)
      setHubKeyboardPosts(result.success && result.posts ? result.posts : [])
    } catch {
      setHubKeyboardPosts([])
    }
  }, [appConfig.config.hubEnabled, sync.authStatus.authenticated, deviceName, device.isDummy])

  const refreshHubPosts = useCallback(async () => {
    // Fetch keyboard posts first so they are ready before hubConnected
    // is set to true inside refreshHubMyPosts (which gates hubReady).
    await refreshHubKeyboardPosts()
    await refreshHubMyPosts()
  }, [refreshHubMyPosts, refreshHubKeyboardPosts])

  const handleResolveAuthConflict = useCallback(async (name: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await window.vialAPI.hubSetAuthDisplayName(name)
      const result = await window.vialAPI.hubFetchAuthMe()
      if (!result.success) {
        return { success: false, error: result.error }
      }
      if (result.user) {
        setHubAuthConflict(false)
        setHubDisplayName(result.user.display_name)
        await refreshHubPosts()
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : undefined }
    } finally {
      await window.vialAPI.hubSetAuthDisplayName(null).catch(() => {})
    }
  }, [refreshHubPosts])

  const getHubPostId = useCallback((entry: { hubPostId?: string; label: string }): string | undefined => {
    return entry.hubPostId || hubKeyboardPosts.find((p) => p.title === entry.label)?.id
  }, [hubKeyboardPosts])

  const persistHubPostId = useCallback(async (entryId: string, postId: string | null) => {
    await window.vialAPI.snapshotStoreSetHubPostId(keyboard.uid, entryId, postId)
    await layoutStore.refreshEntries()
  }, [keyboard.uid, layoutStore])

  const handleHubRenamePost = useCallback(async (postId: string, newTitle: string) => {
    const result = await window.vialAPI.hubPatchPost({ postId, title: newTitle })
    if (!result.success) throw new Error(result.error ?? 'Rename failed')
    await refreshHubPosts()
  }, [refreshHubPosts])

  const handleHubDeletePost = useCallback(async (postId: string) => {
    const result = await window.vialAPI.hubDeletePost(postId)
    if (!result.success) throw new Error(result.error ?? 'Delete failed')
    await refreshHubPosts()
  }, [refreshHubPosts])

  // Auto-check Hub connectivity when auth status changes
  useEffect(() => {
    void refreshHubPosts()
    void fetchHubUser()
  }, [refreshHubPosts, fetchHubUser])

  const handleImportVil = useCallback(async () => {
    const ok = await fileIO.loadLayout()
    if (ok) showFileSuccess('import')
  }, [fileIO.loadLayout, showFileSuccess])

  const handleExportVil = useCallback(async () => {
    const ok = await fileIO.saveLayout()
    if (ok) showFileSuccess('export')
  }, [fileIO.saveLayout, showFileSuccess])

  const handleExportKeymapC = useCallback(async () => {
    const ok = await fileIO.exportKeymapC()
    if (ok) showFileSuccess('export')
  }, [fileIO.exportKeymapC, showFileSuccess])

  const handleExportPdf = useCallback(async () => {
    const ok = await fileIO.exportPdf()
    if (ok) showFileSuccess('export')
  }, [fileIO.exportPdf, showFileSuccess])

  const exportLayoutPdf = useCallback(async (
    generator: (input: LayoutPdfInput) => string,
    suffix: string,
  ) => {
    try {
      const parsedOptions = parseLayoutLabels(keyboard.definition?.layouts?.labels)
      const base64 = generator({
        deviceName,
        keys: keyboard.layout?.keys ?? [],
        layoutOptions: parsedOptions,
        currentValues: decodedLayoutOptions,
      })
      await window.vialAPI.exportPdf(base64, `${deviceName}_layout_${suffix}`)
    } catch {
      // Export errors are non-critical; file dialog handles user feedback
    }
  }, [keyboard.definition, keyboard.layout, decodedLayoutOptions, deviceName])

  const handleExportLayoutPdfAll = useCallback(
    () => exportLayoutPdf(generateAllLayoutOptionsPdf, 'all'),
    [exportLayoutPdf],
  )

  const handleExportLayoutPdfCurrent = useCallback(
    () => exportLayoutPdf(generateCurrentLayoutPdf, 'current'),
    [exportLayoutPdf],
  )

  function deriveFileStatus(): FileStatus {
    if (fileIO.loading) return 'importing'
    if (fileIO.saving) return 'exporting'
    if (fileSuccessKind === 'import') return { kind: 'success', message: t('fileIO.importSuccess') }
    if (fileSuccessKind === 'export') return { kind: 'success', message: t('fileIO.exportSuccess') }
    return 'idle'
  }
  const fileStatus = deriveFileStatus()

  const handleLoadEntry = useCallback(async (entryId: string) => {
    const entry = layoutStore.entries.find((e) => e.id === entryId)
    const ok = await layoutStore.loadLayout(entryId)
    if (ok) {
      setLastLoadedLabel(entry?.label ?? '')
      clearFileStatus()
    }
  }, [layoutStore, clearFileStatus])

  const loadEntryVilData = useCallback(async (entryId: string): Promise<VilFile | null> => {
    try {
      const result = await window.vialAPI.snapshotStoreLoad(keyboard.uid, entryId)
      if (!result.success || !result.data) return null
      const parsed: unknown = JSON.parse(result.data)
      if (!isVilFile(parsed)) return null
      return parsed
    } catch {
      return null
    }
  }, [keyboard.uid])

  const entryExportName = useCallback((entryId: string): string => {
    const entry = layoutStore.entries.find((e) => e.id === entryId)
    const suffix = entry?.label || entryId
    return `${deviceName}_${suffix}`
  }, [deviceName, layoutStore.entries])

  const buildEntryParams = useCallback((vilData: VilFile) => {
    const labels = keyboard.definition?.layouts?.labels
    return {
      layers: deriveLayerCount(vilData.keymap),
      keys: keyboard.layout?.keys ?? [],
      keymap: recordToMap(vilData.keymap),
      encoderLayout: recordToMap(vilData.encoderLayout),
      encoderCount: keyboard.encoderCount,
      layoutOptions: labels
        ? decodeLayoutOptions(vilData.layoutOptions, labels)
        : new Map<number, number>(),
      serializeKeycode,
      tapDance: vilData.tapDance,
      combo: vilData.combo,
      keyOverride: vilData.keyOverride,
      altRepeatKey: vilData.altRepeatKey,
      macros: vilData.macroJson
        ? vilData.macroJson.map((m) => jsonToMacroActions(JSON.stringify(m)) ?? [])
        : splitMacroBuffer(vilData.macros, keyboard.macroCount)
            .map((m) => deserializeMacro(m, keyboard.vialProtocol)),
    }
  }, [keyboard.definition, keyboard.layout, keyboard.encoderCount,
      keyboard.macroCount, keyboard.vialProtocol])

  const buildVilExportContext = useCallback((vilData: VilFile) => {
    const macroActions = splitMacroBuffer(vilData.macros, keyboard.macroCount)
      .map((m) => JSON.parse(macroActionsToJson(deserializeMacro(m, keyboard.vialProtocol))) as unknown[])
    return {
      rows: keyboard.rows,
      cols: keyboard.cols,
      layers: deriveLayerCount(vilData.keymap),
      encoderCount: keyboard.encoderCount,
      vialProtocol: keyboard.vialProtocol,
      viaProtocol: keyboard.viaProtocol,
      macroActions,
    }
  }, [keyboard.rows, keyboard.cols, keyboard.macroCount,
      keyboard.encoderCount, keyboard.vialProtocol, keyboard.viaProtocol])

  const handleExportEntryVil = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadEntryVilData(entryId)
      if (!vilData) return
      const json = vilToVialGuiJson(vilData, buildVilExportContext(vilData))
      await window.vialAPI.saveLayout(json, entryExportName(entryId))
    } catch {
      // Export errors are non-critical; file dialog handles user feedback
    }
  }, [loadEntryVilData, buildVilExportContext, entryExportName])

  const handleExportEntryKeymapC = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadEntryVilData(entryId)
      if (!vilData) return
      const content = generateKeymapC({ ...buildEntryParams(vilData), serializeKeycode: serializeForCExport })
      await window.vialAPI.exportKeymapC(content, entryExportName(entryId))
    } catch {
      // Export errors are non-critical; file dialog handles user feedback
    }
  }, [loadEntryVilData, buildEntryParams, entryExportName])

  const handleExportEntryPdf = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadEntryVilData(entryId)
      if (!vilData) return
      const exportName = entryExportName(entryId)
      const base64 = generateKeymapPdf({
        ...buildEntryParams(vilData),
        deviceName,
        keycodeLabel,
        isMask,
        findOuterKeycode,
        findInnerKeycode,
      })
      await window.vialAPI.exportPdf(base64, exportName)
    } catch {
      // Export errors are non-critical; file dialog handles user feedback
    }
  }, [loadEntryVilData, buildEntryParams, entryExportName, deviceName])

  const buildHubPostParams = useCallback(async (entry: { label: string }, vilData: VilFile) => {
    const params = buildEntryParams(vilData)
    const pdfBase64 = generateKeymapPdf({
      ...params,
      deviceName,
      keycodeLabel,
      isMask,
      findOuterKeycode,
      findInnerKeycode,
    })
    const thumbnailBase64 = await generatePdfThumbnail(pdfBase64)
    return {
      title: entry.label || deviceName,
      keyboardName: deviceName,
      vilJson: vilToVialGuiJson(vilData, buildVilExportContext(vilData)),
      keymapC: generateKeymapC({ ...params, serializeKeycode: serializeForCExport }),
      pdfBase64,
      thumbnailBase64,
    }
  }, [buildEntryParams, buildVilExportContext, deviceName])

  const hubReady = appConfig.config.hubEnabled && sync.authStatus.authenticated && hubConnected
  const hubCanUpload = hubReady && !!hubDisplayName?.trim()

  const runHubOperation = useCallback(async (
    entryId: string,
    findEntry: (entries: SnapshotMeta[]) => SnapshotMeta | undefined,
    operation: (entry: SnapshotMeta) => Promise<HubUploadResult>,
    successMsg: string,
    failMsg: string,
  ) => {
    if (hubUploadingRef.current) return
    hubUploadingRef.current = true

    const entry = findEntry(layoutStore.entries)
    if (!entry) { hubUploadingRef.current = false; return }

    setHubUploading(entryId)
    setHubUploadResult(null)
    try {
      const result = await operation(entry)
      if (result.success) {
        setHubUploadResult({ kind: 'success', message: successMsg, entryId })
      } else {
        let message: string
        if (result.error === HUB_ERROR_ACCOUNT_DEACTIVATED) {
          markAccountDeactivated()
          message = t('hub.accountDeactivated')
        } else if (result.error === HUB_ERROR_RATE_LIMITED) {
          message = t('hub.rateLimited')
        } else {
          message = result.error || failMsg
        }
        setHubUploadResult({ kind: 'error', message, entryId })
      }
    } catch {
      setHubUploadResult({ kind: 'error', message: failMsg, entryId })
    } finally {
      setHubUploading(null)
      hubUploadingRef.current = false
    }
  }, [layoutStore.entries, markAccountDeactivated, t])

  const handleUploadToHub = useCallback(async (entryId: string) => {
    await runHubOperation(
      entryId,
      (entries) => entries.find((e) => e.id === entryId),
      async (entry) => {
        const vilData = await loadEntryVilData(entryId)
        if (!vilData) return { success: false, error: t('hub.uploadFailed') }
        const postParams = await buildHubPostParams(entry, vilData)
        const result = await window.vialAPI.hubUploadPost(postParams)
        if (result.success) {
          if (result.postId) await persistHubPostId(entryId, result.postId)
          await refreshHubPosts()
        }
        return result
      },
      t('hub.uploadSuccess'),
      t('hub.uploadFailed'),
    )
  }, [runHubOperation, loadEntryVilData, buildHubPostParams, persistHubPostId, refreshHubPosts, t])

  const handleUpdateOnHub = useCallback(async (entryId: string) => {
    const entry = layoutStore.entries.find((e) => e.id === entryId)
    const postId = entry ? getHubPostId(entry) : undefined
    if (!entry || !postId) return

    await runHubOperation(
      entryId,
      () => entry,
      async () => {
        const vilData = await loadEntryVilData(entryId)
        if (!vilData) return { success: false, error: t('hub.updateFailed') }
        const postParams = await buildHubPostParams(entry, vilData)
        const result = await window.vialAPI.hubUpdatePost({ ...postParams, postId })
        if (result.success) await refreshHubPosts()
        return result
      },
      t('hub.updateSuccess'),
      t('hub.updateFailed'),
    )
  }, [runHubOperation, layoutStore.entries, loadEntryVilData, buildHubPostParams, getHubPostId, refreshHubPosts, t])

  const handleRemoveFromHub = useCallback(async (entryId: string) => {
    const entry = layoutStore.entries.find((e) => e.id === entryId)
    const postId = entry ? getHubPostId(entry) : undefined
    if (!entry || !postId) return

    await runHubOperation(
      entryId,
      () => entry,
      async () => {
        const result = await window.vialAPI.hubDeletePost(postId)
        if (result.success) {
          await persistHubPostId(entryId, null)
          await refreshHubPosts()
        }
        return result
      },
      t('hub.removeSuccess'),
      t('hub.removeFailed'),
    )
  }, [runHubOperation, layoutStore, getHubPostId, persistHubPostId, refreshHubPosts, t])

  const handleReuploadToHub = useCallback(async (entryId: string, orphanedPostId: string) => {
    await runHubOperation(
      entryId,
      (entries) => entries.find((e) => e.id === entryId),
      async (entry) => {
        await window.vialAPI.hubDeletePost(orphanedPostId).catch(() => {})
        const vilData = await loadEntryVilData(entryId)
        if (!vilData) return { success: false, error: t('hub.uploadFailed') }
        const postParams = await buildHubPostParams(entry, vilData)
        const result = await window.vialAPI.hubUploadPost(postParams)
        if (result.success) {
          if (result.postId) await persistHubPostId(entryId, result.postId)
          await refreshHubPosts()
        }
        return result
      },
      t('hub.uploadSuccess'),
      t('hub.uploadFailed'),
    )
  }, [runHubOperation, loadEntryVilData, buildHubPostParams, persistHubPostId, refreshHubPosts, t])

  const handleDeleteOrphanedHubPost = useCallback(async (entryId: string, orphanedPostId: string) => {
    await runHubOperation(
      entryId,
      (entries) => entries.find((e) => e.id === entryId),
      async () => {
        const result = await window.vialAPI.hubDeletePost(orphanedPostId)
        await refreshHubPosts()
        return result
      },
      t('hub.removeSuccess'),
      t('hub.removeFailed'),
    )
  }, [runHubOperation, refreshHubPosts, t])

  const handleOverwriteSave = useCallback(async (overwriteEntryId: string, label: string) => {
    const overwriteEntry = layoutStore.entries.find((e) => e.id === overwriteEntryId)
    const existingPostId = overwriteEntry ? getHubPostId(overwriteEntry) : undefined

    await layoutStore.deleteEntry(overwriteEntryId)
    const newEntryId = await layoutStore.saveLayout(label)
    if (!newEntryId) return

    if (existingPostId) {
      await persistHubPostId(newEntryId, existingPostId)

      if (hubReady) {
        await runHubOperation(
          newEntryId,
          () => ({ id: newEntryId, label, filename: '', savedAt: '', hubPostId: existingPostId }),
          async () => {
            const vilData = await loadEntryVilData(newEntryId)
            if (!vilData) return { success: false, error: t('hub.updateFailed') }
            const postParams = await buildHubPostParams({ label }, vilData)
            const result = await window.vialAPI.hubUpdatePost({ ...postParams, postId: existingPostId })
            if (result.success) await refreshHubPosts()
            return result
          },
          t('hub.updateSuccess'),
          t('hub.updateFailed'),
        )
      }
    }
  }, [layoutStore, getHubPostId, persistHubPostId, hubReady, runHubOperation, loadEntryVilData, buildHubPostParams, refreshHubPosts, t])

  // --- Favorite Hub upload handlers ---

  const persistFavHubPostId = useCallback(async (type: FavoriteType, entryId: string, postId: string | null) => {
    await window.vialAPI.favoriteStoreSetHubPostId(type, entryId, postId)
  }, [])

  function hubResultErrorMessage(result: HubUploadResult, fallbackKey: string): string {
    if (result.error === HUB_ERROR_ACCOUNT_DEACTIVATED) {
      markAccountDeactivated()
      return t('hub.accountDeactivated')
    }
    if (result.error === HUB_ERROR_RATE_LIMITED) return t('hub.rateLimited')
    return result.error || t(fallbackKey)
  }

  const runFavHubOperation = useCallback(async (
    type: FavoriteType,
    entryId: string,
    requireHubPostId: boolean,
    operation: (entry: SavedFavoriteMeta) => Promise<void>,
  ) => {
    if (favHubUploadingRef.current) return
    favHubUploadingRef.current = true

    const listResult = await window.vialAPI.favoriteStoreList(type)
    const entry = listResult.entries?.find((e: SavedFavoriteMeta) => e.id === entryId)
    if (!entry || (requireHubPostId && !entry.hubPostId)) {
      favHubUploadingRef.current = false
      return
    }

    setFavHubUploading(entryId)
    setFavHubUploadResult(null)
    try {
      await operation(entry)
    } finally {
      setFavHubUploading(null)
      favHubUploadingRef.current = false
    }
  }, [])

  const handleFavUploadToHub = useCallback(async (type: FavoriteType, entryId: string) => {
    await runFavHubOperation(type, entryId, false, async (entry) => {
      try {
        const result = await window.vialAPI.hubUploadFavoritePost({
          type, entryId, title: entry.label || type,
        })
        if (result.success) {
          if (result.postId) await persistFavHubPostId(type, entryId, result.postId)
          setFavHubUploadResult({ kind: 'success', message: t('hub.uploadSuccess'), entryId })
        } else {
          setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result, 'hub.uploadFailed'), entryId })
        }
      } catch {
        setFavHubUploadResult({ kind: 'error', message: t('hub.uploadFailed'), entryId })
      }
    })
  }, [runFavHubOperation, persistFavHubPostId, markAccountDeactivated, t])

  const handleFavUpdateOnHub = useCallback(async (type: FavoriteType, entryId: string) => {
    await runFavHubOperation(type, entryId, true, async (entry) => {
      try {
        const result = await window.vialAPI.hubUpdateFavoritePost({
          type, entryId, title: entry.label || type, postId: entry.hubPostId!,
        })
        if (result.success) {
          setFavHubUploadResult({ kind: 'success', message: t('hub.updateSuccess'), entryId })
        } else {
          setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result, 'hub.updateFailed'), entryId })
        }
      } catch {
        setFavHubUploadResult({ kind: 'error', message: t('hub.updateFailed'), entryId })
      }
    })
  }, [runFavHubOperation, persistFavHubPostId, markAccountDeactivated, t])

  const handleFavRemoveFromHub = useCallback(async (type: FavoriteType, entryId: string) => {
    await runFavHubOperation(type, entryId, true, async (entry) => {
      try {
        const result = await window.vialAPI.hubDeletePost(entry.hubPostId!)
        if (result.success) {
          await persistFavHubPostId(type, entryId, null)
          setFavHubUploadResult({ kind: 'success', message: t('hub.removeSuccess'), entryId })
        } else {
          setFavHubUploadResult({ kind: 'error', message: result.error || t('hub.removeFailed'), entryId })
        }
      } catch {
        setFavHubUploadResult({ kind: 'error', message: t('hub.removeFailed'), entryId })
      }
    })
  }, [runFavHubOperation, persistFavHubPostId, t])

  const handleFavRenameOnHub = useCallback(async (entryId: string, hubPostId: string, newLabel: string) => {
    if (!hubReady || favHubUploadingRef.current) return
    favHubUploadingRef.current = true
    setFavHubUploading(entryId)
    setFavHubUploadResult(null)
    try {
      const result = await window.vialAPI.hubPatchPost({ postId: hubPostId, title: newLabel })
      if (result.success) {
        setFavHubUploadResult({ kind: 'success', message: t('hub.hubSynced'), entryId })
      } else {
        setFavHubUploadResult({ kind: 'error', message: hubResultErrorMessage(result, 'hub.renameFailed'), entryId })
      }
    } catch {
      setFavHubUploadResult({ kind: 'error', message: t('hub.renameFailed'), entryId })
    } finally {
      setFavHubUploading(null)
      favHubUploadingRef.current = false
    }
  }, [hubReady, markAccountDeactivated, t])

  // True when keyboard sync is about to trigger but useEffect hasn't fired yet.
  // Bridges the 1-frame gap between UID publish and setDeviceSyncing(true).
  const phase2SyncPending = !deviceSyncing &&
    !!device.connectedDevice && !!keyboard.uid && keyboard.uid !== EMPTY_UID &&
    hasKeyboardSyncedRef.current !== keyboard.uid &&
    sync.config.autoSync && sync.authStatus.authenticated && sync.hasPassword && !sync.loading

  const comboSupported = !device.isDummy && keyboard.dynamicCounts.combo > 0
  const altRepeatKeySupported = !device.isDummy && keyboard.dynamicCounts.altRepeatKey > 0
  const keyOverrideSupported = !device.isDummy && keyboard.dynamicCounts.keyOverride > 0

  const handleDeleteEntry = useCallback(async (entryId: string) => {
    const entry = layoutStore.entries.find((e) => e.id === entryId)
    const postId = entry ? getHubPostId(entry) : undefined
    const deleted = await layoutStore.deleteEntry(entryId)
    if (deleted && postId && hubReady) {
      try {
        const result = await window.vialAPI.hubDeletePost(postId)
        if (result.success) await refreshHubPosts()
      } catch {
        // Hub deletion is best-effort; local entry is already removed
      }
    }
  }, [layoutStore, getHubPostId, hubReady, refreshHubPosts])

  const handleRenameEntry = useCallback(async (entryId: string, newLabel: string): Promise<boolean> => {
    const entry = layoutStore.entries.find((e) => e.id === entryId)
    const postId = entry ? getHubPostId(entry) : undefined
    const ok = await layoutStore.renameEntry(entryId, newLabel)
    if (ok && hubReady && postId) {
      void runHubOperation(
        entryId,
        (entries) => entries.find((e) => e.id === entryId),
        async () => {
          const result = await window.vialAPI.hubPatchPost({ postId, title: newLabel })
          if (result.success) await refreshHubPosts()
          return result
        },
        t('hub.hubSynced'),
        t('hub.renameFailed'),
      )
    }
    return ok
  }, [layoutStore, getHubPostId, hubReady, runHubOperation, refreshHubPosts, t])

  // Close modals when their feature support is lost
  useEffect(() => {
    if (!lightingSupported) setShowLightingModal(false)
    if (!comboSupported) setShowComboModal(false)
    if (!altRepeatKeySupported) setShowAltRepeatKeyModal(false)
    if (!keyOverrideSupported) setShowKeyOverrideModal(false)
  }, [lightingSupported, comboSupported, altRepeatKeySupported, keyOverrideSupported])

  const handleDisconnect = useCallback(async () => {
    try {
      await window.vialAPI.lock().catch(() => {})
      await device.disconnectDevice()
    } finally {
      keyboard.reset()
      setTypingTestMode(false)
      setPrimaryLayer(0)
      setSecondaryLayer(0)
      setDualMode(false)
      setActivePane('primary')
      setKeymapScale(1)
      setShowUnlockDialog(false)
      setUnlockMacroWarning(false)
      setFileSuccessKind(null)
      setLastLoadedLabel('')
      setMatrixState({ matrixMode: false, hasMatrixTester: false })
      setResettingKeyboard(false)
      setConfirmingResetKeyboard(false)
      setResetBusy(false)
      setDeviceLoadError(null)
      setHubConnected(false)
      setHubMyPosts([])
      setHubKeyboardPosts([])
    }
  }, [device.disconnectDevice, keyboard.reset])

  const handleConnect = useCallback(
    async (dev: DeviceInfo) => {
      setDummyError(null)
      setDeviceLoadError(null)
      const success = await device.connectDevice(dev)
      if (success) {
        const uid = await keyboard.reload()
        if (uid) {
          await devicePrefs.applyDevicePrefs(uid)
        } else {
          try { await handleDisconnect() } catch { /* cleanup best-effort */ }
          setDeviceLoadError(t('error.notVialCompatible'))
        }
      }
    },
    [device, keyboard, devicePrefs, handleDisconnect, t],
  )

  const handleLock = useCallback(async () => {
    await window.vialAPI.lock()
    await keyboard.refreshUnlockStatus()
  }, [keyboard])

  useAutoLock({
    unlocked: keyboard.unlockStatus.unlocked,
    autoLockMinutes: devicePrefs.autoLockTime,
    activityCounter: keyboard.activityCount,
    suspended: matrixState.matrixMode || typingTestMode,
    onLock: handleLock,
  })

  const handleOpenDataModal = useCallback(() => {
    setShowDataModal(true)
    if (!hasFavSyncedForDataRef.current &&
        sync.config.autoSync && sync.authStatus.authenticated && sync.hasPassword && !deviceSyncing) {
      hasFavSyncedForDataRef.current = true
      void sync.syncNow('download', 'favorites').catch(() => { hasFavSyncedForDataRef.current = false })
    }
  }, [sync.config.autoSync, sync.authStatus.authenticated, sync.hasPassword, sync.syncNow, deviceSyncing])

  const handleLoadDummy = useCallback(async () => {
    setDummyError(null)
    try {
      const result = await window.vialAPI.sideloadJson(t('app.loadDummy'))
      if (!result.success) {
        if (result.error !== 'cancelled') setDummyError(t('error.sideloadFailed'))
        return
      }
      if (!isKeyboardDefinition(result.data)) {
        setDummyError(t('error.sideloadInvalidDefinition'))
        return
      }
      device.connectDummy()
      keyboard.loadDummy(result.data)
    } catch {
      setDummyError(t('error.sideloadFailed'))
    }
  }, [device, keyboard, t])

  // Not connected: show device selector
  if (!device.connectedDevice) {
    return (
      <>
        {deviceSyncing && (
          <div className="fixed inset-0 z-50">
            <ConnectingOverlay deviceName="" deviceId="" syncProgress={sync.progress} syncOnly />
          </div>
        )}
        <DeviceSelector
          devices={device.devices}
          connecting={device.connecting}
          error={dummyError || device.error}
          onConnect={handleConnect}
          onLoadDummy={handleLoadDummy}
          onOpenSettings={() => setShowSettings(true)}
          onOpenData={handleOpenDataModal}
          syncStatus={sync.syncStatus}
          deviceWarning={deviceLoadError}
        />
        {showSettings && (
          <SettingsModal
            sync={sync}
            theme={themeCtx.theme}
            onThemeChange={themeCtx.setTheme}
            defaultLayout={devicePrefs.defaultLayout}
            onDefaultLayoutChange={devicePrefs.setDefaultLayout}
            defaultAutoAdvance={devicePrefs.defaultAutoAdvance}
            onDefaultAutoAdvanceChange={devicePrefs.setDefaultAutoAdvance}
            defaultLayerPanelOpen={devicePrefs.defaultLayerPanelOpen}
            onDefaultLayerPanelOpenChange={devicePrefs.setDefaultLayerPanelOpen}
            defaultBasicViewType={devicePrefs.defaultBasicViewType}
            onDefaultBasicViewTypeChange={devicePrefs.setDefaultBasicViewType}
            defaultSplitKeyMode={devicePrefs.defaultSplitKeyMode}
            onDefaultSplitKeyModeChange={devicePrefs.setDefaultSplitKeyMode}
            autoLockTime={devicePrefs.autoLockTime}
            onAutoLockTimeChange={devicePrefs.setAutoLockTime}
            onResetStart={() => setResettingData(true)}
            onResetEnd={() => setResettingData(false)}
            onClose={() => setShowSettings(false)}
            hubEnabled={appConfig.config.hubEnabled}
            onHubEnabledChange={(enabled) => appConfig.set('hubEnabled', enabled)}
            hubAuthenticated={sync.authStatus.authenticated}
            hubDisplayName={hubDisplayName}
            onHubDisplayNameChange={handleUpdateHubDisplayName}
            hubAuthConflict={hubAuthConflict}
            onResolveAuthConflict={handleResolveAuthConflict}
            hubAccountDeactivated={hubAccountDeactivated}
          />
        )}
        {showDataModal && (
          <DataModal
            onClose={() => setShowDataModal(false)}
            hubEnabled={appConfig.config.hubEnabled}
            hubAuthenticated={sync.authStatus.authenticated}
            hubPosts={hubMyPosts}
            hubPostsPagination={hubMyPostsPagination}
            onHubRefresh={refreshHubMyPosts}
            onHubRename={handleHubRenamePost}
            onHubDelete={handleHubDeletePost}
            hubOrigin={hubOrigin}
            hubNeedsDisplayName={hubReady && !hubCanUpload}
            hubFavUploading={favHubUploading}
            hubFavUploadResult={favHubUploadResult}
            onFavUploadToHub={hubCanUpload ? handleFavUploadToHub : undefined}
            onFavUpdateOnHub={hubCanUpload ? handleFavUpdateOnHub : undefined}
            onFavRemoveFromHub={hubReady ? handleFavRemoveFromHub : undefined}
            onFavRenameOnHub={hubReady ? handleFavRenameOnHub : undefined}
          />
        )}
        {startupNotification.visible && (
          <NotificationModal
            notifications={startupNotification.notifications}
            onClose={startupNotification.dismiss}
          />
        )}
      </>
    )
  }

  const api = window.vialAPI

  const importBtnClass = 'rounded-lg border border-edge bg-surface/30 px-3 py-1.5 text-xs font-semibold text-content-muted hover:text-content hover:border-content-muted'

  const toolsExtra = (
    <>
      {/* Import */}
      {(handleImportVil || (!device.isDummy && sideload.sideloadJson)) && (
        <div className={ROW_CLASS} data-testid="overlay-import-row">
          <span className="text-[13px] font-medium text-content">{t('layoutStore.import')}</span>
          <div className="flex gap-2">
            <button
              type="button"
              className={importBtnClass}
              onClick={handleImportVil}
              disabled={fileIO.saving || fileIO.loading}
              data-testid="overlay-import-vil"
            >
              {t('fileIO.loadLayout')}
            </button>
            {!device.isDummy && sideload.sideloadJson && (
              <button
                type="button"
                className={importBtnClass}
                onClick={sideload.sideloadJson}
                disabled={fileIO.saving || fileIO.loading}
                data-testid="overlay-sideload-json"
              >
                {t('fileIO.sideloadJson')}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )

  const dataPanel = (
    <div className="px-4 pb-3">
      <LayoutStoreContent
        entries={layoutStore.entries}
        loading={layoutStore.loading}
        saving={layoutStore.saving}
        fileStatus={fileStatus}
        isDummy={device.isDummy}
        defaultSaveLabel={lastLoadedLabel}
        onSave={layoutStore.saveLayout}
        onLoad={handleLoadEntry}
        onRename={handleRenameEntry}
        onDelete={handleDeleteEntry}
        onExportVil={handleExportVil}
        onExportKeymapC={handleExportKeymapC}
        onExportPdf={handleExportPdf}
        onExportEntryVil={!device.isDummy ? handleExportEntryVil : undefined}
        onExportEntryKeymapC={!device.isDummy ? handleExportEntryKeymapC : undefined}
        onExportEntryPdf={!device.isDummy ? handleExportEntryPdf : undefined}
        onOverwriteSave={handleOverwriteSave}
        onUploadToHub={hubCanUpload ? handleUploadToHub : undefined}
        onUpdateOnHub={hubCanUpload ? handleUpdateOnHub : undefined}
        onRemoveFromHub={hubReady ? handleRemoveFromHub : undefined}
        onReuploadToHub={hubCanUpload ? handleReuploadToHub : undefined}
        onDeleteOrphanedHubPost={hubReady ? handleDeleteOrphanedHubPost : undefined}
        keyboardName={deviceName}
        hubOrigin={hubReady ? hubOrigin : undefined}
        hubMyPosts={hubReady ? hubMyPosts : undefined}
        hubKeyboardPosts={hubReady ? hubKeyboardPosts : undefined}
        hubNeedsDisplayName={hubReady && !hubCanUpload}
        hubUploading={hubUploading}
        hubUploadResult={hubUploadResult}
        fileDisabled={fileIO.saving || fileIO.loading}
        listClassName="overflow-y-auto"
      />
    </div>
  )

  // Connected: show editor shell
  // KeymapEditor stays mounted (even during loading) across keyboard.reload(),
  // preserving state (e.g. pendingMatrix for deferred matrix mode entry after unlock).
  return (
    <div className="relative flex h-screen flex-col bg-surface text-content">
      {!keyboard.loading && (
        <>
          {device.isDummy && (
            <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
              {t('error.dummyMode')}
            </div>
          )}

          {!device.isDummy && keyboard.uid === EMPTY_UID && (
            <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
              {t('error.exampleUid')}
            </div>
          )}

          {keyboard.viaProtocol > 0 && keyboard.viaProtocol < 9 && (
            <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">
              {t('error.protocolVersion')}
            </div>
          )}

          {keyboard.connectionWarning && (
            <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
              {t(keyboard.connectionWarning)}
            </div>
          )}
        </>
      )}

      {(keyboard.loading || deviceSyncing || phase2SyncPending) && (
        <ConnectingOverlay
          deviceName={device.connectedDevice.productName || 'Unknown'}
          deviceId={formatDeviceId(device.connectedDevice)}
          loadingProgress={keyboard.loading ? keyboard.loadingProgress : undefined}
          syncProgress={deviceSyncing ? sync.progress : undefined}
          syncOnly={!keyboard.loading}
        />
      )}

      {resettingData && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface" data-testid="resetting-overlay">
          <div className="flex flex-col items-center gap-4">
            <div className="h-1 w-48 overflow-hidden rounded bg-surface-dim">
              <div className="h-full w-3/5 animate-pulse rounded bg-danger" />
            </div>
            <p className="text-sm font-medium text-content-secondary">
              {t('sync.resettingData')}
            </p>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4" data-testid="editor-content">
          <KeymapEditor
            ref={keymapEditorRef}
            layout={keyboard.layout}
            layers={keyboard.layers}
            currentLayer={currentLayer}
            onLayerChange={setCurrentLayer}
            keymap={keyboard.keymap}
            encoderLayout={keyboard.encoderLayout}
            encoderCount={keyboard.encoderCount}
            layoutOptions={decodedLayoutOptions}
            layoutLabels={keyboard.definition?.layouts?.labels}
            packedLayoutOptions={keyboard.layoutOptions}
            onSetLayoutOptions={keyboard.setLayoutOptions}
            remapLabel={devicePrefs.remapLabel}
            isRemapped={devicePrefs.isRemapped}
            onSetKey={keyboard.setKey}
            onSetKeysBulk={keyboard.setKeysBulk}
            onSetEncoder={keyboard.setEncoder}
            rows={keyboard.rows}
            cols={keyboard.cols}
            getMatrixState={!device.isDummy && keyboard.vialProtocol >= 3 ? api.getMatrixState : undefined}
            unlocked={keyboard.unlockStatus.unlocked}
            onUnlock={(options) => {
              setShowUnlockDialog(true)
              setUnlockMacroWarning(!!options?.macroWarning)
            }}
            tapDanceEntries={keyboard.tapDanceEntries}
            onSetTapDanceEntry={keyboard.setTapDanceEntry}
            macroCount={keyboard.macroCount}
            macroBufferSize={keyboard.macroBufferSize}
            macroBuffer={keyboard.macroBuffer}
            vialProtocol={keyboard.vialProtocol}
            parsedMacros={keyboard.parsedMacros}
            onSaveMacros={keyboard.setMacroBuffer}
            tapHoldSupported={tapHoldSupported}
            mouseKeysSupported={mouseKeysSupported}
            magicSupported={magicSupported}
            graveEscapeSupported={graveEscapeSupported}
            autoShiftSupported={autoShiftSupported}
            oneShotKeysSupported={oneShotKeysSupported}
            supportedQsids={hasIntegratedSettings ? keyboard.supportedQsids : undefined}
            qmkSettingsGet={hasIntegratedSettings ? api.qmkSettingsGet : undefined}
            qmkSettingsSet={hasIntegratedSettings ? api.qmkSettingsSet : undefined}
            qmkSettingsReset={hasIntegratedSettings ? api.qmkSettingsReset : undefined}
            onSettingsUpdate={hasIntegratedSettings ? keyboard.updateQmkSettingsValue : undefined}
            autoAdvance={devicePrefs.autoAdvance}
            onAutoAdvanceChange={devicePrefs.setAutoAdvance}
            basicViewType={devicePrefs.basicViewType}
            onBasicViewTypeChange={devicePrefs.setBasicViewType}
            splitKeyMode={devicePrefs.splitKeyMode}
            onSplitKeyModeChange={devicePrefs.setSplitKeyMode}
            keyboardLayout={devicePrefs.layout}
            onKeyboardLayoutChange={devicePrefs.setLayout}
            onLock={handleLock}
            onMatrixModeChange={handleMatrixModeChange}
            onOpenLighting={lightingSupported ? () => setShowLightingModal(true) : undefined}
            onOpenCombo={comboSupported ? () => setShowComboModal(true) : undefined}
            onOpenAltRepeatKey={altRepeatKeySupported ? () => setShowAltRepeatKeyModal(true) : undefined}
            onOpenKeyOverride={keyOverrideSupported ? () => setShowKeyOverrideModal(true) : undefined}
            layerNames={!device.isDummy ? keyboard.layerNames : undefined}
            onSetLayerName={!device.isDummy ? keyboard.setLayerName : undefined}
            toolsExtra={toolsExtra}
            dataPanel={dataPanel}
            onOverlayOpen={!device.isDummy ? layoutStore.refreshEntries : undefined}
            layerPanelOpen={devicePrefs.layerPanelOpen}
            onLayerPanelOpenChange={devicePrefs.setLayerPanelOpen}
            scale={keymapScale}
            onScaleChange={adjustKeymapScale}
            dualMode={dualMode}
            onDualModeChange={handleDualModeChange}
            activePane={activePane}
            onActivePaneChange={setActivePane}
            primaryLayer={primaryLayer}
            secondaryLayer={secondaryLayer}
            typingTestMode={typingTestMode}
            onTypingTestModeChange={handleTypingTestModeChange}
            onSaveTypingTestResult={devicePrefs.addTypingTestResult}
            typingTestHistory={devicePrefs.typingTestResults}
            typingTestConfig={devicePrefs.typingTestConfig}
            typingTestLanguage={devicePrefs.typingTestLanguage}
            onTypingTestConfigChange={devicePrefs.setTypingTestConfig}
            onTypingTestLanguageChange={devicePrefs.setTypingTestLanguage}
            deviceName={deviceName}
            isDummy={device.isDummy}
            onExportLayoutPdfAll={handleExportLayoutPdfAll}
            onExportLayoutPdfCurrent={handleExportLayoutPdfCurrent}
            favHubOrigin={hubReady ? hubOrigin : undefined}
            favHubNeedsDisplayName={hubReady && !hubCanUpload}
            favHubUploading={favHubUploading}
            favHubUploadResult={favHubUploadResult}
            onFavUploadToHub={hubCanUpload ? handleFavUploadToHub : undefined}
            onFavUpdateOnHub={hubCanUpload ? handleFavUpdateOnHub : undefined}
            onFavRemoveFromHub={hubReady ? handleFavRemoveFromHub : undefined}
            onFavRenameOnHub={hubReady ? handleFavRenameOnHub : undefined}
          />
        </div>

        {(fileIO.error || sideload.error || layoutStore.error) && (
          <div className="bg-danger/10 px-4 py-1.5 text-xs text-danger">
            {fileIO.error || sideload.error || layoutStore.error}
          </div>
        )}
      </div>

      <StatusBar
        deviceName={device.connectedDevice.productName || 'Unknown'}
        loadedLabel={lastLoadedLabel}
        autoAdvance={devicePrefs.autoAdvance}
        unlocked={keyboard.unlockStatus.unlocked}
        syncStatus={sync.syncStatus}
        hubConnected={sync.authStatus.authenticated ? hubConnected : undefined}
        matrixMode={matrixState.matrixMode}
        typingTestMode={typingTestMode}
        hasMatrixTester={matrixState.hasMatrixTester}
        comboActive={comboSupported && keyboard.comboEntries.some((e) => e.output !== 0)}
        altRepeatKeyActive={altRepeatKeySupported && keyboard.altRepeatKeyEntries.some((e) => e.enabled)}
        keyOverrideActive={keyOverrideSupported && keyboard.keyOverrideEntries.some((e) => e.enabled)}
        onTypingTestModeChange={() => keymapEditorRef.current?.toggleTypingTest()}
        onDisconnect={handleDisconnect}
      />

      {showUnlockDialog && !device.isDummy && (
        <UnlockDialog
          keys={keyboard.layout?.keys ?? []}
          unlockKeys={keyboard.unlockStatus.keys}
          layoutOptions={decodedLayoutOptions}
          unlockStart={api.unlockStart}
          unlockPoll={api.unlockPoll}
          onComplete={async () => {
            setShowUnlockDialog(false)
            setUnlockMacroWarning(false)
            await keyboard.refreshUnlockStatus()
          }}
          macroWarning={unlockMacroWarning}
        />
      )}

      {showLightingModal && lightingSupported && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          data-testid="lighting-modal-backdrop"
          onClick={() => setShowLightingModal(false)}
        >
          <div
            className="w-[500px] max-w-[90vw] max-h-[80vh] overflow-y-auto rounded-lg bg-surface-alt p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">{t('editor.lighting.title')}</h3>
              <ModalCloseButton testid="lighting-modal-close" onClick={() => setShowLightingModal(false)} />
            </div>
            <RGBConfigurator
              lightingType={keyboard.definition?.lighting}
              backlightBrightness={keyboard.backlightBrightness}
              backlightEffect={keyboard.backlightEffect}
              rgblightBrightness={keyboard.rgblightBrightness}
              rgblightEffect={keyboard.rgblightEffect}
              rgblightEffectSpeed={keyboard.rgblightEffectSpeed}
              rgblightHue={keyboard.rgblightHue}
              rgblightSat={keyboard.rgblightSat}
              vialRGBVersion={keyboard.vialRGBVersion}
              vialRGBMode={keyboard.vialRGBMode}
              vialRGBSpeed={keyboard.vialRGBSpeed}
              vialRGBHue={keyboard.vialRGBHue}
              vialRGBSat={keyboard.vialRGBSat}
              vialRGBVal={keyboard.vialRGBVal}
              vialRGBMaxBrightness={keyboard.vialRGBMaxBrightness}
              vialRGBSupported={keyboard.vialRGBSupported}
              onSetBacklightBrightness={keyboard.setBacklightBrightness}
              onSetBacklightEffect={keyboard.setBacklightEffect}
              onSetRgblightBrightness={keyboard.setRgblightBrightness}
              onSetRgblightEffect={keyboard.setRgblightEffect}
              onSetRgblightEffectSpeed={keyboard.setRgblightEffectSpeed}
              onSetRgblightColor={keyboard.setRgblightColor}
              onSetVialRGBMode={keyboard.setVialRGBMode}
              onSetVialRGBSpeed={keyboard.setVialRGBSpeed}
              onSetVialRGBColor={keyboard.setVialRGBColor}
              onSetVialRGBBrightness={keyboard.setVialRGBBrightness}
              onSetVialRGBHSV={keyboard.setVialRGBHSV}
              onSave={api.saveLighting}
            />
          </div>
        </div>
      )}

      {showComboModal && comboSupported && (
        <ComboPanelModal
          entries={keyboard.comboEntries}
          onSetEntry={keyboard.setComboEntry}
          unlocked={keyboard.unlockStatus.unlocked}
          onUnlock={() => setShowUnlockDialog(true)}
          qmkSettingsGet={comboTimeoutSupported ? api.qmkSettingsGet : undefined}
          qmkSettingsSet={comboTimeoutSupported ? api.qmkSettingsSet : undefined}
          onSettingsUpdate={comboTimeoutSupported ? keyboard.updateQmkSettingsValue : undefined}
          tapDanceEntries={keyboard.tapDanceEntries}
          deserializedMacros={deserializedMacros}
          onClose={() => setShowComboModal(false)}
          hubOrigin={hubReady ? hubOrigin : undefined}
          hubNeedsDisplayName={hubReady && !hubCanUpload}
          hubUploading={favHubUploading}
          hubUploadResult={favHubUploadResult}
          onUploadToHub={hubCanUpload ? (entryId) => handleFavUploadToHub('combo', entryId) : undefined}
          onUpdateOnHub={hubCanUpload ? (entryId) => handleFavUpdateOnHub('combo', entryId) : undefined}
          onRemoveFromHub={hubReady ? (entryId) => handleFavRemoveFromHub('combo', entryId) : undefined}
          onRenameOnHub={hubReady ? handleFavRenameOnHub : undefined}
        />
      )}

      {showAltRepeatKeyModal && altRepeatKeySupported && (
        <AltRepeatKeyPanelModal
          entries={keyboard.altRepeatKeyEntries}
          onSetEntry={keyboard.setAltRepeatKeyEntry}
          unlocked={keyboard.unlockStatus.unlocked}
          onUnlock={() => setShowUnlockDialog(true)}
          tapDanceEntries={keyboard.tapDanceEntries}
          deserializedMacros={deserializedMacros}
          onClose={() => setShowAltRepeatKeyModal(false)}
          hubOrigin={hubReady ? hubOrigin : undefined}
          hubNeedsDisplayName={hubReady && !hubCanUpload}
          hubUploading={favHubUploading}
          hubUploadResult={favHubUploadResult}
          onUploadToHub={hubCanUpload ? (entryId) => handleFavUploadToHub('altRepeatKey', entryId) : undefined}
          onUpdateOnHub={hubCanUpload ? (entryId) => handleFavUpdateOnHub('altRepeatKey', entryId) : undefined}
          onRemoveFromHub={hubReady ? (entryId) => handleFavRemoveFromHub('altRepeatKey', entryId) : undefined}
          onRenameOnHub={hubReady ? handleFavRenameOnHub : undefined}
        />
      )}

      {showKeyOverrideModal && keyOverrideSupported && (
        <KeyOverridePanelModal
          entries={keyboard.keyOverrideEntries}
          onSetEntry={keyboard.setKeyOverrideEntry}
          unlocked={keyboard.unlockStatus.unlocked}
          onUnlock={() => setShowUnlockDialog(true)}
          tapDanceEntries={keyboard.tapDanceEntries}
          deserializedMacros={deserializedMacros}
          onClose={() => setShowKeyOverrideModal(false)}
          hubOrigin={hubReady ? hubOrigin : undefined}
          hubNeedsDisplayName={hubReady && !hubCanUpload}
          hubUploading={favHubUploading}
          hubUploadResult={favHubUploadResult}
          onUploadToHub={hubCanUpload ? (entryId) => handleFavUploadToHub('keyOverride', entryId) : undefined}
          onUpdateOnHub={hubCanUpload ? (entryId) => handleFavUpdateOnHub('keyOverride', entryId) : undefined}
          onRemoveFromHub={hubReady ? (entryId) => handleFavRemoveFromHub('keyOverride', entryId) : undefined}
          onRenameOnHub={hubReady ? handleFavRenameOnHub : undefined}
        />
      )}

      {startupNotification.visible && (
        <NotificationModal
          notifications={startupNotification.notifications}
          onClose={startupNotification.dismiss}
        />
      )}
    </div>
  )
}
