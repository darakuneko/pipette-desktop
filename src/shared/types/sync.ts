// SPDX-License-Identifier: GPL-2.0-or-later

import type { FavoriteType, FavoriteIndex } from './favorite-store'
import type { SnapshotIndex } from './snapshot-store'
import type { AppConfig } from './app-config'

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
  type: 'favorite' | 'layout' | 'settings'
  key: string // FavoriteType or UID
  index: FavoriteIndex | SnapshotIndex
  files: Record<string, string> // filename -> content
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
}

export interface SyncAuthStatus {
  authenticated: boolean
  email?: string
}

export type FavoriteSyncUnit = `favorites/${FavoriteType}`
export type KeyboardSettingsSyncUnit = `keyboards/${string}/settings`
export type KeyboardSnapshotsSyncUnit = `keyboards/${string}/snapshots`
export type SyncUnit = FavoriteSyncUnit | KeyboardSettingsSyncUnit | KeyboardSnapshotsSyncUnit

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
  keyboards: boolean
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

export type SyncScope =
  | 'all'           // changePassword, listUndecryptable
  | 'favorites'     // favorites/* only
  | { keyboard: string }  // keyboards/{uid}/* only
  | { favorites: true; keyboard: string }  // favorites/* + keyboards/{uid}/*
