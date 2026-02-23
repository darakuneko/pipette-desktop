// SPDX-License-Identifier: GPL-2.0-or-later

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
}

export type ThemeMode = 'light' | 'dark' | 'system'
export type AutoLockMinutes = 10 | 20 | 30 | 40 | 50 | 60
export type PanelSide = 'left' | 'right'

export interface AppConfig {
  autoSync: boolean
  windowState?: WindowState
  theme: ThemeMode
  currentKeyboardLayout: string
  defaultKeyboardLayout: string
  defaultAutoAdvance: boolean
  defaultLayerPanelOpen: boolean
  autoLockTime: AutoLockMinutes
  panelSide: PanelSide
  language?: string
  hubEnabled: boolean
  lastNotificationSeen?: string
}

export const SETTABLE_APP_CONFIG_KEYS: ReadonlySet<keyof AppConfig> = new Set([
  'autoSync',
  'theme',
  'currentKeyboardLayout',
  'defaultKeyboardLayout',
  'defaultAutoAdvance',
  'defaultLayerPanelOpen',
  'autoLockTime',
  'panelSide',
  'language',
  'hubEnabled',
  'lastNotificationSeen',
])

export const DEFAULT_APP_CONFIG: AppConfig = {
  autoSync: false,
  theme: 'system',
  currentKeyboardLayout: 'qwerty',
  defaultKeyboardLayout: 'qwerty',
  defaultAutoAdvance: true,
  defaultLayerPanelOpen: true,
  autoLockTime: 10,
  panelSide: 'left',
  language: 'en',
  hubEnabled: false,
}
