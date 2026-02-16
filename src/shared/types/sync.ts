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

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'success'

export interface SyncProgress {
  direction: SyncDirection
  status: SyncStatus
  message?: string
  syncUnit?: string
  current?: number
  total?: number
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
  status: 'success' | 'error'
  message?: string
  timestamp: number
}

export type SyncStatusType = 'pending' | 'syncing' | 'synced' | 'error' | 'none'

export interface SyncResetTargets {
  keyboards: boolean
  favorites: boolean
}

export interface LocalResetTargets {
  keyboards: boolean
  favorites: boolean
  appSettings: boolean
}
