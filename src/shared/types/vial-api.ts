// SPDX-License-Identifier: GPL-2.0-or-later
// Type definition for the vialAPI exposed by preload via contextBridge

import type {
  DeviceInfo,
  KeyboardDefinition,
  KeyboardId,
  ProbeResult,
  TapDanceEntry,
  ComboEntry,
  KeyOverrideEntry,
  AltRepeatKeyEntry,
  DynamicEntryCounts,
  UnlockStatus,
} from './protocol'
import type { SnapshotMeta } from './snapshot-store'
import type { AnalyzeFilterSnapshotMeta } from './analyze-filter-store'
import type { FavoriteType, SavedFavoriteMeta, FavoriteImportResult } from './favorite-store'
import type { KeyLabelMeta, KeyLabelRecord, KeyLabelStoreResult } from './key-label-store'
import type { HubKeyLabelItem, HubKeyLabelListResponse, HubKeyLabelListParams, HubKeyLabelTimestampsResponse } from './hub-key-label'
import type { AppConfig } from './app-config'
import type { DeviceScope } from './analyze-filters'
import type { SyncAuthStatus, SyncProgress, PasswordStrength, SyncResetTargets, LocalResetTargets, UndecryptableFile, SyncScope, SyncDataScanResult, StoredKeyboardInfo, SyncOperationResult } from './sync'
import type { PipetteSettings } from './pipette-settings'
import type {
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
} from './typing-analytics'
import type { LanguageListEntry } from './language-store'
import type { HubUploadPostParams, HubUpdatePostParams, HubPatchPostParams, HubUploadResult, HubDeleteResult, HubFetchMyPostsResult, HubFetchMyKeyboardPostsResult, HubFetchMyPostsParams, HubUserResult, HubUploadFavoritePostParams, HubUpdateFavoritePostParams, HubUploadAnalyticsPostParams, HubUpdateAnalyticsPostParams, HubPreviewAnalyticsPostParams, HubAnalyticsPreview } from './hub'
import type { NotificationFetchResult } from './notification'

export interface VialAPI {
  // Device Management
  listDevices(): Promise<DeviceInfo[]>
  openDevice(vendorId: number, productId: number): Promise<boolean>
  closeDevice(): Promise<void>
  isDeviceOpen(): Promise<boolean>
  probeDevice(vendorId: number, productId: number, serialNumber?: string): Promise<ProbeResult>

  // VIA Protocol
  getProtocolVersion(): Promise<number>
  getLayerCount(): Promise<number>
  getKeymapBuffer(offset: number, size: number): Promise<number[]>
  setKeycode(layer: number, row: number, col: number, keycode: number): Promise<void>
  getLayoutOptions(): Promise<number>
  setLayoutOptions(options: number): Promise<void>

  // Vial Protocol
  getKeyboardId(): Promise<KeyboardId>
  getDefinitionSize(): Promise<number>
  getDefinitionRaw(size: number): Promise<number[]>
  getDefinition(): Promise<KeyboardDefinition | null>
  getEncoder(layer: number, index: number): Promise<[number, number]>
  setEncoder(
    layer: number,
    index: number,
    direction: number,
    keycode: number,
  ): Promise<void>

  // Macro
  getMacroCount(): Promise<number>
  getMacroBufferSize(): Promise<number>
  getMacroBuffer(totalSize: number): Promise<number[]>
  setMacroBuffer(data: number[]): Promise<void>

  // Lighting
  getLightingValue(id: number): Promise<number[]>
  setLightingValue(id: number, ...args: number[]): Promise<void>
  saveLighting(): Promise<void>

  // VialRGB
  getVialRGBInfo(): Promise<{ version: number; maxBrightness: number }>
  getVialRGBMode(): Promise<{ mode: number; speed: number; hue: number; sat: number; val: number }>
  getVialRGBSupported(): Promise<number[]>
  setVialRGBMode(mode: number, speed: number, hue: number, sat: number, val: number): Promise<void>

  // Lock/Unlock
  getUnlockStatus(): Promise<UnlockStatus>
  unlockStart(): Promise<void>
  unlockPoll(): Promise<number[]>
  lock(): Promise<void>

  // Dynamic Entries
  getDynamicEntryCount(): Promise<DynamicEntryCounts>
  getTapDance(index: number): Promise<TapDanceEntry>
  setTapDance(index: number, entry: TapDanceEntry): Promise<void>
  getCombo(index: number): Promise<ComboEntry>
  setCombo(index: number, entry: ComboEntry): Promise<void>
  getKeyOverride(index: number): Promise<KeyOverrideEntry>
  setKeyOverride(index: number, entry: KeyOverrideEntry): Promise<void>
  getAltRepeatKey(index: number): Promise<AltRepeatKeyEntry>
  setAltRepeatKey(index: number, entry: AltRepeatKeyEntry): Promise<void>

  // QMK Settings
  qmkSettingsQuery(startId: number): Promise<number[]>
  qmkSettingsGet(qsid: number): Promise<number[]>
  qmkSettingsSet(qsid: number, data: number[]): Promise<void>
  qmkSettingsReset(): Promise<void>

  // Matrix Tester
  getMatrixState(): Promise<number[]>

  // File I/O (IPC to main for native file dialogs)
  saveLayout(json: string, deviceName?: string): Promise<{ success: boolean; filePath?: string; error?: string }>
  loadLayout(title?: string, extensions?: string[]): Promise<{ success: boolean; data?: string; filePath?: string; error?: string }>
  exportKeymapC(content: string, deviceName?: string): Promise<{ success: boolean; filePath?: string; error?: string }>
  exportPdf(base64Data: string, deviceName?: string): Promise<{ success: boolean; filePath?: string; error?: string }>
  exportCsv(content: string, defaultName?: string): Promise<{ success: boolean; filePath?: string; error?: string }>
  exportJson(content: string, defaultName?: string): Promise<{ success: boolean; filePath?: string; error?: string }>
  sideloadJson(title?: string): Promise<{ success: boolean; data?: unknown; error?: string }>

  // Snapshot Store (internal save/load)
  snapshotStoreList(uid: string): Promise<{ success: boolean; entries?: SnapshotMeta[]; error?: string }>
  snapshotStoreSave(uid: string, json: string, deviceName: string, label: string, vilVersion?: number): Promise<{ success: boolean; entry?: SnapshotMeta; error?: string }>
  snapshotStoreLoad(uid: string, entryId: string): Promise<{ success: boolean; data?: string; error?: string }>
  snapshotStoreUpdate(uid: string, entryId: string, json: string, vilVersion?: number): Promise<{ success: boolean; error?: string }>
  snapshotStoreRename(uid: string, entryId: string, newLabel: string): Promise<{ success: boolean; error?: string }>
  snapshotStoreDelete(uid: string, entryId: string): Promise<{ success: boolean; error?: string }>

  // Analyze Filter Store (per-keyboard search-condition snapshots)
  analyzeFilterStoreList(uid: string): Promise<{ success: boolean; entries?: AnalyzeFilterSnapshotMeta[]; error?: string }>
  analyzeFilterStoreSave(uid: string, json: string, label: string, summary?: string): Promise<{ success: boolean; entry?: AnalyzeFilterSnapshotMeta; error?: string }>
  analyzeFilterStoreLoad(uid: string, entryId: string): Promise<{ success: boolean; data?: string; error?: string }>
  analyzeFilterStoreUpdate(uid: string, entryId: string, json: string): Promise<{ success: boolean; error?: string }>
  analyzeFilterStoreRename(uid: string, entryId: string, newLabel: string): Promise<{ success: boolean; error?: string }>
  analyzeFilterStoreDelete(uid: string, entryId: string): Promise<{ success: boolean; error?: string }>

  // Favorite Store (internal save/load)
  favoriteStoreList(type: string): Promise<{ success: boolean; entries?: SavedFavoriteMeta[]; error?: string }>
  favoriteStoreSave(type: string, json: string, label: string): Promise<{ success: boolean; entry?: SavedFavoriteMeta; error?: string }>
  favoriteStoreLoad(type: string, entryId: string): Promise<{ success: boolean; data?: string; error?: string }>
  favoriteStoreRename(type: string, entryId: string, newLabel: string): Promise<{ success: boolean; error?: string }>
  favoriteStoreDelete(type: string, entryId: string): Promise<{ success: boolean; error?: string }>
  favoriteStoreExport(scope: string, vialProtocol: number, entryId?: string): Promise<{ success: boolean; error?: string }>
  favoriteStoreExportCurrent(scope: string, vialProtocol: number, data: string): Promise<{ success: boolean; error?: string }>
  favoriteStoreImport(): Promise<FavoriteImportResult>
  favoriteStoreImportToCurrent(scope: string): Promise<{ success: boolean; data?: unknown; error?: string }>

  // Key Label Store (local)
  keyLabelStoreList(): Promise<KeyLabelStoreResult<KeyLabelMeta[]>>
  keyLabelStoreListAll(): Promise<KeyLabelStoreResult<KeyLabelMeta[]>>
  keyLabelStoreGet(id: string): Promise<KeyLabelStoreResult<KeyLabelRecord>>
  keyLabelStoreRename(id: string, newName: string): Promise<KeyLabelStoreResult<KeyLabelMeta>>
  keyLabelStoreDelete(id: string): Promise<KeyLabelStoreResult<void>>
  keyLabelStoreImport(): Promise<KeyLabelStoreResult<KeyLabelMeta>>
  keyLabelStoreExport(id: string): Promise<KeyLabelStoreResult<{ filePath: string }>>
  keyLabelStoreReorder(orderedIds: string[]): Promise<KeyLabelStoreResult<void>>
  keyLabelStoreSetHubPostId(id: string, hubPostId: string | null): Promise<KeyLabelStoreResult<KeyLabelMeta>>
  keyLabelStoreHasName(name: string, excludeId?: string): Promise<KeyLabelStoreResult<boolean>>

  // Key Label Hub
  keyLabelHubList(params?: HubKeyLabelListParams): Promise<KeyLabelStoreResult<HubKeyLabelListResponse>>
  keyLabelHubDetail(hubPostId: string): Promise<KeyLabelStoreResult<HubKeyLabelItem>>
  keyLabelHubDownload(hubPostId: string): Promise<KeyLabelStoreResult<KeyLabelMeta>>
  keyLabelHubUpload(localId: string): Promise<KeyLabelStoreResult<KeyLabelMeta>>
  keyLabelHubUpdate(localId: string): Promise<KeyLabelStoreResult<KeyLabelMeta>>
  keyLabelHubSync(localId: string): Promise<KeyLabelStoreResult<KeyLabelMeta>>
  keyLabelHubTimestamps(ids: string[]): Promise<KeyLabelStoreResult<HubKeyLabelTimestampsResponse>>
  keyLabelHubDelete(localId: string): Promise<KeyLabelStoreResult<void>>

  // Pipette Settings Store
  pipetteSettingsGet(uid: string): Promise<PipetteSettings | null>
  pipetteSettingsSet(uid: string, prefs: PipetteSettings): Promise<{ success: boolean; error?: string }>

  // Typing Analytics
  typingAnalyticsEvent(event: TypingAnalyticsEvent): Promise<void>
  typingAnalyticsFlush(uid: string): Promise<void>
  typingAnalyticsListAppsForRange(
    uid: string,
    sinceMs: number,
    untilMs: number,
    scope: unknown,
  ): Promise<{ name: string; keystrokes: number; activeMs: number }[]>
  typingAnalyticsGetAppUsageForRange(
    uid: string,
    sinceMs: number,
    untilMs: number,
    scope: unknown,
  ): Promise<{ name: string; keystrokes: number; activeMs: number }[]>
  typingAnalyticsGetWpmByAppForRange(
    uid: string,
    sinceMs: number,
    untilMs: number,
    scope: unknown,
  ): Promise<{ name: string; keystrokes: number; activeMs: number }[]>
  typingAnalyticsListKeyboards(): Promise<TypingKeyboardSummary[]>
  typingAnalyticsListItems(uid: string, appScopes?: string[]): Promise<TypingDailySummary[]>
  typingAnalyticsDeleteItems(uid: string, dates: string[]): Promise<TypingTombstoneResult>
  typingAnalyticsDeleteAll(uid: string): Promise<TypingTombstoneResult>
  typingAnalyticsGetMatrixHeatmap(uid: string, layer: number, sinceMs: number): Promise<TypingHeatmapByCell>
  typingAnalyticsListItemsLocal(uid: string, appScopes?: string[]): Promise<TypingDailySummary[]>
  typingAnalyticsListDeviceInfos(uid: string): Promise<TypingAnalyticsDeviceInfoBundle | null>
  typingAnalyticsListItemsForHash(uid: string, machineHash: string, appScopes?: string[]): Promise<TypingDailySummary[]>
  typingAnalyticsListIntervalItems(uid: string): Promise<TypingIntervalDailySummary[]>
  typingAnalyticsListIntervalItemsLocal(uid: string): Promise<TypingIntervalDailySummary[]>
  typingAnalyticsListIntervalItemsForHash(uid: string, machineHash: string): Promise<TypingIntervalDailySummary[]>
  typingAnalyticsListActivityGrid(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingActivityCell[]>
  typingAnalyticsListActivityGridLocal(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingActivityCell[]>
  typingAnalyticsListActivityGridForHash(uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingActivityCell[]>
  typingAnalyticsListLayerUsage(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingLayerUsageRow[]>
  typingAnalyticsListLayerUsageLocal(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingLayerUsageRow[]>
  typingAnalyticsListLayerUsageForHash(uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingLayerUsageRow[]>
  typingAnalyticsListMatrixCells(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingMatrixCellRow[]>
  typingAnalyticsListMatrixCellsLocal(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingMatrixCellRow[]>
  typingAnalyticsListMatrixCellsForHash(uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingMatrixCellRow[]>
  typingAnalyticsListMatrixCellsByDay(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingMatrixCellDailyRow[]>
  typingAnalyticsListMatrixCellsByDayLocal(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingMatrixCellDailyRow[]>
  typingAnalyticsListMatrixCellsByDayForHash(uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingMatrixCellDailyRow[]>
  typingAnalyticsListMinuteStats(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingMinuteStatsRow[]>
  typingAnalyticsListMinuteStatsLocal(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingMinuteStatsRow[]>
  typingAnalyticsListMinuteStatsForHash(uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingMinuteStatsRow[]>
  typingAnalyticsListSessions(uid: string, sinceMs: number, untilMs: number): Promise<TypingSessionRow[]>
  typingAnalyticsListSessionsLocal(uid: string, sinceMs: number, untilMs: number): Promise<TypingSessionRow[]>
  typingAnalyticsListSessionsForHash(uid: string, machineHash: string, sinceMs: number, untilMs: number): Promise<TypingSessionRow[]>
  typingAnalyticsListBksMinute(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingBksMinuteRow[]>
  typingAnalyticsListBksMinuteLocal(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingBksMinuteRow[]>
  typingAnalyticsListBksMinuteForHash(uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<TypingBksMinuteRow[]>
  typingAnalyticsGetPeakRecords(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<PeakRecords>
  typingAnalyticsGetPeakRecordsLocal(uid: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<PeakRecords>
  typingAnalyticsGetPeakRecordsForHash(uid: string, machineHash: string, sinceMs: number, untilMs: number, appScopes?: string[]): Promise<PeakRecords>
  typingAnalyticsSaveKeymapSnapshot(partial: Omit<TypingKeymapSnapshot, 'machineHash'>): Promise<{ saved: boolean; savedAt: number | null }>
  typingAnalyticsGetKeymapSnapshotForRange(uid: string, fromMs: number, toMs: number): Promise<TypingKeymapSnapshot | null>
  typingAnalyticsListKeymapSnapshots(uid: string): Promise<TypingKeymapSnapshotSummary[]>
  typingAnalyticsGetMatrixHeatmapForRange(uid: string, layer: number, sinceMs: number, untilMs: number, scope: DeviceScope, appScopes?: string[]): Promise<TypingHeatmapByCell>
  typingAnalyticsGetBigramAggregateForRange(uid: string, sinceMs: number, untilMs: number, view: TypingBigramAggregateView, scope: DeviceScope, options?: TypingBigramAggregateOptions, appScopes?: string[]): Promise<TypingBigramAggregateResult>
  typingAnalyticsListLocalDeviceDays(uid: string, machineHash: string): Promise<string[]>
  typingAnalyticsHasRemote(): Promise<boolean>
  typingAnalyticsListRemoteCloudHashes(uid: string): Promise<string[]>
  typingAnalyticsListRemoteCloudDays(uid: string, machineHash: string): Promise<string[]>
  typingAnalyticsFetchRemoteDay(uid: string, machineHash: string, utcDay: string): Promise<boolean>
  typingAnalyticsDeleteRemoteDay(uid: string, machineHash: string, utcDay: string): Promise<boolean>
  typingAnalyticsExport(uid: string, dates: string[]): Promise<{ written: number; cancelled: boolean }>
  typingAnalyticsImport(): Promise<{ result: { imported: number; rejections: { fileName: string; reason: string }[] }; cancelled: boolean }>

  // App Config
  appConfigGetAll(): Promise<AppConfig>
  appConfigSet(key: string, value: unknown): Promise<void>

  // Sync
  syncAuthStart(): Promise<SyncOperationResult>
  syncAuthStatus(): Promise<SyncAuthStatus>
  syncAuthSignOut(): Promise<SyncOperationResult>
  syncExecute(direction: 'download' | 'upload', scope?: SyncScope): Promise<SyncOperationResult>
  syncSetPassword(password: string): Promise<SyncOperationResult>
  syncChangePassword(newPassword: string): Promise<SyncOperationResult>
  syncResetTargets(targets: SyncResetTargets): Promise<SyncOperationResult>
  syncHasPassword(): Promise<boolean>
  syncValidatePassword(password: string): Promise<PasswordStrength>
  syncOnProgress(callback: (progress: SyncProgress) => void): () => void
  syncHasPendingChanges(): Promise<boolean>
  syncListUndecryptable(): Promise<UndecryptableFile[]>
  syncScanRemote(): Promise<SyncDataScanResult>
  syncFetchRemoteBundle(syncUnit: string): Promise<unknown>
  syncDeleteFiles(fileIds: string[]): Promise<{ success: boolean; error?: string }>
  syncCheckPasswordExists(): Promise<boolean>
  syncAnalyticsNow(uid: string): Promise<boolean>
  syncOnPendingChange(callback: (pending: boolean) => void): () => void

  // Language Store
  langList(): Promise<LanguageListEntry[]>
  langGet(name: string): Promise<unknown>
  langDownload(name: string): Promise<{ success: boolean; error?: string }>
  langDelete(name: string): Promise<{ success: boolean; error?: string }>

  // Data management
  listStoredKeyboards(): Promise<StoredKeyboardInfo[]>
  resetKeyboardData(uid: string): Promise<{ success: boolean; error?: string }>
  resetLocalTargets(targets: LocalResetTargets): Promise<{ success: boolean; error?: string }>
  exportLocalData(): Promise<{ success: boolean; error?: string }>
  importLocalData(): Promise<{ success: boolean; error?: string }>

  // Hub
  hubUploadPost(params: HubUploadPostParams): Promise<HubUploadResult>
  hubUpdatePost(params: HubUpdatePostParams): Promise<HubUploadResult>
  hubPatchPost(params: HubPatchPostParams): Promise<HubDeleteResult>
  hubDeletePost(postId: string): Promise<HubDeleteResult>
  hubFetchMyPosts(params?: HubFetchMyPostsParams): Promise<HubFetchMyPostsResult>
  hubFetchMyKeyboardPosts(keyboardName: string): Promise<HubFetchMyKeyboardPostsResult>
  hubFetchAuthMe(): Promise<HubUserResult>
  hubPatchAuthMe(displayName: string): Promise<HubUserResult>
  hubSetAuthDisplayName(displayName: string | null): Promise<void>
  hubGetOrigin(): Promise<string>

  // Notification
  notificationFetch(): Promise<NotificationFetchResult>

  // Shell
  openExternal(url: string): Promise<void>

  // Snapshot Store extensions
  snapshotStoreSetHubPostId(uid: string, entryId: string, hubPostId: string | null): Promise<{ success: boolean; error?: string }>

  // Hub Feature posts (favorites)
  hubUploadFavoritePost(params: HubUploadFavoritePostParams): Promise<HubUploadResult>
  hubUpdateFavoritePost(params: HubUpdateFavoritePostParams): Promise<HubUploadResult>

  // Hub Analytics posts
  hubUploadAnalyticsPost(params: HubUploadAnalyticsPostParams): Promise<HubUploadResult>
  hubUpdateAnalyticsPost(params: HubUpdateAnalyticsPostParams): Promise<HubUploadResult>
  hubPreviewAnalyticsPost(params: HubPreviewAnalyticsPostParams): Promise<{ success: boolean; preview?: HubAnalyticsPreview; error?: string }>

  // Favorite Store extensions
  favoriteStoreSetHubPostId(type: FavoriteType, entryId: string, hubPostId: string | null): Promise<{ success: boolean; error?: string }>

  // Analyze Filter Store extensions
  analyzeFilterStoreSetHubPostId(uid: string, entryId: string, hubPostId: string | null): Promise<{ success: boolean; error?: string }>

  // Window management
  setWindowCompactMode(enabled: boolean, compactSize?: { width: number; height: number }): Promise<{ width: number; height: number } | null>
  setWindowAspectRatio(ratio: number): Promise<void>
  setWindowAlwaysOnTop(enabled: boolean): Promise<void>
  setWindowMinSize(width: number, height: number): Promise<void>
  isAlwaysOnTopSupported(): Promise<boolean>
}
