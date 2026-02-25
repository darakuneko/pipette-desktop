// SPDX-License-Identifier: GPL-2.0-or-later

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
}

export type ThemeMode = 'light' | 'dark' | 'system'
export type AutoLockMinutes = 10 | 20 | 30 | 40 | 50 | 60
export type BasicViewType = 'ansi' | 'iso' | 'list'
export type SplitKeyMode = 'split' | 'flat'

export interface AppConfig {
  autoSync: boolean
  windowState?: WindowState
  theme: ThemeMode
  currentKeyboardLayout: string
  defaultKeyboardLayout: string
  defaultAutoAdvance: boolean
  defaultLayerPanelOpen: boolean
  autoLockTime: AutoLockMinutes
  language?: string
  hubEnabled: boolean
  lastNotificationSeen?: string
  defaultBasicViewType: BasicViewType
  defaultSplitKeyMode: SplitKeyMode
}

export const SETTABLE_APP_CONFIG_KEYS: ReadonlySet<keyof AppConfig> = new Set([
  'autoSync',
  'theme',
  'currentKeyboardLayout',
  'defaultKeyboardLayout',
  'defaultAutoAdvance',
  'defaultLayerPanelOpen',
  'autoLockTime',
  'language',
  'hubEnabled',
  'lastNotificationSeen',
  'defaultBasicViewType',
  'defaultSplitKeyMode',
])

export const DEFAULT_APP_CONFIG: AppConfig = {
  autoSync: false,
  theme: 'system',
  currentKeyboardLayout: 'qwerty',
  defaultKeyboardLayout: 'qwerty',
  defaultAutoAdvance: true,
  defaultLayerPanelOpen: true,
  autoLockTime: 10,
  language: 'en',
  hubEnabled: false,
  defaultBasicViewType: 'ansi',
  defaultSplitKeyMode: 'split',
}
