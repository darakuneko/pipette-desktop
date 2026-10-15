// SPDX-License-Identifier: GPL-2.0-or-later
// Every VialAPI member with its call shape. The shim needs the member names
// at runtime (an interface has none) and must know which members are
// listeners: those return an unsubscribe function synchronously, every
// other member returns a Promise.
//
// The `satisfies` clause makes the table exact: a member missing from it,
// a name that is not a member, or a kind that disagrees with the member's
// signature in vial-api.ts is a type error.

import type { VialAPI } from '../shared/types/vial-api'

/** A member called with a callback that returns its unsubscribe function. */
type IsListener<F> = F extends (callback: never) => () => void ? true : false

export type VialApiMemberKind = 'listener' | 'request'

type MemberKinds = {
  [K in keyof VialAPI]: IsListener<VialAPI[K]> extends true ? 'listener' : 'request'
}

export const VIAL_API_MEMBER_KINDS = {
  // Device Management
  listDevices: 'request',
  openDevice: 'request',
  closeDevice: 'request',
  isDeviceOpen: 'request',
  probeDevice: 'request',

  // VIA Protocol
  getProtocolVersion: 'request',
  getLayerCount: 'request',
  getKeymapBuffer: 'request',
  setKeycode: 'request',
  getLayoutOptions: 'request',
  setLayoutOptions: 'request',

  // Vial Protocol
  getKeyboardId: 'request',
  getDefinitionSize: 'request',
  getDefinitionRaw: 'request',
  getDefinition: 'request',
  getEncoder: 'request',
  setEncoder: 'request',

  // Macro
  getMacroCount: 'request',
  getMacroBufferSize: 'request',
  getMacroBuffer: 'request',
  setMacroBuffer: 'request',

  // Lighting
  getLightingValue: 'request',
  setLightingValue: 'request',
  saveLighting: 'request',

  // VialRGB
  getVialRGBInfo: 'request',
  getVialRGBMode: 'request',
  getVialRGBSupported: 'request',
  setVialRGBMode: 'request',

  // Lock/Unlock
  getUnlockStatus: 'request',
  unlockStart: 'request',
  unlockPoll: 'request',
  lock: 'request',

  // Dynamic Entries
  getDynamicEntryCount: 'request',
  getTapDance: 'request',
  setTapDance: 'request',
  getCombo: 'request',
  setCombo: 'request',
  getKeyOverride: 'request',
  setKeyOverride: 'request',
  getAltRepeatKey: 'request',
  setAltRepeatKey: 'request',

  // QMK Settings
  qmkSettingsQuery: 'request',
  qmkSettingsGet: 'request',
  qmkSettingsSet: 'request',
  qmkSettingsReset: 'request',

  // Matrix Tester
  getMatrixState: 'request',

  // File I/O (IPC to main for native file dialogs)
  saveLayout: 'request',
  loadLayout: 'request',
  exportKeymapC: 'request',
  exportPdf: 'request',
  exportCsv: 'request',
  exportCsvBundle: 'request',
  exportJson: 'request',
  sideloadJson: 'request',

  // Snapshot Store (internal save/load)
  snapshotStoreList: 'request',
  snapshotStoreSave: 'request',
  snapshotStoreLoad: 'request',
  snapshotStoreUpdate: 'request',
  snapshotStoreRename: 'request',
  snapshotStoreDelete: 'request',

  // Analyze Filter Store (per-keyboard search-condition snapshots)
  analyzeFilterStoreList: 'request',
  analyzeFilterStoreSave: 'request',
  analyzeFilterStoreLoad: 'request',
  analyzeFilterStoreUpdate: 'request',
  analyzeFilterStoreRename: 'request',
  analyzeFilterStoreDelete: 'request',

  // --- Typing Run Log Store (per-run raw keystroke log) ---
  typingRunLogSave: 'request',
  typingRunLogList: 'request',
  typingRunLogGet: 'request',

  // Favorite Store (internal save/load)
  favoriteStoreList: 'request',
  favoriteStoreSave: 'request',
  favoriteStoreLoad: 'request',
  favoriteStoreRename: 'request',
  favoriteStoreDelete: 'request',
  favoriteStoreExport: 'request',
  favoriteStoreExportCurrent: 'request',
  favoriteStoreImport: 'request',
  favoriteStoreImportToCurrent: 'request',

  // Key Label Store (local)
  keyLabelStoreList: 'request',
  keyLabelStoreListAll: 'request',
  keyLabelStoreGet: 'request',
  keyLabelStoreRename: 'request',
  keyLabelStoreDelete: 'request',
  keyLabelStoreImport: 'request',
  keyLabelStoreExport: 'request',
  keyLabelStoreReorder: 'request',
  keyLabelStoreSetHubPostId: 'request',
  keyLabelStoreHasName: 'request',

  // Typing Test Text Store
  typingTestTextStoreList: 'request',
  typingTestTextStoreGet: 'request',
  typingTestTextStoreRename: 'request',
  typingTestTextStoreDelete: 'request',
  typingTestTextStoreImport: 'request',
  typingTestTextStoreImportConfirm: 'request',

  // Key Label Hub
  keyLabelHubList: 'request',
  keyLabelHubDetail: 'request',
  keyLabelHubDownload: 'request',
  keyLabelHubUpload: 'request',
  keyLabelHubUpdate: 'request',
  keyLabelHubSync: 'request',
  keyLabelHubTimestamps: 'request',
  keyLabelHubDelete: 'request',

  // Pipette Settings Store
  pipetteSettingsGet: 'request',
  pipetteSettingsPatch: 'request',
  pipetteSettingsEnsureDir: 'request',
  pipetteSettingsListAllTypingResults: 'request',

  // Typing Analytics
  typingAnalyticsEvent: 'request',
  typingAnalyticsFlush: 'request',
  typingAnalyticsListAppsForRange: 'request',
  typingAnalyticsListTypingTestsForRange: 'request',
  typingAnalyticsListTypingTestRunsForRange: 'request',
  typingAnalyticsGetAppUsageForRange: 'request',
  typingAnalyticsGetWpmByAppForRange: 'request',
  typingAnalyticsListKeyboards: 'request',
  typingAnalyticsListItems: 'request',
  typingAnalyticsDeleteItems: 'request',
  typingAnalyticsDeleteAll: 'request',
  typingAnalyticsGetMatrixHeatmap: 'request',
  typingAnalyticsListItemsLocal: 'request',
  typingAnalyticsListDeviceInfos: 'request',
  typingAnalyticsListItemsForHash: 'request',
  typingAnalyticsListIntervalItems: 'request',
  typingAnalyticsListIntervalItemsLocal: 'request',
  typingAnalyticsListIntervalItemsForHash: 'request',
  typingAnalyticsListActivityGrid: 'request',
  typingAnalyticsListActivityGridLocal: 'request',
  typingAnalyticsListActivityGridForHash: 'request',
  typingAnalyticsListLayerUsage: 'request',
  typingAnalyticsListLayerUsageLocal: 'request',
  typingAnalyticsListLayerUsageForHash: 'request',
  typingAnalyticsListMatrixCells: 'request',
  typingAnalyticsListMatrixCellsLocal: 'request',
  typingAnalyticsListMatrixCellsForHash: 'request',
  typingAnalyticsListMatrixCellsByDay: 'request',
  typingAnalyticsListMatrixCellsByDayLocal: 'request',
  typingAnalyticsListMatrixCellsByDayForHash: 'request',
  typingAnalyticsListMinuteStats: 'request',
  typingAnalyticsListMinuteStatsLocal: 'request',
  typingAnalyticsListMinuteStatsForHash: 'request',
  typingAnalyticsListSessions: 'request',
  typingAnalyticsListSessionsLocal: 'request',
  typingAnalyticsListSessionsForHash: 'request',
  typingAnalyticsListBksMinute: 'request',
  typingAnalyticsListBksMinuteLocal: 'request',
  typingAnalyticsListBksMinuteForHash: 'request',
  typingAnalyticsGetPeakRecords: 'request',
  typingAnalyticsGetPeakRecordsLocal: 'request',
  typingAnalyticsGetPeakRecordsForHash: 'request',
  typingAnalyticsSaveKeymapSnapshot: 'request',
  typingAnalyticsGetKeymapSnapshotForRange: 'request',
  typingAnalyticsListKeymapSnapshots: 'request',
  typingAnalyticsGetMatrixHeatmapForRange: 'request',
  typingAnalyticsGetBigramAggregateForRange: 'request',
  typingAnalyticsListRolloverMinutes: 'request',
  typingAnalyticsListDurationCells: 'request',
  typingAnalyticsGetLayoutComparisonForRange: 'request',
  typingAnalyticsListLocalDeviceDays: 'request',
  typingAnalyticsHasRemote: 'request',
  typingAnalyticsListRemoteCloudHashes: 'request',
  typingAnalyticsListRemoteCloudDays: 'request',
  typingAnalyticsFetchRemoteDay: 'request',
  typingAnalyticsDeleteDeviceData: 'request',
  typingAnalyticsExport: 'request',
  typingAnalyticsImport: 'request',

  // App Config
  appConfigGetAll: 'request',
  appConfigSet: 'request',

  // Sync
  syncAuthStart: 'request',
  syncAuthStatus: 'request',
  syncAuthSignOut: 'request',
  syncExecute: 'request',
  syncSetPassword: 'request',
  syncChangePassword: 'request',
  syncReplacePassword: 'request',
  syncPasswordChangeStatus: 'request',
  syncPasswordChangeResume: 'request',
  syncPasswordChangeRevert: 'request',
  syncPasswordChangeAbandon: 'request',
  syncPasswordChangeDeleteUndecryptable: 'request',
  syncPasswordChangeLockStatus: 'request',
  syncPasswordChangeReleaseLocks: 'request',
  syncResetTargets: 'request',
  syncPasswordStatus: 'request',
  syncValidatePassword: 'request',
  syncOnProgress: 'listener',
  syncHasPendingChanges: 'request',
  syncListUndecryptable: 'request',
  syncScanRemote: 'request',
  syncFetchRemoteBundle: 'request',
  syncDeleteFiles: 'request',
  syncListTrash: 'request',
  syncRestoreTrash: 'request',
  syncDeleteTrash: 'request',
  syncCheckPasswordExists: 'request',
  syncAnalyticsNow: 'request',
  syncFormatStatus: 'request',
  syncOnFormatStatusChanged: 'listener',
  syncOnPendingChange: 'listener',
  syncOnUnitApplied: 'listener',

  // Language Store
  langList: 'request',
  langGet: 'request',
  langDownload: 'request',
  langDelete: 'request',
  checkTypingDatasetUpdate: 'request',
  updateTypingDataset: 'request',

  // Aozora Bunko catalog import
  aozoraImport: 'request',

  // Data management
  listStoredKeyboards: 'request',
  keyboardMetaNameIfMissing: 'request',
  resetKeyboardData: 'request',
  resetLocalTargets: 'request',
  exportLocalData: 'request',
  importLocalData: 'request',

  // Hub
  hubUploadPost: 'request',
  hubUploadPrivatePost: 'request',
  hubDeletePrivatePost: 'request',
  hubUpdatePost: 'request',
  hubPatchPost: 'request',
  hubDeletePost: 'request',
  hubFetchMyPosts: 'request',
  hubFetchMyKeyboardPosts: 'request',
  hubFetchAuthMe: 'request',
  hubPatchAuthMe: 'request',
  hubSetAuthDisplayName: 'request',
  hubGetOrigin: 'request',

  // Notification
  notificationFetch: 'request',

  // Shell
  openExternal: 'request',

  // Snapshot Store extensions
  snapshotStoreSetHubPostId: 'request',
  snapshotStoreSetHubPrivate: 'request',

  // Hub Feature posts (favorites)
  hubUploadFavoritePost: 'request',
  hubUploadPrivateFavoritePost: 'request',
  hubUpdateFavoritePost: 'request',

  // Hub Analytics posts
  hubUploadAnalyticsPost: 'request',
  hubUploadPrivateAnalyticsPost: 'request',
  hubUpdateAnalyticsPost: 'request',
  hubPreviewAnalyticsPost: 'request',

  // i18n language pack store
  i18nPackList: 'request',
  i18nPackGet: 'request',
  i18nPackRename: 'request',
  i18nPackSetEnabled: 'request',
  i18nPackRefreshCoverage: 'request',
  i18nPackDelete: 'request',
  i18nPackSetHubPostId: 'request',
  i18nPackHasName: 'request',
  i18nPackReorder: 'request',
  i18nPackImport: 'request',
  i18nPackImportApply: 'request',
  i18nPackExport: 'request',
  i18nPackHubTimestamps: 'request',
  i18nPackOnChanged: 'listener',

  // Theme pack store
  themePackList: 'request',
  themePackGet: 'request',
  themePackRename: 'request',
  themePackDelete: 'request',
  themePackSetHubPostId: 'request',
  themePackHasName: 'request',
  themePackReorder: 'request',
  themePackImport: 'request',
  themePackImportApply: 'request',
  themePackExport: 'request',
  themePackHubTimestamps: 'request',
  themePackOnChanged: 'listener',

  // Hub theme posts
  hubListThemePosts: 'request',
  hubDownloadThemePost: 'request',
  hubUploadThemePost: 'request',
  hubUpdateThemePost: 'request',
  hubDeleteThemePost: 'request',

  // Hub i18n posts
  hubListI18nPosts: 'request',
  hubDownloadI18nPost: 'request',
  hubUploadI18nPost: 'request',
  hubUpdateI18nPost: 'request',
  hubDeleteI18nPost: 'request',

  // Favorite Store extensions
  favoriteStoreSetHubPostId: 'request',
  favoriteStoreSetHubPrivate: 'request',

  // Analyze Filter Store extensions
  analyzeFilterStoreSetHubPostId: 'request',
  analyzeFilterStoreSetHubPrivate: 'request',

  // Window management
  setWindowCompactMode: 'request',
  setWindowAspectRatio: 'request',
  setWindowAlwaysOnTop: 'request',
  setWindowOpacity: 'request',
  setWindowMinSize: 'request',
  isAlwaysOnTopSupported: 'request',
  setWindowZoom: 'request',
  windowShow: 'request',
  windowHide: 'request',
  windowStartedHidden: 'request',
  windowIsVisible: 'request',
  onWindowVisibilityChanged: 'listener',

  // Tray status
  trayStatusUpdate: 'request',
} as const satisfies MemberKinds

export type VialApiMemberName = keyof VialAPI

export const VIAL_API_MEMBER_NAMES = Object.keys(VIAL_API_MEMBER_KINDS) as VialApiMemberName[]
