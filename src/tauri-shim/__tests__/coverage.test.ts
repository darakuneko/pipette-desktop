// SPDX-License-Identifier: GPL-2.0-or-later
// Counts the shim's members: real (backed by backend commands), fake (fixed
// answers in fakes.ts) and stub (every other member). Every implemented
// member is exactly one of real or fake, and the fakes are exactly the list
// below, so adding or replacing one is a deliberate change here too. The
// keyboard members (HID probe, file dialogs, snapshot, favorite and
// pipette settings stores, stored keyboards, pending sync units), the run
// log and Analyze filter members, the typing analytics members that read
// the cache, the typing analytics' keymap snapshot, recording, Data modal
// and Drive members (every typing analytics member), and the pack and
// label members (key labels, typing test texts, language and theme packs,
// word lists, datasets and the Aozora Bunko import) are all real, and so
// are the Hub members and the Cloud Sync members (each listed with the
// module that holds it), the tray and the startup notification. No member
// is faked, and none falls back to a stub.

import { describe, expect, it, vi } from 'vitest'
import { fakes } from '../fakes'
import { implemented, real } from '../implemented'
import { VIAL_API_MEMBER_KINDS, VIAL_API_MEMBER_NAMES } from '../vial-api-members'
import { syncAuthApi } from '../api/sync-auth'
import { syncDataApi } from '../api/sync-data'
import { syncExecuteApi } from '../api/sync-execute'
import { syncPasswordApi } from '../api/sync-password'
import { syncPasswordChangeApi } from '../api/sync-password-change'
import { syncResetApi } from '../api/sync-reset'
import { typingAnalyticsRemoteApi } from '../api/typing-analytics-remote'
import { hubAccountApi } from '../api/hub-account'
import { hubPostsApi } from '../api/hub-posts'
import { hubFavoriteApi } from '../api/hub-favorite'
import { hubAnalyticsApi } from '../api/hub-analytics'
import { hubPacksApi } from '../api/hub-packs'
import { keyLabelHubApi } from '../api/key-label-hub'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const EXPECTED_FAKES: string[] = []

/** The members the keyboard editor needs from the backend, all real. */
const KEYBOARD_MEMBERS = [
  'probeDevice',
  'saveLayout',
  'loadLayout',
  'exportKeymapC',
  'exportPdf',
  'exportCsv',
  'exportCsvBundle',
  'exportJson',
  'sideloadJson',
  'snapshotStoreList',
  'snapshotStoreSave',
  'snapshotStoreLoad',
  'snapshotStoreUpdate',
  'snapshotStoreRename',
  'snapshotStoreDelete',
  'snapshotStoreSetHubPostId',
  'snapshotStoreSetHubPrivate',
  'favoriteStoreList',
  'favoriteStoreSave',
  'favoriteStoreLoad',
  'favoriteStoreRename',
  'favoriteStoreDelete',
  'favoriteStoreExport',
  'favoriteStoreExportCurrent',
  'favoriteStoreImport',
  'favoriteStoreImportToCurrent',
  'favoriteStoreSetHubPostId',
  'favoriteStoreSetHubPrivate',
  'pipetteSettingsGet',
  'pipetteSettingsPatch',
  'pipetteSettingsEnsureDir',
  'pipetteSettingsListAllTypingResults',
  'listStoredKeyboards',
  'keyboardMetaNameIfMissing',
  'syncHasPendingChanges',
  'syncOnPendingChange',
]

/** The Typing Test run log and Analyze filter store members, all real. */
const RUN_LOG_AND_FILTER_MEMBERS = [
  'typingRunLogSave',
  'typingRunLogList',
  'typingRunLogGet',
  'analyzeFilterStoreList',
  'analyzeFilterStoreSave',
  'analyzeFilterStoreLoad',
  'analyzeFilterStoreUpdate',
  'analyzeFilterStoreRename',
  'analyzeFilterStoreDelete',
  'analyzeFilterStoreSetHubPostId',
  'analyzeFilterStoreSetHubPrivate',
]

/** The typing analytics members that read the cache (the Analyze and Data
 *  modal lists and aggregates, and the range aggregates), all real. */
const TYPING_ANALYTICS_CACHE_MEMBERS = [
  'typingAnalyticsListKeyboards',
  'typingAnalyticsListItems',
  'typingAnalyticsListItemsLocal',
  'typingAnalyticsListItemsForHash',
  'typingAnalyticsListIntervalItems',
  'typingAnalyticsListIntervalItemsLocal',
  'typingAnalyticsListIntervalItemsForHash',
  'typingAnalyticsListActivityGrid',
  'typingAnalyticsListActivityGridLocal',
  'typingAnalyticsListActivityGridForHash',
  'typingAnalyticsListLayerUsage',
  'typingAnalyticsListLayerUsageLocal',
  'typingAnalyticsListLayerUsageForHash',
  'typingAnalyticsListMatrixCells',
  'typingAnalyticsListMatrixCellsLocal',
  'typingAnalyticsListMatrixCellsForHash',
  'typingAnalyticsListMatrixCellsByDay',
  'typingAnalyticsListMatrixCellsByDayLocal',
  'typingAnalyticsListMatrixCellsByDayForHash',
  'typingAnalyticsListMinuteStats',
  'typingAnalyticsListMinuteStatsLocal',
  'typingAnalyticsListMinuteStatsForHash',
  'typingAnalyticsListSessions',
  'typingAnalyticsListSessionsLocal',
  'typingAnalyticsListSessionsForHash',
  'typingAnalyticsListBksMinute',
  'typingAnalyticsListBksMinuteLocal',
  'typingAnalyticsListBksMinuteForHash',
  'typingAnalyticsGetPeakRecords',
  'typingAnalyticsGetPeakRecordsLocal',
  'typingAnalyticsGetPeakRecordsForHash',
  'typingAnalyticsGetMatrixHeatmap',
  'typingAnalyticsListDeviceInfos',
  'typingAnalyticsListLocalDeviceDays',
  'typingAnalyticsListAppsForRange',
  'typingAnalyticsListTypingTestsForRange',
  'typingAnalyticsListTypingTestRunsForRange',
  'typingAnalyticsGetAppUsageForRange',
  'typingAnalyticsGetWpmByAppForRange',
  'typingAnalyticsGetMatrixHeatmapForRange',
  'typingAnalyticsGetBigramAggregateForRange',
  'typingAnalyticsListRolloverMinutes',
  'typingAnalyticsListDurationCells',
  'typingAnalyticsGetLayoutComparisonForRange',
]

/** The typing analytics' keymap snapshot members, all real. */
const TYPING_ANALYTICS_KEYMAP_MEMBERS = [
  'typingAnalyticsSaveKeymapSnapshot',
  'typingAnalyticsGetKeymapSnapshotForRange',
  'typingAnalyticsListKeymapSnapshots',
]

/** The typing analytics' recording members, all real. */
const TYPING_ANALYTICS_RECORD_MEMBERS = ['typingAnalyticsEvent', 'typingAnalyticsFlush']

/** The Data modal's operations on the typing analytics, all real. */
const TYPING_ANALYTICS_DATA_MEMBERS = [
  'typingAnalyticsDeleteItems',
  'typingAnalyticsDeleteAll',
  'typingAnalyticsDeleteDeviceData',
  'typingAnalyticsExport',
  'typingAnalyticsImport',
]

/** The language pack members, all real. */
const LANGUAGE_PACK_MEMBERS = [
  'i18nPackList',
  'i18nPackGet',
  'i18nPackRename',
  'i18nPackSetEnabled',
  'i18nPackRefreshCoverage',
  'i18nPackDelete',
  'i18nPackSetHubPostId',
  'i18nPackHasName',
  'i18nPackReorder',
  'i18nPackImport',
  'i18nPackImportApply',
  'i18nPackExport',
  'i18nPackOnChanged',
]

/** The theme pack members, all real. */
const THEME_PACK_MEMBERS = [
  'themePackList',
  'themePackGet',
  'themePackRename',
  'themePackDelete',
  'themePackSetHubPostId',
  'themePackHasName',
  'themePackReorder',
  'themePackImport',
  'themePackImportApply',
  'themePackExport',
  'themePackOnChanged',
]

/** The key label store members, all real. */
const KEY_LABEL_MEMBERS = [
  'keyLabelStoreList',
  'keyLabelStoreListAll',
  'keyLabelStoreGet',
  'keyLabelStoreRename',
  'keyLabelStoreDelete',
  'keyLabelStoreImport',
  'keyLabelStoreExport',
  'keyLabelStoreReorder',
  'keyLabelStoreSetHubPostId',
  'keyLabelStoreHasName',
]

/** The typing test text store members, all real. */
const TYPING_TEXT_MEMBERS = [
  'typingTestTextStoreList',
  'typingTestTextStoreGet',
  'typingTestTextStoreRename',
  'typingTestTextStoreDelete',
  'typingTestTextStoreImport',
  'typingTestTextStoreImportConfirm',
]

/** The Typing Test word list, dataset and Aozora Bunko import members, all
 *  real. */
const TYPING_DATASET_MEMBERS = [
  'langList',
  'langGet',
  'langDownload',
  'langDelete',
  'checkTypingDatasetUpdate',
  'updateTypingDataset',
  'aozoraImport',
]

/** The Cloud Sync members, by the shim module that holds them; SYNC_REAL
 *  lists them all. */
const SYNC_MEMBERS = [
  { module: syncAuthApi, members: ['syncAuthStart', 'syncAuthStatus', 'syncAuthSignOut'] },
  {
    module: syncPasswordApi,
    members: ['syncSetPassword', 'syncReplacePassword', 'syncPasswordStatus', 'syncValidatePassword', 'syncCheckPasswordExists'],
  },
  {
    module: syncExecuteApi,
    members: ['syncExecute', 'syncAnalyticsNow', 'syncFormatStatus', 'syncOnProgress', 'syncOnFormatStatusChanged', 'syncOnUnitApplied'],
  },
  {
    module: syncPasswordChangeApi,
    members: [
      'syncChangePassword',
      'syncPasswordChangeStatus',
      'syncPasswordChangeResume',
      'syncPasswordChangeRevert',
      'syncPasswordChangeAbandon',
      'syncPasswordChangeDeleteUndecryptable',
      'syncPasswordChangeLockStatus',
      'syncPasswordChangeReleaseLocks',
      'syncListUndecryptable',
    ],
  },
  {
    module: syncDataApi,
    members: [
      'syncScanRemote',
      'syncFetchRemoteBundle',
      'syncDeleteFiles',
      'syncListTrash',
      'syncRestoreTrash',
      'syncDeleteTrash',
      'exportLocalData',
      'importLocalData',
    ],
  },
  { module: syncResetApi, members: ['syncResetTargets', 'resetKeyboardData', 'resetLocalTargets'] },
  {
    module: typingAnalyticsRemoteApi,
    members: [
      'typingAnalyticsHasRemote',
      'typingAnalyticsListRemoteCloudHashes',
      'typingAnalyticsListRemoteCloudDays',
      'typingAnalyticsFetchRemoteDay',
    ],
  },
]

/** The Cloud Sync members, all real: the sign-in, the sign-out, the
 *  sign-in and password statuses, setting and re-entering the password,
 *  whether Drive has a password-check, the password change with its Drive
 *  lock and the files no password opens, the sync of a scope with its progress
 *  and applied-unit events, the Analyze sync, the sync format status and its
 *  event, the Data modal's scan, bundle, deletes and trash, the resets, the
 *  export and import of the local data, the typing analytics on Drive
 *  (backend commands) and the password strength check (in the shim). */
const SYNC_REAL = [
  'syncAuthStart',
  'syncAuthStatus',
  'syncAuthSignOut',
  'syncPasswordStatus',
  'syncValidatePassword',
  'syncSetPassword',
  'syncReplacePassword',
  'syncCheckPasswordExists',
  'syncChangePassword',
  'syncPasswordChangeStatus',
  'syncPasswordChangeResume',
  'syncPasswordChangeRevert',
  'syncPasswordChangeAbandon',
  'syncPasswordChangeDeleteUndecryptable',
  'syncPasswordChangeLockStatus',
  'syncPasswordChangeReleaseLocks',
  'syncListUndecryptable',
  'syncFormatStatus',
  'syncOnFormatStatusChanged',
  'syncExecute',
  'syncOnProgress',
  'syncOnUnitApplied',
  'syncScanRemote',
  'syncFetchRemoteBundle',
  'syncDeleteFiles',
  'syncListTrash',
  'syncRestoreTrash',
  'syncDeleteTrash',
  'syncResetTargets',
  'resetKeyboardData',
  'resetLocalTargets',
  'exportLocalData',
  'importLocalData',
  'syncAnalyticsNow',
  'typingAnalyticsHasRemote',
  'typingAnalyticsListRemoteCloudHashes',
  'typingAnalyticsListRemoteCloudDays',
  'typingAnalyticsFetchRemoteDay',
]

/** The Hub members, by the shim module that holds them. */
const HUB_MODULES = [hubAccountApi, hubPostsApi, hubFavoriteApi, hubAnalyticsApi, hubPacksApi, keyLabelHubApi]

/** Whether `name` is a member named after the Hub, other than the setters
 *  of a store's Hub link (`…SetHubPostId`, `…SetHubPrivate`), which belong
 *  to the stores. The word list dataset members and the Aozora Bunko
 *  import also reach the Hub, and are not named after it. */
const namedAfterHub = (name: string): boolean => /^hub|Hub/.test(name) && !/SetHub/.test(name)

describe('shim coverage', () => {
  it('backs every pack and label member with backend commands', () => {
    const members = [
      ...KEY_LABEL_MEMBERS,
      ...TYPING_TEXT_MEMBERS,
      ...LANGUAGE_PACK_MEMBERS,
      ...THEME_PACK_MEMBERS,
      ...TYPING_DATASET_MEMBERS,
    ]
    expect(new Set(members).size).toBe(47)
    expect(members.filter((name) => !(name in real))).toEqual([])
    expect(members.filter((name) => name in fakes)).toEqual([])
    // Every key label and typing test text store member is in the list.
    const stores = Object.keys(implemented).filter((name) => /^(keyLabelStore|typingTestTextStore)/.test(name))
    expect(stores.filter((name) => !members.includes(name))).toEqual([])
  })

  it('holds the 39 Hub members in their modules and backs all of them with backend commands', () => {
    const members = HUB_MODULES.flatMap((module) => Object.keys(module))
    expect(new Set(members).size).toBe(39)
    expect(members.filter((name) => !(VIAL_API_MEMBER_NAMES as readonly string[]).includes(name))).toEqual([])
    expect(members.filter((name) => !(name in real))).toEqual([])
    expect(members.filter((name) => name in fakes)).toEqual([])
    // Every member named after the Hub is one of them.
    expect(VIAL_API_MEMBER_NAMES.filter(namedAfterHub).sort()).toEqual([...members].sort())
  })

  it('backs every keyboard member with backend commands', () => {
    expect(new Set(KEYBOARD_MEMBERS).size).toBe(36)
    expect(KEYBOARD_MEMBERS.filter((name) => !(name in real))).toEqual([])
    expect(KEYBOARD_MEMBERS.filter((name) => name in fakes)).toEqual([])
  })

  it('backs the typing analytics members that read the cache with backend commands', () => {
    expect(new Set(TYPING_ANALYTICS_CACHE_MEMBERS).size).toBe(44)
    expect(TYPING_ANALYTICS_CACHE_MEMBERS.filter((name) => !(name in real))).toEqual([])
    expect(TYPING_ANALYTICS_CACHE_MEMBERS.filter((name) => name in fakes)).toEqual([])
  })

  it('backs every run log and Analyze filter member with backend commands', () => {
    expect(new Set(RUN_LOG_AND_FILTER_MEMBERS).size).toBe(11)
    expect(RUN_LOG_AND_FILTER_MEMBERS.filter((name) => !(name in real))).toEqual([])
    expect(RUN_LOG_AND_FILTER_MEMBERS.filter((name) => name in fakes)).toEqual([])
    const stores = Object.keys(implemented).filter((name) => /^(typingRunLog|analyzeFilterStore)/.test(name))
    expect(stores.filter((name) => !RUN_LOG_AND_FILTER_MEMBERS.includes(name))).toEqual([])
  })

  it('backs every keymap snapshot member with backend commands', () => {
    expect(TYPING_ANALYTICS_KEYMAP_MEMBERS.filter((name) => !(name in real))).toEqual([])
    expect(TYPING_ANALYTICS_KEYMAP_MEMBERS.filter((name) => name in fakes)).toEqual([])
    const keymaps = Object.keys(implemented).filter((name) => /^typingAnalytics.*KeymapSnapshot/.test(name))
    expect(keymaps.sort()).toEqual([...TYPING_ANALYTICS_KEYMAP_MEMBERS].sort())
  })

  it('backs the recording members with backend commands', () => {
    expect(TYPING_ANALYTICS_RECORD_MEMBERS.filter((name) => !(name in real))).toEqual([])
    expect(TYPING_ANALYTICS_RECORD_MEMBERS.filter((name) => name in fakes)).toEqual([])
  })

  it('backs every typing analytics member with backend commands', () => {
    expect(TYPING_ANALYTICS_DATA_MEMBERS.filter((name) => !(name in real))).toEqual([])
    const analytics = VIAL_API_MEMBER_NAMES.filter((name) => name.startsWith('typingAnalytics'))
    const local = [
      ...TYPING_ANALYTICS_CACHE_MEMBERS,
      ...TYPING_ANALYTICS_KEYMAP_MEMBERS,
      ...TYPING_ANALYTICS_RECORD_MEMBERS,
      ...TYPING_ANALYTICS_DATA_MEMBERS,
    ]
    expect(new Set(local).size).toBe(54)
    const drive = Object.keys(typingAnalyticsRemoteApi)
    expect(analytics.filter((name) => !local.includes(name)).sort()).toEqual(drive.sort())
    expect(analytics.filter((name) => !(name in real))).toEqual([])
    expect(analytics.filter((name) => name in fakes)).toEqual([])
  })

  it('lists the Cloud Sync members, each in one module, and the real ones', () => {
    const members = SYNC_MEMBERS.flatMap(({ members }) => members)
    expect(new Set(members).size).toBe(38)
    expect(members.filter((name) => !(VIAL_API_MEMBER_NAMES as readonly string[]).includes(name))).toEqual([])
    const listeners = members.filter((name) => VIAL_API_MEMBER_KINDS[name as keyof typeof VIAL_API_MEMBER_KINDS] === 'listener')
    expect(listeners.sort()).toEqual(['syncOnFormatStatusChanged', 'syncOnProgress', 'syncOnUnitApplied'])
    for (const { module, members: own } of SYNC_MEMBERS) {
      expect(Object.keys(module).filter((name) => !own.includes(name))).toEqual([])
    }
    expect(members.filter((name) => name in real).sort()).toEqual([...SYNC_REAL].sort())
    expect(members.filter((name) => name in fakes)).toEqual([])
  })

  it('fakes exactly the expected members', () => {
    expect(Object.keys(fakes).sort()).toEqual([...EXPECTED_FAKES].sort())
  })

  it('implements every VialAPI member: no stub is left', () => {
    expect(VIAL_API_MEMBER_NAMES.filter((name) => !(name in implemented))).toEqual([])
  })

  it('backs the startup notification with a backend command', () => {
    expect('notificationFetch' in real).toBe(true)
    expect('notificationFetch' in fakes).toBe(false)
  })

  it('implements only VialAPI members, each either real or fake', () => {
    const members = new Set<string>(VIAL_API_MEMBER_NAMES)
    const names = Object.keys(implemented)
    expect(names.filter((name) => !members.has(name))).toEqual([])
    expect(names.sort()).toEqual([...Object.keys(real), ...Object.keys(fakes)].sort())
  })
})
