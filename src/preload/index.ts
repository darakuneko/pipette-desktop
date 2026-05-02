import { contextBridge, ipcRenderer } from 'electron'
import {
  listDevices,
  openHidDevice,
  closeHidDevice,
  isDeviceOpen,
  probeDevice,
} from './hid-transport'
import * as protocol from './protocol'
import { IpcChannels } from '../shared/ipc/channels'
import type { DeviceInfo, KeyboardDefinition, ProbeResult } from '../shared/types/protocol'
import type { SnapshotMeta } from '../shared/types/snapshot-store'
import type { AnalyzeFilterSnapshotMeta } from '../shared/types/analyze-filter-store'
import type { SavedFavoriteMeta, FavoriteImportResult } from '../shared/types/favorite-store'
import type { KeyLabelMeta, KeyLabelRecord, KeyLabelStoreResult } from '../shared/types/key-label-store'
import type { HubKeyLabelItem, HubKeyLabelListResponse, HubKeyLabelListParams } from '../shared/types/hub-key-label'
import type { AppConfig } from '../shared/types/app-config'
import type { DeviceScope } from '../shared/types/analyze-filters'
import type { SyncAuthStatus, SyncProgress, PasswordStrength, SyncResetTargets, LocalResetTargets, UndecryptableFile, SyncDataScanResult, SyncScope, StoredKeyboardInfo, SyncOperationResult } from '../shared/types/sync'
import type { PipetteSettings } from '../shared/types/pipette-settings'
import type {
  LayoutComparisonOptions,
  LayoutComparisonResult,
  TypingActivityCell,
  TypingAnalyticsDeviceInfoBundle,
  TypingAnalyticsEvent,
  TypingDailySummary,
  TypingHeatmapByCell,
  TypingIntervalDailySummary,
  TypingKeyboardSummary,
  TypingKeymapSnapshot,
  TypingKeymapSnapshotSummary,
  TypingLayerUsageRow,
  TypingMatrixCellRow,
  TypingMatrixCellDailyRow,
  TypingMinuteStatsRow,
  TypingSessionRow,
  TypingBksMinuteRow,
  TypingTombstoneResult,
  PeakRecords,
  TypingBigramAggregateOptions,
  TypingBigramAggregateResult,
  TypingBigramAggregateView,
} from '../shared/types/typing-analytics'
import type { LanguageListEntry } from '../shared/types/language-store'
import type { HubUploadPostParams, HubUpdatePostParams, HubPatchPostParams, HubUploadResult, HubDeleteResult, HubFetchMyPostsResult, HubFetchMyPostsParams, HubFetchMyKeyboardPostsResult, HubUserResult, HubUploadFavoritePostParams, HubUpdateFavoritePostParams } from '../shared/types/hub'
import type { NotificationFetchResult } from '../shared/types/notification'

/**
 * API exposed to renderer via contextBridge.
 *
 * Architecture: HID communication goes through IPC to main process (node-hid).
 * Protocol logic runs in preload; raw HID I/O runs in main.
 */
const vialAPI = {
  // --- Device Management (node-hid via IPC) ---
  listDevices: (): Promise<DeviceInfo[]> => listDevices(),
  openDevice: (vendorId: number, productId: number): Promise<boolean> =>
    openHidDevice(vendorId, productId),
  closeDevice: (): Promise<void> => closeHidDevice(),
  isDeviceOpen: (): Promise<boolean> => isDeviceOpen(),
  probeDevice: (vendorId: number, productId: number, serialNumber?: string): Promise<ProbeResult> =>
    probeDevice(vendorId, productId, serialNumber),

  // --- VIA Protocol ---
  getProtocolVersion: (): Promise<number> => protocol.getProtocolVersion(),
  getLayerCount: (): Promise<number> => protocol.getLayerCount(),
  getKeymapBuffer: (offset: number, size: number): Promise<number[]> =>
    protocol.getKeymapBuffer(offset, size),
  setKeycode: (layer: number, row: number, col: number, keycode: number): Promise<void> =>
    protocol.setKeycode(layer, row, col, keycode),
  getLayoutOptions: (): Promise<number> => protocol.getLayoutOptions(),
  setLayoutOptions: (options: number): Promise<void> => protocol.setLayoutOptions(options),

  // --- Vial Protocol ---
  getKeyboardId: (): Promise<{ vialProtocol: number; uid: string }> =>
    protocol.getKeyboardId(),
  getDefinitionSize: (): Promise<number> => protocol.getDefinitionSize(),
  getDefinitionRaw: (size: number): Promise<number[]> =>
    protocol.getDefinitionRaw(size).then((buf) => Array.from(buf)),
  getDefinition: async (): Promise<KeyboardDefinition | null> => {
    try {
      const size = await protocol.getDefinitionSize()
      const raw = await protocol.getDefinitionRaw(size)
      const input = Array.from(raw)
      const result: string | null = await ipcRenderer.invoke(IpcChannels.LZMA_DECOMPRESS, input)
      if (result === null) {
        console.warn('LZMA decompression failed')
        return null
      }
      try {
        return JSON.parse(result) as KeyboardDefinition
      } catch {
        console.warn('Failed to parse definition JSON')
        return null
      }
    } catch (err) {
      console.warn('Failed to fetch definition:', err)
      return null
    }
  },
  getEncoder: (layer: number, index: number): Promise<[number, number]> =>
    protocol.getEncoder(layer, index),
  setEncoder: (layer: number, index: number, direction: number, keycode: number): Promise<void> =>
    protocol.setEncoder(layer, index, direction, keycode),

  // --- Macro ---
  getMacroCount: (): Promise<number> => protocol.getMacroCount(),
  getMacroBufferSize: (): Promise<number> => protocol.getMacroBufferSize(),
  getMacroBuffer: (totalSize: number): Promise<number[]> =>
    protocol.getMacroBuffer(totalSize),
  setMacroBuffer: (data: number[]): Promise<void> => protocol.setMacroBuffer(data),

  // --- Lighting ---
  getLightingValue: (id: number): Promise<number[]> => protocol.getLightingValue(id),
  setLightingValue: (id: number, ...args: number[]): Promise<void> =>
    protocol.setLightingValue(id, ...args),
  saveLighting: (): Promise<void> => protocol.saveLighting(),

  // --- VialRGB ---
  getVialRGBInfo: (): Promise<{ version: number; maxBrightness: number }> =>
    protocol.getVialRGBInfo(),
  getVialRGBMode: (): Promise<{ mode: number; speed: number; hue: number; sat: number; val: number }> =>
    protocol.getVialRGBMode(),
  getVialRGBSupported: (): Promise<number[]> =>
    protocol.getVialRGBSupported().then((s) => Array.from(s)),
  setVialRGBMode: (mode: number, speed: number, hue: number, sat: number, val: number): Promise<void> =>
    protocol.setVialRGBMode(mode, speed, hue, sat, val),

  // --- Lock/Unlock ---
  getUnlockStatus: (): Promise<{ unlocked: boolean; inProgress: boolean; keys: [number, number][] }> =>
    protocol.getUnlockStatus(),
  unlockStart: (): Promise<void> => protocol.unlockStart(),
  unlockPoll: (): Promise<number[]> => protocol.unlockPoll(),
  lock: (): Promise<void> => protocol.lock(),

  // --- Dynamic Entries ---
  getDynamicEntryCount: (): Promise<{ tapDance: number; combo: number; keyOverride: number; altRepeatKey: number; featureFlags: number }> =>
    protocol.getDynamicEntryCount(),
  getTapDance: (index: number): Promise<unknown> => protocol.getTapDance(index),
  setTapDance: (index: number, entry: unknown): Promise<void> =>
    protocol.setTapDance(index, entry as Parameters<typeof protocol.setTapDance>[1]),
  getCombo: (index: number): Promise<unknown> => protocol.getCombo(index),
  setCombo: (index: number, entry: unknown): Promise<void> =>
    protocol.setCombo(index, entry as Parameters<typeof protocol.setCombo>[1]),
  getKeyOverride: (index: number): Promise<unknown> => protocol.getKeyOverride(index),
  setKeyOverride: (index: number, entry: unknown): Promise<void> =>
    protocol.setKeyOverride(index, entry as Parameters<typeof protocol.setKeyOverride>[1]),
  getAltRepeatKey: (index: number): Promise<unknown> => protocol.getAltRepeatKey(index),
  setAltRepeatKey: (index: number, entry: unknown): Promise<void> =>
    protocol.setAltRepeatKey(index, entry as Parameters<typeof protocol.setAltRepeatKey>[1]),

  // --- QMK Settings ---
  qmkSettingsQuery: (startId: number): Promise<number[]> =>
    protocol.qmkSettingsQuery(startId),
  qmkSettingsGet: (qsid: number): Promise<number[]> => protocol.qmkSettingsGet(qsid),
  qmkSettingsSet: (qsid: number, data: number[]): Promise<void> =>
    protocol.qmkSettingsSet(qsid, data),
  qmkSettingsReset: (): Promise<void> => protocol.qmkSettingsReset(),

  // --- Matrix Tester ---
  getMatrixState: (): Promise<number[]> => protocol.getMatrixState(),

  // --- File I/O (IPC to main for native file dialogs) ---
  saveLayout: (json: string, deviceName?: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_SAVE_LAYOUT, json, deviceName),
  loadLayout: (title?: string, extensions?: string[]): Promise<{ success: boolean; data?: string; filePath?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_LOAD_LAYOUT, title, extensions),
  exportKeymapC: (content: string, deviceName?: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_EXPORT_KEYMAP_C, content, deviceName),
  exportPdf: (base64Data: string, deviceName?: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_EXPORT_PDF, base64Data, deviceName),
  exportCsv: (content: string, defaultName?: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_EXPORT_CSV, content, defaultName),
  exportCsvBundle: (
    files: ReadonlyArray<{ name: string; content: string }>,
  ): Promise<{ success: boolean; dirPath?: string; files?: string[]; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_EXPORT_CSV_BUNDLE, files),
  exportJson: (content: string, defaultName?: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_EXPORT_JSON, content, defaultName),
  sideloadJson: (title?: string): Promise<{ success: boolean; data?: unknown; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SIDELOAD_JSON, title),

  // --- Snapshot Store (internal save/load via IPC) ---
  snapshotStoreList: (uid: string): Promise<{ success: boolean; entries?: SnapshotMeta[]; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_LIST, uid),
  snapshotStoreSave: (uid: string, json: string, deviceName: string, label: string, vilVersion?: number): Promise<{ success: boolean; entry?: SnapshotMeta; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_SAVE, uid, json, deviceName, label, vilVersion),
  snapshotStoreLoad: (uid: string, entryId: string): Promise<{ success: boolean; data?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_LOAD, uid, entryId),
  snapshotStoreUpdate: (uid: string, entryId: string, json: string, vilVersion?: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_UPDATE, uid, entryId, json, vilVersion),
  snapshotStoreRename: (uid: string, entryId: string, newLabel: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_RENAME, uid, entryId, newLabel),
  snapshotStoreDelete: (uid: string, entryId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_DELETE, uid, entryId),

  // --- Analyze Filter Store (per-keyboard search-condition snapshots) ---
  analyzeFilterStoreList: (uid: string): Promise<{ success: boolean; entries?: AnalyzeFilterSnapshotMeta[]; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.ANALYZE_FILTER_STORE_LIST, uid),
  analyzeFilterStoreSave: (uid: string, json: string, label: string, summary?: string): Promise<{ success: boolean; entry?: AnalyzeFilterSnapshotMeta; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.ANALYZE_FILTER_STORE_SAVE, uid, json, label, summary),
  analyzeFilterStoreLoad: (uid: string, entryId: string): Promise<{ success: boolean; data?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.ANALYZE_FILTER_STORE_LOAD, uid, entryId),
  analyzeFilterStoreUpdate: (uid: string, entryId: string, json: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.ANALYZE_FILTER_STORE_UPDATE, uid, entryId, json),
  analyzeFilterStoreRename: (uid: string, entryId: string, newLabel: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.ANALYZE_FILTER_STORE_RENAME, uid, entryId, newLabel),
  analyzeFilterStoreDelete: (uid: string, entryId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.ANALYZE_FILTER_STORE_DELETE, uid, entryId),

  // --- Favorite Store (internal save/load via IPC) ---
  favoriteStoreList: (type: string): Promise<{ success: boolean; entries?: SavedFavoriteMeta[]; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FAVORITE_STORE_LIST, type),
  favoriteStoreSave: (type: string, json: string, label: string): Promise<{ success: boolean; entry?: SavedFavoriteMeta; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FAVORITE_STORE_SAVE, type, json, label),
  favoriteStoreLoad: (type: string, entryId: string): Promise<{ success: boolean; data?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FAVORITE_STORE_LOAD, type, entryId),
  favoriteStoreRename: (type: string, entryId: string, newLabel: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FAVORITE_STORE_RENAME, type, entryId, newLabel),
  favoriteStoreDelete: (type: string, entryId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FAVORITE_STORE_DELETE, type, entryId),
  favoriteStoreExport: (scope: string, vialProtocol: number, entryId?: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FAVORITE_STORE_EXPORT, scope, vialProtocol, entryId),
  favoriteStoreExportCurrent: (scope: string, vialProtocol: number, data: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FAVORITE_STORE_EXPORT_CURRENT, scope, vialProtocol, data),
  favoriteStoreImport: (): Promise<FavoriteImportResult> =>
    ipcRenderer.invoke(IpcChannels.FAVORITE_STORE_IMPORT),
  favoriteStoreImportToCurrent: (scope: string): Promise<{ success: boolean; data?: unknown; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FAVORITE_STORE_IMPORT_TO_CURRENT, scope),

  // --- Key Label Store (local) ---
  keyLabelStoreList: (): Promise<KeyLabelStoreResult<KeyLabelMeta[]>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_STORE_LIST),
  keyLabelStoreListAll: (): Promise<KeyLabelStoreResult<KeyLabelMeta[]>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_STORE_LIST_ALL),
  keyLabelStoreGet: (id: string): Promise<KeyLabelStoreResult<KeyLabelRecord>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_STORE_GET, id),
  keyLabelStoreRename: (id: string, newName: string): Promise<KeyLabelStoreResult<KeyLabelMeta>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_STORE_RENAME, id, newName),
  keyLabelStoreDelete: (id: string): Promise<KeyLabelStoreResult<void>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_STORE_DELETE, id),
  keyLabelStoreImport: (): Promise<KeyLabelStoreResult<KeyLabelMeta>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_STORE_IMPORT),
  keyLabelStoreExport: (id: string): Promise<KeyLabelStoreResult<{ filePath: string }>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_STORE_EXPORT, id),
  keyLabelStoreReorder: (orderedIds: string[]): Promise<KeyLabelStoreResult<void>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_STORE_REORDER, orderedIds),
  keyLabelStoreSetHubPostId: (id: string, hubPostId: string | null): Promise<KeyLabelStoreResult<KeyLabelMeta>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_STORE_SET_HUB_POST_ID, id, hubPostId),
  keyLabelStoreHasName: (name: string, excludeId?: string): Promise<KeyLabelStoreResult<boolean>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_STORE_HAS_NAME, name, excludeId),

  // --- Key Label Hub ---
  keyLabelHubList: (params?: HubKeyLabelListParams): Promise<KeyLabelStoreResult<HubKeyLabelListResponse>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_HUB_LIST, params),
  keyLabelHubDetail: (hubPostId: string): Promise<KeyLabelStoreResult<HubKeyLabelItem>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_HUB_DETAIL, hubPostId),
  keyLabelHubDownload: (hubPostId: string): Promise<KeyLabelStoreResult<KeyLabelMeta>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_HUB_DOWNLOAD, hubPostId),
  keyLabelHubUpload: (localId: string): Promise<KeyLabelStoreResult<KeyLabelMeta>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_HUB_UPLOAD, localId),
  keyLabelHubUpdate: (localId: string): Promise<KeyLabelStoreResult<KeyLabelMeta>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_HUB_UPDATE, localId),
  keyLabelHubDelete: (localId: string): Promise<KeyLabelStoreResult<void>> =>
    ipcRenderer.invoke(IpcChannels.KEY_LABEL_HUB_DELETE, localId),

  // --- Pipette Settings Store (internal save/load via IPC) ---
  pipetteSettingsGet: (uid: string): Promise<PipetteSettings | null> =>
    ipcRenderer.invoke(IpcChannels.PIPETTE_SETTINGS_GET, uid),
  pipetteSettingsSet: (uid: string, prefs: PipetteSettings): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.PIPETTE_SETTINGS_SET, uid, prefs),

  // --- Typing Analytics (fire-and-forget event dispatch) ---
  typingAnalyticsEvent: (event: TypingAnalyticsEvent): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_EVENT, event),
  typingAnalyticsFlush: (uid: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_FLUSH, uid),
  typingAnalyticsListAppsForRange: (
    uid: string,
    sinceMs: number,
    untilMs: number,
    scope: unknown,
  ): Promise<{ name: string; keystrokes: number; activeMs: number }[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_APPS_FOR_RANGE, uid, sinceMs, untilMs, scope),
  typingAnalyticsGetAppUsageForRange: (
    uid: string,
    sinceMs: number,
    untilMs: number,
    scope: unknown,
  ): Promise<{ name: string; keystrokes: number; activeMs: number }[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_GET_APP_USAGE_FOR_RANGE, uid, sinceMs, untilMs, scope),
  typingAnalyticsGetWpmByAppForRange: (
    uid: string,
    sinceMs: number,
    untilMs: number,
    scope: unknown,
  ): Promise<{ name: string; keystrokes: number; activeMs: number }[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_GET_WPM_BY_APP_FOR_RANGE, uid, sinceMs, untilMs, scope),
  typingAnalyticsListKeyboards: (): Promise<TypingKeyboardSummary[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_KEYBOARDS),
  typingAnalyticsListItems: (uid: string, appScopes: string[] = []): Promise<TypingDailySummary[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_ITEMS, uid, appScopes),
  typingAnalyticsDeleteItems: (uid: string, dates: string[]): Promise<TypingTombstoneResult> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_DELETE_ITEMS, uid, dates),
  typingAnalyticsDeleteAll: (uid: string): Promise<TypingTombstoneResult> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_DELETE_ALL, uid),
  typingAnalyticsGetMatrixHeatmap: (
    uid: string,
    layer: number,
    sinceMs: number,
  ): Promise<TypingHeatmapByCell> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_GET_MATRIX_HEATMAP, uid, layer, sinceMs),
  typingAnalyticsListItemsLocal: (uid: string, appScopes: string[] = []): Promise<TypingDailySummary[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_ITEMS_LOCAL, uid, appScopes),
  typingAnalyticsListDeviceInfos: (uid: string): Promise<TypingAnalyticsDeviceInfoBundle | null> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_DEVICE_INFOS, uid),
  typingAnalyticsListItemsForHash: (uid: string, machineHash: string, appScopes: string[] = []): Promise<TypingDailySummary[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_ITEMS_FOR_HASH, uid, machineHash, appScopes),
  typingAnalyticsListIntervalItems: (uid: string): Promise<TypingIntervalDailySummary[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_INTERVAL_ITEMS, uid),
  typingAnalyticsListIntervalItemsLocal: (uid: string): Promise<TypingIntervalDailySummary[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_INTERVAL_ITEMS_LOCAL, uid),
  typingAnalyticsListIntervalItemsForHash: (uid: string, machineHash: string): Promise<TypingIntervalDailySummary[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_INTERVAL_ITEMS_FOR_HASH, uid, machineHash),
  typingAnalyticsListActivityGrid: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingActivityCell[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_ACTIVITY_GRID, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListActivityGridLocal: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingActivityCell[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_ACTIVITY_GRID_LOCAL, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListActivityGridForHash: (uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingActivityCell[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_ACTIVITY_GRID_FOR_HASH, uid, machineHash, sinceMs, untilMs, appScopes),
  typingAnalyticsListLayerUsage: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingLayerUsageRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_LAYER_USAGE, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListLayerUsageLocal: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingLayerUsageRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_LAYER_USAGE_LOCAL, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListLayerUsageForHash: (uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingLayerUsageRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_LAYER_USAGE_FOR_HASH, uid, machineHash, sinceMs, untilMs, appScopes),
  typingAnalyticsListMatrixCells: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingMatrixCellRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListMatrixCellsLocal: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingMatrixCellRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_LOCAL, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListMatrixCellsForHash: (uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingMatrixCellRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_FOR_HASH, uid, machineHash, sinceMs, untilMs, appScopes),
  typingAnalyticsListMatrixCellsByDay: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingMatrixCellDailyRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListMatrixCellsByDayLocal: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingMatrixCellDailyRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY_LOCAL, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListMatrixCellsByDayForHash: (uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingMatrixCellDailyRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY_FOR_HASH, uid, machineHash, sinceMs, untilMs, appScopes),
  typingAnalyticsListMinuteStats: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingMinuteStatsRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_MINUTE_STATS, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListMinuteStatsLocal: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingMinuteStatsRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_MINUTE_STATS_LOCAL, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListMinuteStatsForHash: (uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingMinuteStatsRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_MINUTE_STATS_FOR_HASH, uid, machineHash, sinceMs, untilMs, appScopes),
  typingAnalyticsListSessions: (uid: string, sinceMs: number, untilMs: number): Promise<TypingSessionRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_SESSIONS, uid, sinceMs, untilMs),
  typingAnalyticsListSessionsLocal: (uid: string, sinceMs: number, untilMs: number): Promise<TypingSessionRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_SESSIONS_LOCAL, uid, sinceMs, untilMs),
  typingAnalyticsListSessionsForHash: (uid: string, machineHash: string, sinceMs: number, untilMs: number): Promise<TypingSessionRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_SESSIONS_FOR_HASH, uid, machineHash, sinceMs, untilMs),
  typingAnalyticsListBksMinute: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingBksMinuteRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_BKS_MINUTE, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListBksMinuteLocal: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingBksMinuteRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_BKS_MINUTE_LOCAL, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsListBksMinuteForHash: (uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<TypingBksMinuteRow[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_BKS_MINUTE_FOR_HASH, uid, machineHash, sinceMs, untilMs, appScopes),
  typingAnalyticsGetPeakRecords: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<PeakRecords> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_GET_PEAK_RECORDS, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsGetPeakRecordsLocal: (uid: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<PeakRecords> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_GET_PEAK_RECORDS_LOCAL, uid, sinceMs, untilMs, appScopes),
  typingAnalyticsGetPeakRecordsForHash: (uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes: string[] = []): Promise<PeakRecords> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_GET_PEAK_RECORDS_FOR_HASH, uid, machineHash, sinceMs, untilMs, appScopes),
  typingAnalyticsSaveKeymapSnapshot: (partial: Omit<TypingKeymapSnapshot, 'machineHash'>): Promise<{ saved: boolean; savedAt: number | null }> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_SAVE_KEYMAP_SNAPSHOT, partial),
  typingAnalyticsGetKeymapSnapshotForRange: (uid: string, fromMs: number, toMs: number): Promise<TypingKeymapSnapshot | null> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_GET_KEYMAP_SNAPSHOT_FOR_RANGE, uid, fromMs, toMs),
  typingAnalyticsListKeymapSnapshots: (uid: string): Promise<TypingKeymapSnapshotSummary[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_KEYMAP_SNAPSHOTS, uid),
  typingAnalyticsGetMatrixHeatmapForRange: (uid: string, layer: number, sinceMs: number, untilMs: number, scope: DeviceScope, appScopes: string[] = []): Promise<TypingHeatmapByCell> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_GET_MATRIX_HEATMAP_FOR_RANGE, uid, layer, sinceMs, untilMs, scope, appScopes),
  typingAnalyticsGetBigramAggregateForRange: (
    uid: string,
    sinceMs: number,
    untilMs: number,
    view: TypingBigramAggregateView,
    scope: DeviceScope,
    options?: TypingBigramAggregateOptions,
    appScopes: string[] = [],
  ): Promise<TypingBigramAggregateResult> =>
    ipcRenderer.invoke(
      IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE,
      uid,
      sinceMs,
      untilMs,
      view,
      scope,
      options,
      appScopes,
    ),
  typingAnalyticsGetLayoutComparisonForRange: (
    uid: string,
    sinceMs: number,
    untilMs: number,
    scope: DeviceScope,
    options: LayoutComparisonOptions,
    appScopes: string[] = [],
  ): Promise<LayoutComparisonResult | null> =>
    ipcRenderer.invoke(
      IpcChannels.TYPING_ANALYTICS_GET_LAYOUT_COMPARISON_FOR_RANGE,
      uid,
      sinceMs,
      untilMs,
      scope,
      options,
      appScopes,
    ),
  typingAnalyticsListLocalDeviceDays: (uid: string, machineHash: string): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_LOCAL_DEVICE_DAYS, uid, machineHash),
  typingAnalyticsHasRemote: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_HAS_REMOTE),
  typingAnalyticsListRemoteCloudHashes: (uid: string): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_REMOTE_CLOUD_HASHES, uid),
  typingAnalyticsListRemoteCloudDays: (uid: string, machineHash: string): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_LIST_REMOTE_CLOUD_DAYS, uid, machineHash),
  typingAnalyticsFetchRemoteDay: (uid: string, machineHash: string, utcDay: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_FETCH_REMOTE_DAY, uid, machineHash, utcDay),
  typingAnalyticsDeleteRemoteDay: (uid: string, machineHash: string, utcDay: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_DELETE_REMOTE_DAY, uid, machineHash, utcDay),
  typingAnalyticsExport: (uid: string, dates: string[]): Promise<{ written: number; cancelled: boolean }> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_EXPORT, uid, dates),
  typingAnalyticsImport: (): Promise<{ result: { imported: number; rejections: { fileName: string; reason: string }[] }; cancelled: boolean }> =>
    ipcRenderer.invoke(IpcChannels.TYPING_ANALYTICS_IMPORT),

  // --- Language Store (IPC to main) ---
  langList: (): Promise<LanguageListEntry[]> =>
    ipcRenderer.invoke(IpcChannels.LANG_LIST),
  langGet: (name: string): Promise<unknown> =>
    ipcRenderer.invoke(IpcChannels.LANG_GET, name),
  langDownload: (name: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.LANG_DOWNLOAD, name),
  langDelete: (name: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.LANG_DELETE, name),

  // --- App Config ---
  appConfigGetAll: (): Promise<AppConfig> =>
    ipcRenderer.invoke(IpcChannels.APP_CONFIG_GET_ALL),
  appConfigSet: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.APP_CONFIG_SET, key, value),

  // --- Sync ---
  syncAuthStart: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SYNC_AUTH_START),
  syncAuthStatus: (): Promise<SyncAuthStatus> =>
    ipcRenderer.invoke(IpcChannels.SYNC_AUTH_STATUS),
  syncAuthSignOut: (): Promise<SyncOperationResult> =>
    ipcRenderer.invoke(IpcChannels.SYNC_AUTH_SIGN_OUT),
  syncExecute: (direction: 'download' | 'upload', scope?: SyncScope): Promise<SyncOperationResult> =>
    ipcRenderer.invoke(IpcChannels.SYNC_EXECUTE, direction, scope),
  syncSetPassword: (password: string): Promise<SyncOperationResult> =>
    ipcRenderer.invoke(IpcChannels.SYNC_SET_PASSWORD, password),
  syncChangePassword: (newPassword: string): Promise<SyncOperationResult> =>
    ipcRenderer.invoke(IpcChannels.SYNC_CHANGE_PASSWORD, newPassword),
  syncResetTargets: (targets: SyncResetTargets): Promise<SyncOperationResult> =>
    ipcRenderer.invoke(IpcChannels.SYNC_RESET_TARGETS, targets),
  syncHasPassword: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.SYNC_HAS_PASSWORD),
  syncValidatePassword: (password: string): Promise<PasswordStrength> =>
    ipcRenderer.invoke(IpcChannels.SYNC_VALIDATE_PASSWORD, password),
  syncOnProgress: (callback: (progress: SyncProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: SyncProgress): void => {
      callback(progress)
    }
    ipcRenderer.on(IpcChannels.SYNC_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IpcChannels.SYNC_PROGRESS, handler)
  },
  syncHasPendingChanges: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.SYNC_PENDING_STATUS),
  syncListUndecryptable: (): Promise<UndecryptableFile[]> =>
    ipcRenderer.invoke(IpcChannels.SYNC_LIST_UNDECRYPTABLE),
  syncScanRemote: (): Promise<SyncDataScanResult> =>
    ipcRenderer.invoke(IpcChannels.SYNC_SCAN_REMOTE),
  syncFetchRemoteBundle: (syncUnit: string): Promise<unknown> =>
    ipcRenderer.invoke(IpcChannels.SYNC_FETCH_REMOTE_BUNDLE, syncUnit),
  syncDeleteFiles: (fileIds: string[]): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SYNC_DELETE_FILES, fileIds),
  syncCheckPasswordExists: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.SYNC_CHECK_PASSWORD_EXISTS),
  syncAnalyticsNow: (uid: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.SYNC_ANALYTICS_NOW, uid),
  syncOnPendingChange: (callback: (pending: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, pending: boolean): void => {
      callback(pending)
    }
    ipcRenderer.on(IpcChannels.SYNC_PENDING_STATUS, handler)
    return () => ipcRenderer.removeListener(IpcChannels.SYNC_PENDING_STATUS, handler)
  },

  // --- Hub ---
  hubUploadPost: (params: HubUploadPostParams): Promise<HubUploadResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_UPLOAD_POST, params),
  hubUpdatePost: (params: HubUpdatePostParams): Promise<HubUploadResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_UPDATE_POST, params),
  hubPatchPost: (params: HubPatchPostParams): Promise<HubDeleteResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_PATCH_POST, params),
  hubDeletePost: (postId: string): Promise<HubDeleteResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_DELETE_POST, postId),
  hubFetchMyPosts: (params?: HubFetchMyPostsParams): Promise<HubFetchMyPostsResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_FETCH_MY_POSTS, params),
  hubFetchMyKeyboardPosts: (keyboardName: string): Promise<HubFetchMyKeyboardPostsResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_FETCH_MY_KEYBOARD_POSTS, keyboardName),
  hubFetchAuthMe: (): Promise<HubUserResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_FETCH_AUTH_ME),
  hubPatchAuthMe: (displayName: string): Promise<HubUserResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_PATCH_AUTH_ME, displayName),
  hubSetAuthDisplayName: (displayName: string | null): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.HUB_SET_AUTH_DISPLAY_NAME, displayName),
  hubGetOrigin: (): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.HUB_GET_ORIGIN),

  // --- Notification ---
  notificationFetch: (): Promise<NotificationFetchResult> =>
    ipcRenderer.invoke(IpcChannels.NOTIFICATION_FETCH),

  // --- Hub Feature posts (favorites) ---
  hubUploadFavoritePost: (params: HubUploadFavoritePostParams): Promise<HubUploadResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_UPLOAD_FAVORITE_POST, params),
  hubUpdateFavoritePost: (params: HubUpdateFavoritePostParams): Promise<HubUploadResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_UPDATE_FAVORITE_POST, params),

  // --- Favorite Store extensions ---
  favoriteStoreSetHubPostId: (type: string, entryId: string, hubPostId: string | null): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID, type, entryId, hubPostId),

  // --- Snapshot Store extensions ---
  snapshotStoreSetHubPostId: (uid: string, entryId: string, hubPostId: string | null): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_SET_HUB_POST_ID, uid, entryId, hubPostId),

  // --- Shell ---
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.SHELL_OPEN_EXTERNAL, url),

  // --- Data Management ---
  listStoredKeyboards: (): Promise<StoredKeyboardInfo[]> =>
    ipcRenderer.invoke(IpcChannels.LIST_STORED_KEYBOARDS),
  resetKeyboardData: (uid: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.RESET_KEYBOARD_DATA, uid),
  resetLocalTargets: (targets: LocalResetTargets): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.RESET_LOCAL_TARGETS, targets),
  exportLocalData: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.EXPORT_LOCAL_DATA),
  importLocalData: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.IMPORT_LOCAL_DATA),

  // --- Window Management ---
  setWindowCompactMode: (enabled: boolean, compactSize?: { width: number; height: number }): Promise<{ width: number; height: number } | null> =>
    ipcRenderer.invoke(IpcChannels.WINDOW_SET_COMPACT_MODE, enabled, compactSize),
  setWindowAspectRatio: (ratio: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.WINDOW_SET_ASPECT_RATIO, ratio),
  setWindowAlwaysOnTop: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.WINDOW_SET_ALWAYS_ON_TOP, enabled),
  setWindowMinSize: (width: number, height: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.WINDOW_SET_MIN_SIZE, width, height),
  isAlwaysOnTopSupported: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.WINDOW_IS_ALWAYS_ON_TOP_SUPPORTED),
}

contextBridge.exposeInMainWorld('vialAPI', vialAPI)

// Type declaration for renderer
export type VialAPI = typeof vialAPI
