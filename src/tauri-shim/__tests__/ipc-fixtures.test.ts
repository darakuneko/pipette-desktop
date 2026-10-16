// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// Replays the invoke fixtures (src-tauri/tests/fixtures/ipc/<domain>.json)
// against the shim: calling `member` with `args` invokes `command` with
// `invokeArgs` and nothing else, and resolves with `response`. The Rust
// tests (src-tauri/src/ipc_contract.rs) check the same entries against the
// commands' argument and return types.
//
// `member` is a VialAPI member, or `<module>.<export>` for a shim function
// that is not one.

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { APP_COMMANDS } from '../generated/app-command-names'
import { typingAnalyticsApi } from '../api/typing-analytics'
import { typingAnalyticsDataApi } from '../api/typing-analytics-data'
import { typingAnalyticsRangeApi } from '../api/typing-analytics-range'
import type { FavoriteImportEntry } from '../../shared/favorite-transfer'
import type { FavoriteType } from '../../shared/types/favorite-store'
import type { HubPrivateLink } from '../../shared/types/hub-private'
import type { I18nPackImportApplyOptions } from '../../shared/types/i18n-store'
import type { SnapshotUpdateOptions } from '../../shared/types/snapshot-store'
import type { ThemePackImportApplyOptions } from '../../shared/types/theme-store'
import type { TypingAnalyticsEvent, TypingKeymapSnapshot } from '../../shared/types/typing-analytics'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { VialAPI } from '../../shared/types/vial-api'

interface Entry {
  member: string
  args: unknown[]
  command: string
  invokeArgs: Record<string, unknown>
  response: unknown
}

const FIXTURE_DIR = resolve(__dirname, '../../../src-tauri/tests/fixtures/ipc')

const entries: Entry[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .flatMap((name) => JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8')) as Entry[])

interface Shim {
  analyzeFilters: typeof import('../api/analyze-filters')
  appConfig: typeof import('../api/app-config')
  device: typeof import('../api/device')
  favorites: typeof import('../api/favorites')
  files: typeof import('../api/files')
  i18nPacks: typeof import('../api/i18n-packs')
  keyLabels: typeof import('../api/key-labels')
  keyboardData: typeof import('../api/keyboard-data')
  runLogs: typeof import('../api/run-logs')
  settings: typeof import('../api/settings')
  shell: typeof import('../api/shell')
  snapshots: typeof import('../api/snapshots')
  typingAnalyticsKeymaps: typeof import('../api/typing-analytics-keymaps')
  typingAnalyticsRecord: typeof import('../api/typing-analytics-record')
  typingTexts: typeof import('../api/typing-texts')
  syncPending: typeof import('../api/sync-pending')
  syncAuth: typeof import('../api/sync-auth')
  syncPassword: typeof import('../api/sync-password')
  syncExecute: typeof import('../api/sync-execute')
  syncData: typeof import('../api/sync-data')
  themePacks: typeof import('../api/theme-packs')
  typingAnalytics: typeof import('../api/typing-analytics')
  typingAnalyticsRange: typeof import('../api/typing-analytics-range')
  typingAnalyticsData: typeof import('../api/typing-analytics-data')
  typingDatasets: typeof import('../api/typing-datasets')
  window: typeof import('../api/window')
  transport: typeof import('../hid-transport')
}

/** Fresh modules for each entry: the transport keeps the open flag. */
async function load(): Promise<Shim> {
  vi.resetModules()
  return {
    analyzeFilters: await import('../api/analyze-filters'),
    appConfig: await import('../api/app-config'),
    device: await import('../api/device'),
    favorites: await import('../api/favorites'),
    files: await import('../api/files'),
    i18nPacks: await import('../api/i18n-packs'),
    keyLabels: await import('../api/key-labels'),
    keyboardData: await import('../api/keyboard-data'),
    runLogs: await import('../api/run-logs'),
    settings: await import('../api/settings'),
    shell: await import('../api/shell'),
    snapshots: await import('../api/snapshots'),
    typingAnalyticsKeymaps: await import('../api/typing-analytics-keymaps'),
    typingAnalyticsRecord: await import('../api/typing-analytics-record'),
    typingTexts: await import('../api/typing-texts'),
    syncPending: await import('../api/sync-pending'),
    syncAuth: await import('../api/sync-auth'),
    syncPassword: await import('../api/sync-password'),
    syncExecute: await import('../api/sync-execute'),
    syncData: await import('../api/sync-data'),
    themePacks: await import('../api/theme-packs'),
    typingAnalytics: await import('../api/typing-analytics'),
    typingAnalyticsRange: await import('../api/typing-analytics-range'),
    typingAnalyticsData: await import('../api/typing-analytics-data'),
    typingDatasets: await import('../api/typing-datasets'),
    window: await import('../api/window'),
    transport: await import('../hid-transport'),
  }
}

interface Caller {
  /** Puts the shim in the state the call needs, before the calls are recorded. */
  setup?: (shim: Shim) => Promise<unknown>
  /** Calls the member; a member that resolves with nothing resolves with undefined here. */
  run: (shim: Shim, args: unknown[]) => Promise<unknown>
  /** The member resolves with nothing, whatever the command responds. */
  void?: true
}

const bytes = (value: unknown): Uint8Array => Uint8Array.from(value as number[])

/** A caller per member of a typing analytics query module, calling it with
 *  the recorded arguments as they are. `api` gives the member names; the
 *  call goes to the fresh module `pick` takes from the shim. */
function queryCallers(pick: (shim: Shim) => object, api: object): Record<string, Caller> {
  return Object.fromEntries(
    Object.keys(api).map((member) => [
      member,
      {
        run: (shim: Shim, args: unknown[]) =>
          (pick(shim) as Record<string, (...args: unknown[]) => Promise<unknown>>)[member](...args),
      },
    ]),
  )
}

const CALLERS: Record<string, Caller> = {
  listDevices: { run: ({ device }) => device.deviceApi.listDevices() },
  openDevice: {
    run: ({ device }, [vendorId, productId]) => device.deviceApi.openDevice(vendorId as number, productId as number),
  },
  closeDevice: { run: ({ device }) => device.deviceApi.closeDevice(), void: true },
  // A closed transport answers false without asking the backend.
  isDeviceOpen: {
    setup: ({ device }) => device.deviceApi.openDevice(1, 2),
    run: ({ device }) => device.deviceApi.isDeviceOpen(),
  },
  'hid-transport.sendReceive': {
    run: async ({ transport }, [data]) => Array.from(await transport.sendReceive(bytes(data))),
  },
  'hid-transport.send': { run: ({ transport }, [data]) => transport.send(bytes(data)), void: true },
  appConfigGetAll: { run: ({ appConfig }) => appConfig.appConfigApi.appConfigGetAll() },
  appConfigSet: {
    run: ({ appConfig }, [key, value]) => appConfig.appConfigApi.appConfigSet(key as string, value),
    void: true,
  },
  'device.decompressDefinition': {
    run: ({ device }, [data]) => device.decompressDefinition(data as number[]),
  },
  'device.probeOpen': {
    run: ({ device }, [vendorId, productId, serialNumber]) =>
      device.probeOpen(vendorId as number, productId as number, serialNumber as string),
  },
  'device.probeSendReceive': {
    run: ({ device }, [id, data]) => device.probeSendReceive(id as number, data as number[]),
  },
  'device.probeClose': { run: ({ device }, [id]) => device.probeClose(id as number), void: true },
  openExternal: { run: ({ shell }, [url]) => shell.shellApi.openExternal(url as string), void: true },
  setWindowZoom: { run: ({ window }, [zoom]) => window.windowApi.setWindowZoom(zoom as number), void: true },
  windowShow: { run: ({ window }) => window.windowApi.windowShow() },
  windowHide: { run: ({ window }) => window.windowApi.windowHide(), void: true },
  windowStartedHidden: { run: ({ window }) => window.windowApi.windowStartedHidden() },
  windowIsVisible: { run: ({ window }) => window.windowApi.windowIsVisible() },
  syncHasPendingChanges: { run: ({ syncPending }) => syncPending.syncPendingApi.syncHasPendingChanges() },
  syncAuthStatus: { run: ({ syncAuth }) => syncAuth.syncAuthApi.syncAuthStatus() },
  syncAuthStart: { run: ({ syncAuth }) => syncAuth.syncAuthApi.syncAuthStart() },
  syncAuthSignOut: { run: ({ syncAuth }) => syncAuth.syncAuthApi.syncAuthSignOut() },
  syncPasswordStatus: { run: ({ syncPassword }) => syncPassword.syncPasswordApi.syncPasswordStatus() },
  syncSetPassword: { run: ({ syncPassword }, [password]) => syncPassword.syncPasswordApi.syncSetPassword(password as string) },
  syncReplacePassword: {
    run: ({ syncPassword }, [password]) => syncPassword.syncPasswordApi.syncReplacePassword(password as string),
  },
  syncCheckPasswordExists: { run: ({ syncPassword }) => syncPassword.syncPasswordApi.syncCheckPasswordExists() },
  syncFormatStatus: { run: ({ syncExecute }) => syncExecute.syncExecuteApi.syncFormatStatus() },
  exportLocalData: { run: ({ syncData }) => syncData.syncDataApi.exportLocalData() },
  importLocalData: { run: ({ syncData }) => syncData.syncDataApi.importLocalData() },
  saveLayout: { run: ({ files }, [json, name]) => files.filesApi.saveLayout(json as string, name as string) },
  loadLayout: {
    run: ({ files }, [title, extensions]) => files.filesApi.loadLayout(title as string, extensions as string[]),
  },
  exportKeymapC: {
    run: ({ files }, [content, name]) => files.filesApi.exportKeymapC(content as string, name as string),
  },
  exportPdf: { run: ({ files }, [data, name]) => files.filesApi.exportPdf(data as string, name as string) },
  exportCsv: { run: ({ files }, [content, name]) => files.filesApi.exportCsv(content as string, name as string) },
  exportCsvBundle: {
    run: ({ files }, [list]) => files.filesApi.exportCsvBundle(list as { name: string; content: string }[]),
  },
  exportJson: { run: ({ files }, [content, name]) => files.filesApi.exportJson(content as string, name as string) },
  sideloadJson: { run: ({ files }, [title]) => files.filesApi.sideloadJson(title as string) },
  listStoredKeyboards: { run: ({ keyboardData }) => keyboardData.keyboardDataApi.listStoredKeyboards() },
  keyboardMetaNameIfMissing: {
    run: ({ keyboardData }, [uid, name]) => keyboardData.keyboardDataApi.keyboardMetaNameIfMissing(uid as string, name as string),
    void: true,
  },
  favoriteStoreList: { run: ({ favorites }, [type]) => favorites.favoritesApi.favoriteStoreList(type as string) },
  favoriteStoreSave: {
    run: ({ favorites }, [type, json, label]) =>
      favorites.favoritesApi.favoriteStoreSave(type as string, json as string, label as string),
  },
  favoriteStoreLoad: {
    run: ({ favorites }, [type, entryId]) => favorites.favoritesApi.favoriteStoreLoad(type as string, entryId as string),
  },
  favoriteStoreRename: {
    run: ({ favorites }, [type, entryId, label]) =>
      favorites.favoritesApi.favoriteStoreRename(type as string, entryId as string, label as string),
  },
  favoriteStoreDelete: {
    run: ({ favorites }, [type, entryId]) => favorites.favoritesApi.favoriteStoreDelete(type as string, entryId as string),
  },
  favoriteStoreSetHubPostId: {
    run: ({ favorites }, [type, entryId, postId]) =>
      favorites.favoritesApi.favoriteStoreSetHubPostId(type as FavoriteType, entryId as string, postId as string | null),
  },
  favoriteStoreSetHubPrivate: {
    run: ({ favorites }, [type, entryId, link]) =>
      favorites.favoritesApi.favoriteStoreSetHubPrivate(type as FavoriteType, entryId as string, link as HubPrivateLink | null),
  },
  'favorites.readForExport': {
    run: ({ favorites }, [type, entryId]) => favorites.readForExport(type as FavoriteType, entryId as string),
  },
  'favorites.saveExport': {
    run: ({ favorites }, [name, content]) => favorites.saveExport(name as string, content as string),
  },
  'favorites.openImport': { run: ({ favorites }) => favorites.openImport() },
  'favorites.importBatch': {
    run: ({ favorites }, [type, entries]) => favorites.importBatch(type as FavoriteType, entries as FavoriteImportEntry[]),
  },
  keyLabelStoreList: { run: ({ keyLabels }) => keyLabels.keyLabelsApi.keyLabelStoreList() },
  keyLabelStoreListAll: { run: ({ keyLabels }) => keyLabels.keyLabelsApi.keyLabelStoreListAll() },
  keyLabelStoreGet: { run: ({ keyLabels }, [id]) => keyLabels.keyLabelsApi.keyLabelStoreGet(id as string) },
  keyLabelStoreRename: {
    run: ({ keyLabels }, [id, name]) => keyLabels.keyLabelsApi.keyLabelStoreRename(id as string, name as string),
  },
  keyLabelStoreDelete: { run: ({ keyLabels }, [id]) => keyLabels.keyLabelsApi.keyLabelStoreDelete(id as string) },
  keyLabelStoreImport: { run: ({ keyLabels }) => keyLabels.keyLabelsApi.keyLabelStoreImport() },
  keyLabelStoreExport: { run: ({ keyLabels }, [id]) => keyLabels.keyLabelsApi.keyLabelStoreExport(id as string) },
  keyLabelStoreReorder: {
    run: ({ keyLabels }, [ids]) => keyLabels.keyLabelsApi.keyLabelStoreReorder(ids as string[]),
  },
  keyLabelStoreSetHubPostId: {
    run: ({ keyLabels }, [id, postId]) =>
      keyLabels.keyLabelsApi.keyLabelStoreSetHubPostId(id as string, postId as string | null),
  },
  keyLabelStoreHasName: {
    run: ({ keyLabels }, [name, excludeId]) =>
      keyLabels.keyLabelsApi.keyLabelStoreHasName(name as string, excludeId as string | undefined),
  },
  typingTestTextStoreList: { run: ({ typingTexts }) => typingTexts.typingTextsApi.typingTestTextStoreList() },
  typingTestTextStoreGet: {
    run: ({ typingTexts }, [id]) => typingTexts.typingTextsApi.typingTestTextStoreGet(id as string),
  },
  typingTestTextStoreRename: {
    run: ({ typingTexts }, [id, name]) => typingTexts.typingTextsApi.typingTestTextStoreRename(id as string, name as string),
  },
  typingTestTextStoreDelete: {
    run: ({ typingTexts }, [id]) => typingTexts.typingTextsApi.typingTestTextStoreDelete(id as string),
  },
  typingTestTextStoreImport: { run: ({ typingTexts }) => typingTexts.typingTextsApi.typingTestTextStoreImport() },
  typingTestTextStoreImportConfirm: {
    run: ({ typingTexts }) => typingTexts.typingTextsApi.typingTestTextStoreImportConfirm(),
  },
  snapshotStoreList: { run: ({ snapshots }, [uid]) => snapshots.snapshotsApi.snapshotStoreList(uid as string) },
  snapshotStoreSave: {
    run: ({ snapshots }, [uid, json, deviceName, label, vilVersion]) =>
      snapshots.snapshotsApi.snapshotStoreSave(uid as string, json as string, deviceName as string, label as string, vilVersion as number),
  },
  snapshotStoreLoad: {
    run: ({ snapshots }, [uid, entryId]) => snapshots.snapshotsApi.snapshotStoreLoad(uid as string, entryId as string),
  },
  snapshotStoreUpdate: {
    run: ({ snapshots }, [uid, entryId, json, vilVersion, options]) =>
      snapshots.snapshotsApi.snapshotStoreUpdate(uid as string, entryId as string, json as string, vilVersion as number, options as SnapshotUpdateOptions),
  },
  snapshotStoreRename: {
    run: ({ snapshots }, [uid, entryId, label]) => snapshots.snapshotsApi.snapshotStoreRename(uid as string, entryId as string, label as string),
  },
  snapshotStoreDelete: {
    run: ({ snapshots }, [uid, entryId]) => snapshots.snapshotsApi.snapshotStoreDelete(uid as string, entryId as string),
  },
  snapshotStoreSetHubPostId: {
    run: ({ snapshots }, [uid, entryId, postId]) =>
      snapshots.snapshotsApi.snapshotStoreSetHubPostId(uid as string, entryId as string, postId as string | null),
  },
  snapshotStoreSetHubPrivate: {
    run: ({ snapshots }, [uid, entryId, link]) =>
      snapshots.snapshotsApi.snapshotStoreSetHubPrivate(uid as string, entryId as string, link as HubPrivateLink | null),
  },
  analyzeFilterStoreList: {
    run: ({ analyzeFilters }, [uid]) => analyzeFilters.analyzeFiltersApi.analyzeFilterStoreList(uid as string),
  },
  analyzeFilterStoreSave: {
    run: ({ analyzeFilters }, [uid, json, label, summary]) =>
      analyzeFilters.analyzeFiltersApi.analyzeFilterStoreSave(uid as string, json as string, label as string, summary as string),
  },
  analyzeFilterStoreLoad: {
    run: ({ analyzeFilters }, [uid, entryId]) =>
      analyzeFilters.analyzeFiltersApi.analyzeFilterStoreLoad(uid as string, entryId as string),
  },
  analyzeFilterStoreUpdate: {
    run: ({ analyzeFilters }, [uid, entryId, json]) =>
      analyzeFilters.analyzeFiltersApi.analyzeFilterStoreUpdate(uid as string, entryId as string, json as string),
  },
  analyzeFilterStoreRename: {
    run: ({ analyzeFilters }, [uid, entryId, label]) =>
      analyzeFilters.analyzeFiltersApi.analyzeFilterStoreRename(uid as string, entryId as string, label as string),
  },
  analyzeFilterStoreDelete: {
    run: ({ analyzeFilters }, [uid, entryId]) =>
      analyzeFilters.analyzeFiltersApi.analyzeFilterStoreDelete(uid as string, entryId as string),
  },
  analyzeFilterStoreSetHubPostId: {
    run: ({ analyzeFilters }, [uid, entryId, postId]) =>
      analyzeFilters.analyzeFiltersApi.analyzeFilterStoreSetHubPostId(uid as string, entryId as string, postId as string | null),
  },
  analyzeFilterStoreSetHubPrivate: {
    run: ({ analyzeFilters }, [uid, entryId, link]) =>
      analyzeFilters.analyzeFiltersApi.analyzeFilterStoreSetHubPrivate(uid as string, entryId as string, link as HubPrivateLink | null),
  },
  typingRunLogSave: {
    run: ({ runLogs }, [uid, log]) => runLogs.runLogsApi.typingRunLogSave(uid as string, log as RunKeystrokeLog),
  },
  ...queryCallers((shim) => shim.typingAnalytics.typingAnalyticsApi, typingAnalyticsApi),
  ...queryCallers((shim) => shim.typingAnalyticsRange.typingAnalyticsRangeApi, typingAnalyticsRangeApi),
  ...queryCallers((shim) => shim.typingAnalyticsData.typingAnalyticsDataApi, typingAnalyticsDataApi),
  typingRunLogList: { run: ({ runLogs }, [uid]) => runLogs.runLogsApi.typingRunLogList(uid as string) },
  typingRunLogGet: {
    run: ({ runLogs }, [uid, runId]) => runLogs.runLogsApi.typingRunLogGet(uid as string, runId as string),
  },
  typingAnalyticsSaveKeymapSnapshot: {
    run: ({ typingAnalyticsKeymaps }, [snapshot]) =>
      typingAnalyticsKeymaps.typingAnalyticsKeymapsApi.typingAnalyticsSaveKeymapSnapshot(
        snapshot as Omit<TypingKeymapSnapshot, 'machineHash'>,
      ),
  },
  typingAnalyticsGetKeymapSnapshotForRange: {
    run: ({ typingAnalyticsKeymaps }, [uid, fromMs, toMs]) =>
      typingAnalyticsKeymaps.typingAnalyticsKeymapsApi.typingAnalyticsGetKeymapSnapshotForRange(
        uid as string,
        fromMs as number,
        toMs as number,
      ),
  },
  typingAnalyticsListKeymapSnapshots: {
    run: ({ typingAnalyticsKeymaps }, [uid]) =>
      typingAnalyticsKeymaps.typingAnalyticsKeymapsApi.typingAnalyticsListKeymapSnapshots(uid as string),
  },
  typingAnalyticsEvent: {
    run: ({ typingAnalyticsRecord }, [event]) =>
      typingAnalyticsRecord.typingAnalyticsRecordApi.typingAnalyticsEvent(event as TypingAnalyticsEvent),
    void: true,
  },
  typingAnalyticsFlush: {
    run: ({ typingAnalyticsRecord }, [uid]) => typingAnalyticsRecord.typingAnalyticsRecordApi.typingAnalyticsFlush(uid as string),
    void: true,
  },
  'settings.readSettingsFile': { run: ({ settings }, [uid]) => settings.readSettingsFile(uid as string) },
  'settings.writeSettingsFile': {
    run: ({ settings }, [uid, content, etag]) => settings.writeSettingsFile(uid as string, content as string, etag as string),
  },
  'settings.ensureSettingsDir': { run: ({ settings }, [uid]) => settings.ensureSettingsDir(uid as string), void: true },
  'settings.readAllSettingsFiles': { run: ({ settings }) => settings.readAllSettingsFiles() },
  langList: { run: ({ typingDatasets }, [provider]) => typingDatasets.typingDatasetsApi.langList(provider as string) },
  langGet: {
    run: ({ typingDatasets }, [name, provider]) => typingDatasets.typingDatasetsApi.langGet(name as string, provider as string),
  },
  langDownload: {
    run: ({ typingDatasets }, [name, provider]) =>
      typingDatasets.typingDatasetsApi.langDownload(name as string, provider as string),
  },
  langDelete: {
    run: ({ typingDatasets }, [name, provider]) =>
      typingDatasets.typingDatasetsApi.langDelete(name as string, provider as string),
  },
  checkTypingDatasetUpdate: {
    run: ({ typingDatasets }, [provider]) => typingDatasets.typingDatasetsApi.checkTypingDatasetUpdate(provider as string),
  },
  updateTypingDataset: {
    run: ({ typingDatasets }, [provider]) => typingDatasets.typingDatasetsApi.updateTypingDataset(provider as string),
  },
  aozoraImport: {
    run: ({ typingDatasets }, [workId]) => typingDatasets.typingDatasetsApi.aozoraImport(workId as string),
  },
  i18nPackList: { run: ({ i18nPacks }) => i18nPacks.i18nPacksApi.i18nPackList() },
  i18nPackGet: { run: ({ i18nPacks }, [id]) => i18nPacks.i18nPacksApi.i18nPackGet(id as string) },
  i18nPackRename: {
    run: ({ i18nPacks }, [id, name]) => i18nPacks.i18nPacksApi.i18nPackRename(id as string, name as string),
  },
  i18nPackSetEnabled: {
    run: ({ i18nPacks }, [id, enabled]) => i18nPacks.i18nPacksApi.i18nPackSetEnabled(id as string, enabled as boolean),
  },
  i18nPackRefreshCoverage: {
    run: ({ i18nPacks }, [id, values]) =>
      i18nPacks.i18nPacksApi.i18nPackRefreshCoverage(id as string, values as Parameters<VialAPI['i18nPackRefreshCoverage']>[1]),
  },
  i18nPackDelete: { run: ({ i18nPacks }, [id]) => i18nPacks.i18nPacksApi.i18nPackDelete(id as string) },
  i18nPackSetHubPostId: {
    run: ({ i18nPacks }, [id, postId, uploader, updatedAt]) =>
      i18nPacks.i18nPacksApi.i18nPackSetHubPostId(id as string, postId as string | null, uploader as string, updatedAt as string),
  },
  i18nPackHasName: {
    run: ({ i18nPacks }, [name, excludeId]) => i18nPacks.i18nPacksApi.i18nPackHasName(name as string, excludeId as string | undefined),
  },
  i18nPackReorder: { run: ({ i18nPacks }, [ids]) => i18nPacks.i18nPacksApi.i18nPackReorder(ids as string[]) },
  'i18n-packs.openImport': { run: ({ i18nPacks }) => i18nPacks.openImport() },
  i18nPackImportApply: {
    run: ({ i18nPacks }, [raw, options]) =>
      i18nPacks.i18nPacksApi.i18nPackImportApply(raw, options as I18nPackImportApplyOptions),
  },
  i18nPackExport: { run: ({ i18nPacks }, [id]) => i18nPacks.i18nPacksApi.i18nPackExport(id as string) },
  themePackList: { run: ({ themePacks }) => themePacks.themePacksApi.themePackList() },
  themePackGet: { run: ({ themePacks }, [id]) => themePacks.themePacksApi.themePackGet(id as string) },
  themePackRename: {
    run: ({ themePacks }, [id, name]) => themePacks.themePacksApi.themePackRename(id as string, name as string),
  },
  themePackDelete: { run: ({ themePacks }, [id]) => themePacks.themePacksApi.themePackDelete(id as string) },
  themePackSetHubPostId: {
    run: ({ themePacks }, [id, postId, uploader, updatedAt]) =>
      themePacks.themePacksApi.themePackSetHubPostId(id as string, postId as string | null, uploader as string, updatedAt as string),
  },
  themePackHasName: {
    run: ({ themePacks }, [name, excludeId]) => themePacks.themePacksApi.themePackHasName(name as string, excludeId as string | undefined),
  },
  themePackReorder: { run: ({ themePacks }, [ids]) => themePacks.themePacksApi.themePackReorder(ids as string[]) },
  'theme-packs.openImport': { run: ({ themePacks }) => themePacks.openImport() },
  themePackImportApply: {
    run: ({ themePacks }, [raw, options]) =>
      themePacks.themePacksApi.themePackImportApply(raw, options as ThemePackImportApplyOptions),
  },
  themePackExport: { run: ({ themePacks }, [id]) => themePacks.themePacksApi.themePackExport(id as string) },
}

afterEach(() => {
  clearMocks()
})

describe('invoke fixtures', () => {
  it('cover every app command', () => {
    const commands = new Set(entries.map((entry) => entry.command))
    for (const command of APP_COMMANDS) {
      expect(commands.has(command), command).toBe(true)
    }
  })

  it.each(entries.map((entry) => [`${entry.member} (${entry.command})`, entry] as const))(
    '%s invokes the command with the recorded arguments and resolves with the response',
    async (_name, entry) => {
      const caller = CALLERS[entry.member]
      expect(caller, `no caller for ${entry.member}`).toBeDefined()
      const calls: [string, unknown][] = []
      mockIPC((cmd, payload) => {
        calls.push([cmd, payload])
        if (cmd === entry.command) return entry.response
        if (cmd === 'open_device') return true
        throw new Error(`unexpected command ${cmd}`)
      })
      const shim = await load()
      await caller.setup?.(shim)
      calls.length = 0

      const result = await caller.run(shim, entry.args)
      expect(calls).toEqual([[entry.command, entry.invokeArgs]])
      expect(result).toEqual(caller.void ? undefined : entry.response)
    },
  )
})
