// SPDX-License-Identifier: GPL-2.0-or-later

import type { FavoriteType, FavoriteIndex } from './favorite-store'
import type { SnapshotIndex } from './snapshot-store'
import type { AnalyzeFilterSnapshotIndex } from './analyze-filter-store'
import type { AppConfig } from './app-config'
import type { KeyboardMetaIndex, KeyboardMetaSyncUnit } from './keyboard-meta'

export type { AppConfig }
export { DEFAULT_APP_CONFIG } from './app-config'

export interface SyncEnvelope {
  version: 1
  syncUnit: string // "favorites/tapDance" or "keyboards/{uid}/snapshots"
  updatedAt: string // ISO 8601
  salt: string // Base64 16 bytes
  iv: string // Base64 12 bytes
  ciphertext: string // Base64 AES-256-GCM
}

export interface SyncBundle {
  type: 'favorite' | 'layout' | 'analyze-filter' | 'settings' | 'keyboard-meta' | 'typing-analytics-device'
  key: string // FavoriteType, UID, 'keyboard-names' for meta, or `${uid}|${machineHash}` for device
  index: FavoriteIndex | SnapshotIndex | AnalyzeFilterSnapshotIndex | KeyboardMetaIndex
  files: Record<string, string> // filename -> content (empty for meta)
}

export type SyncDirection = 'upload' | 'download'

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'success' | 'partial'

/** Terminal statuses that indicate sync has finished (successfully, partially, or with error). */
export type SyncTerminalStatus = 'success' | 'error' | 'partial'

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<SyncTerminalStatus>(['success', 'error', 'partial'])

export function isSyncTerminalStatus(status: string): status is SyncTerminalStatus {
  return TERMINAL_STATUSES.has(status)
}

export interface SyncProgress {
  direction: SyncDirection
  status: SyncStatus
  message?: string
  syncUnit?: string
  current?: number
  total?: number
  failedUnits?: string[]
  /** Surfaces a credential failure reason so the UI can localize the message. */
  reason?: SyncCredentialFailureReason
}

export interface SyncAuthStatus {
  authenticated: boolean
  email?: string
}

export type FavoriteSyncUnit = `favorites/${FavoriteType}`
export type KeyboardSettingsSyncUnit = `keyboards/${string}/settings`
export type KeyboardSnapshotsSyncUnit = `keyboards/${string}/snapshots`
export type KeyboardAnalyzeFiltersSyncUnit = `keyboards/${string}/analyze_filters`
export type KeyboardTypingAnalyticsDeviceSyncUnit = `keyboards/${string}/devices/${string}`
export type SyncUnit =
  | FavoriteSyncUnit
  | KeyboardSettingsSyncUnit
  | KeyboardSnapshotsSyncUnit
  | KeyboardAnalyzeFiltersSyncUnit
  | KeyboardMetaSyncUnit
  | KeyboardTypingAnalyticsDeviceSyncUnit

export interface PasswordStrength {
  score: number // 0-4
  feedback: string[]
}

export interface LastSyncResult {
  status: SyncTerminalStatus
  message?: string
  failedUnits?: string[]
  timestamp: number
}

export type SyncStatusType = 'pending' | 'syncing' | 'synced' | 'error' | 'partial' | 'none'

export interface SyncResetTargets {
  keyboards: boolean | string[] // true = all, string[] = specific UIDs
  favorites: boolean
}

export interface LocalResetTargets {
  keyboards: boolean
  favorites: boolean
  appSettings: boolean
}

export interface UndecryptableFile {
  fileId: string
  fileName: string
  syncUnit: string | null
}

export interface SyncDataScanResult {
  keyboards: string[]
  /** uid -> deviceName from synced meta (when available) */
  keyboardNames: Record<string, string>
  favorites: string[]
  undecryptable: UndecryptableFile[]
}

export interface StoredKeyboardInfo {
  uid: string
  name: string
}

export type SyncScope =
  | 'all'           // changePassword, listUndecryptable
  | 'favorites'     // favorites/* only
  | { keyboard: string }  // keyboards/{uid}/* only
  | { favorites: true; keyboard: string }  // favorites/* + keyboards/{uid}/*

/**
 * Why the sync subsystem cannot proceed without prompting the user.
 * The same UX surface ("Not synced yet" / "No stored password found") used to
 * collapse all of these into one string, hiding root cause from the user.
 * Values are camelCase so they slot directly into i18n keys
 * (`sync.readiness.<reason>`, `sync.changePasswordError.<reason>`).
 */
export type SyncCredentialFailureReason =
  | 'unauthenticated'         // Google sign-in incomplete / token revoked
  | 'noPasswordFile'          // sync-password.enc has never been written
  | 'decryptFailed'           // file exists but the OS keychain refuses it
  | 'keystoreUnavailable'     // safeStorage.isEncryptionAvailable() === false
  | 'remoteCheckFailed'       // can't reach the remote password-check (network / drive)

export type SyncCredentialI18nNamespace = 'readiness' | 'changePasswordError'

/** Single source of truth: reason → i18n key (used by progress, status, password UI). */
export function syncCredentialI18nKey(
  ns: SyncCredentialI18nNamespace,
  reason: SyncCredentialFailureReason,
): string {
  return `sync.${ns}.${reason}`
}

export type SyncCredentialResult =
  | { ok: true; password: string }
  | { ok: false; reason: SyncCredentialFailureReason }

/** Serializable IPC envelope so renderer code can branch on the reason. */
export interface SyncOperationResult {
  success: boolean
  error?: string
  reason?: SyncCredentialFailureReason
}
