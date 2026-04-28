// SPDX-License-Identifier: GPL-2.0-or-later

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
}

export type ThemeMode = 'light' | 'dark' | 'system'
export type AutoLockMinutes = 10 | 20 | 30 | 40 | 50 | 60
export type BasicViewType = 'ansi' | 'iso' | 'jis' | 'list'
export type SplitKeyMode = 'split' | 'flat'

/** Window length options (minutes) for the typing-view heatmap. The
 * UI exposes 1, 2, 3 minutes for "reactive" overlays and then a 5-min
 * step up to an hour. Hits older than the window are dropped; inside
 * the window each per-poll delta decays smoothly so the colour fades
 * before it disappears. Kept as a string-literal tuple so the
 * renderer dropdown, the AppConfig value, and the test fixtures all
 * reference the same canonical list. */
export const TYPING_HEATMAP_WINDOW_OPTIONS = [
  1, 2, 3, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60,
] as const
export type TypingHeatmapWindowMin = typeof TYPING_HEATMAP_WINDOW_OPTIONS[number]

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
  defaultQuickSelect: boolean
  maxKeymapHistory: number
  typingHeatmapWindowMin: TypingHeatmapWindowMin
  /** True once the user has accepted the typing-analytics recording
   * disclosure. Gates the REC-tab "Start" button so the modal can
   * surface what the recorder collects vs what it does not. */
  typingRecordingConsentAccepted: boolean
  /** Whether to record the active application name alongside typing
   * data while REC is on. Resolved per flush in the main process — no
   * setInterval is spawned. When false the analytics aggregator
   * receives null and minute payloads carry appName=null. The Monitor
   * App tab in the typing view exposes the toggle; UI only enables
   * the toggle while REC is running. */
  typingMonitorAppEnabled: boolean
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
  'defaultQuickSelect',
  'maxKeymapHistory',
  'typingHeatmapWindowMin',
  'typingRecordingConsentAccepted',
  'typingMonitorAppEnabled',
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
  defaultQuickSelect: false,
  maxKeymapHistory: 100,
  typingHeatmapWindowMin: 5,
  typingRecordingConsentAccepted: false,
  typingMonitorAppEnabled: true,
}
