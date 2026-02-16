// SPDX-License-Identifier: GPL-2.0-or-later
// Type definition for the vialAPI exposed by preload via contextBridge

import type {
  DeviceInfo,
  KeyboardDefinition,
  KeyboardId,
  TapDanceEntry,
  ComboEntry,
  KeyOverrideEntry,
  AltRepeatKeyEntry,
  DynamicEntryCounts,
  UnlockStatus,
} from './protocol'
import type { SnapshotMeta } from './snapshot-store'
import type { SavedFavoriteMeta } from './favorite-store'
import type { AppConfig } from './app-config'
import type { SyncAuthStatus, SyncProgress, PasswordStrength, SyncResetTargets, LocalResetTargets } from './sync'
import type { PipetteSettings } from './pipette-settings'
import type { LanguageListEntry } from './language-store'
import type { HubUploadPostParams, HubUpdatePostParams, HubPatchPostParams, HubUploadResult, HubDeleteResult, HubFetchMyPostsResult, HubUserResult } from './hub'

export interface VialAPI {
  // Device Management
  listDevices(): Promise<DeviceInfo[]>
  openDevice(vendorId: number, productId: number): Promise<boolean>
  closeDevice(): Promise<void>
  isDeviceOpen(): Promise<boolean>

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
  loadLayout(): Promise<{ success: boolean; data?: string; filePath?: string; error?: string }>
  exportKeymapC(content: string, deviceName?: string): Promise<{ success: boolean; filePath?: string; error?: string }>
  exportPdf(base64Data: string, deviceName?: string): Promise<{ success: boolean; filePath?: string; error?: string }>
  exportCsv(content: string, defaultName?: string): Promise<{ success: boolean; filePath?: string; error?: string }>
  sideloadJson(): Promise<{ success: boolean; data?: unknown; error?: string }>

  // Snapshot Store (internal save/load)
  snapshotStoreList(uid: string): Promise<{ success: boolean; entries?: SnapshotMeta[]; error?: string }>
  snapshotStoreSave(uid: string, json: string, deviceName: string, label: string): Promise<{ success: boolean; entry?: SnapshotMeta; error?: string }>
  snapshotStoreLoad(uid: string, entryId: string): Promise<{ success: boolean; data?: string; error?: string }>
  snapshotStoreRename(uid: string, entryId: string, newLabel: string): Promise<{ success: boolean; error?: string }>
  snapshotStoreDelete(uid: string, entryId: string): Promise<{ success: boolean; error?: string }>

  // Favorite Store (internal save/load)
  favoriteStoreList(type: string): Promise<{ success: boolean; entries?: SavedFavoriteMeta[]; error?: string }>
  favoriteStoreSave(type: string, json: string, label: string): Promise<{ success: boolean; entry?: SavedFavoriteMeta; error?: string }>
  favoriteStoreLoad(type: string, entryId: string): Promise<{ success: boolean; data?: string; error?: string }>
  favoriteStoreRename(type: string, entryId: string, newLabel: string): Promise<{ success: boolean; error?: string }>
  favoriteStoreDelete(type: string, entryId: string): Promise<{ success: boolean; error?: string }>

  // Pipette Settings Store
  pipetteSettingsGet(uid: string): Promise<PipetteSettings | null>
  pipetteSettingsSet(uid: string, prefs: PipetteSettings): Promise<{ success: boolean; error?: string }>

  // App Config
  appConfigGetAll(): Promise<AppConfig>
  appConfigSet(key: string, value: unknown): Promise<void>

  // Sync
  syncAuthStart(): Promise<{ success: boolean; error?: string }>
  syncAuthStatus(): Promise<SyncAuthStatus>
  syncAuthSignOut(): Promise<{ success: boolean; error?: string }>
  syncExecute(direction: 'download' | 'upload'): Promise<{ success: boolean; error?: string }>
  syncSetPassword(password: string): Promise<{ success: boolean; error?: string }>
  syncResetPassword(password: string): Promise<{ success: boolean; error?: string }>
  syncResetTargets(targets: SyncResetTargets): Promise<{ success: boolean; error?: string }>
  syncHasPassword(): Promise<boolean>
  syncValidatePassword(password: string): Promise<PasswordStrength>
  syncOnProgress(callback: (progress: SyncProgress) => void): () => void
  syncHasPendingChanges(): Promise<boolean>
  syncCancelPending(): Promise<{ success: boolean; error?: string }>
  syncOnPendingChange(callback: (pending: boolean) => void): () => void

  // Language Store
  langList(): Promise<LanguageListEntry[]>
  langGet(name: string): Promise<unknown>
  langDownload(name: string): Promise<{ success: boolean; error?: string }>
  langDelete(name: string): Promise<{ success: boolean; error?: string }>

  // Data management
  resetKeyboardData(uid: string): Promise<{ success: boolean; error?: string }>
  resetLocalTargets(targets: LocalResetTargets): Promise<{ success: boolean; error?: string }>
  exportLocalData(): Promise<{ success: boolean; error?: string }>
  importLocalData(): Promise<{ success: boolean; error?: string }>

  // Hub
  hubUploadPost(params: HubUploadPostParams): Promise<HubUploadResult>
  hubUpdatePost(params: HubUpdatePostParams): Promise<HubUploadResult>
  hubPatchPost(params: HubPatchPostParams): Promise<HubDeleteResult>
  hubDeletePost(postId: string): Promise<HubDeleteResult>
  hubFetchMyPosts(): Promise<HubFetchMyPostsResult>
  hubFetchAuthMe(): Promise<HubUserResult>
  hubPatchAuthMe(displayName: string | null): Promise<HubUserResult>

  // Snapshot Store extensions
  snapshotStoreSetHubPostId(uid: string, entryId: string, hubPostId: string | null): Promise<{ success: boolean; error?: string }>
}
