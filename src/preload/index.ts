import { contextBridge, ipcRenderer } from 'electron'
import {
  listDevices,
  openHidDevice,
  closeHidDevice,
  isDeviceOpen,
} from './hid-transport'
import * as protocol from './protocol'
import { IpcChannels } from '../shared/ipc/channels'
import type { DeviceInfo, KeyboardDefinition } from '../shared/types/protocol'
import type { SnapshotMeta } from '../shared/types/snapshot-store'
import type { SavedFavoriteMeta } from '../shared/types/favorite-store'
import type { AppConfig } from '../shared/types/app-config'
import type { SyncAuthStatus, SyncProgress, PasswordStrength, SyncResetTargets, LocalResetTargets } from '../shared/types/sync'
import type { PipetteSettings } from '../shared/types/pipette-settings'
import type { LanguageListEntry } from '../shared/types/language-store'
import type { HubUploadPostParams, HubUpdatePostParams, HubPatchPostParams, HubUploadResult, HubDeleteResult, HubFetchMyPostsResult } from '../shared/types/hub'

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
  loadLayout: (): Promise<{ success: boolean; data?: string; filePath?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_LOAD_LAYOUT),
  exportKeymapC: (content: string, deviceName?: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_EXPORT_KEYMAP_C, content, deviceName),
  exportPdf: (base64Data: string, deviceName?: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_EXPORT_PDF, base64Data, deviceName),
  exportCsv: (content: string, defaultName?: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.FILE_EXPORT_CSV, content, defaultName),
  sideloadJson: (): Promise<{ success: boolean; data?: unknown; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SIDELOAD_JSON),

  // --- Snapshot Store (internal save/load via IPC) ---
  snapshotStoreList: (uid: string): Promise<{ success: boolean; entries?: SnapshotMeta[]; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_LIST, uid),
  snapshotStoreSave: (uid: string, json: string, deviceName: string, label: string): Promise<{ success: boolean; entry?: SnapshotMeta; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_SAVE, uid, json, deviceName, label),
  snapshotStoreLoad: (uid: string, entryId: string): Promise<{ success: boolean; data?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_LOAD, uid, entryId),
  snapshotStoreRename: (uid: string, entryId: string, newLabel: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_RENAME, uid, entryId, newLabel),
  snapshotStoreDelete: (uid: string, entryId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_DELETE, uid, entryId),

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

  // --- Pipette Settings Store (internal save/load via IPC) ---
  pipetteSettingsGet: (uid: string): Promise<PipetteSettings | null> =>
    ipcRenderer.invoke(IpcChannels.PIPETTE_SETTINGS_GET, uid),
  pipetteSettingsSet: (uid: string, prefs: PipetteSettings): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.PIPETTE_SETTINGS_SET, uid, prefs),

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
  syncAuthSignOut: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SYNC_AUTH_SIGN_OUT),
  syncExecute: (direction: 'download' | 'upload'): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SYNC_EXECUTE, direction),
  syncSetPassword: (password: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SYNC_SET_PASSWORD, password),
  syncResetPassword: (password: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SYNC_RESET_PASSWORD, password),
  syncResetTargets: (targets: SyncResetTargets): Promise<{ success: boolean; error?: string }> =>
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
  syncCancelPending: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SYNC_CANCEL_PENDING),
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
  hubFetchMyPosts: (): Promise<HubFetchMyPostsResult> =>
    ipcRenderer.invoke(IpcChannels.HUB_FETCH_MY_POSTS),

  // --- Snapshot Store extensions ---
  snapshotStoreSetHubPostId: (uid: string, entryId: string, hubPostId: string | null): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.SNAPSHOT_STORE_SET_HUB_POST_ID, uid, entryId, hubPostId),

  // --- Data Management ---
  resetKeyboardData: (uid: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.RESET_KEYBOARD_DATA, uid),
  resetLocalTargets: (targets: LocalResetTargets): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.RESET_LOCAL_TARGETS, targets),
  exportLocalData: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.EXPORT_LOCAL_DATA),
  importLocalData: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.IMPORT_LOCAL_DATA),
}

contextBridge.exposeInMainWorld('vialAPI', vialAPI)

// Type declaration for renderer
export type VialAPI = typeof vialAPI
