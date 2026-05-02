// SPDX-License-Identifier: GPL-2.0-or-later

import type { LucideIcon } from 'lucide-react'
import { Monitor, Sun, Moon } from 'lucide-react'
import type { UseSyncReturn } from '../../hooks/useSync'
import type { ThemeMode } from '../../hooks/useTheme'
import type { KeyboardLayoutId, AutoLockMinutes } from '../../hooks/useDevicePrefs'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'

export function scoreColor(score: number | null): string {
  if (score === null) return 'bg-surface-dim'
  if (score < 2) return 'bg-danger'
  if (score < 4) return 'bg-warning'
  return 'bg-accent'
}

export function toggleSetItem<T>(prev: Set<T>, item: T, selected: boolean): Set<T> {
  const next = new Set(prev)
  if (selected) next.add(item)
  else next.delete(item)
  return next
}

export const BTN_PRIMARY = 'rounded bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50'
export const BTN_SECONDARY = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50'
export const BTN_DANGER_OUTLINE = 'rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50'

export interface ThemeOption {
  mode: ThemeMode
  icon: LucideIcon
}

export const THEME_OPTIONS: ThemeOption[] = [
  { mode: 'system', icon: Monitor },
  { mode: 'light', icon: Sun },
  { mode: 'dark', icon: Moon },
]

export const TIME_STEPS = [10, 20, 30, 40, 50, 60] as const

export const TABS = [
  { id: 'tools' as const, labelKey: 'settings.tabTools' },
  { id: 'data' as const, labelKey: 'settings.tabData' },
  { id: 'notification' as const, labelKey: 'settings.tabNotification' },
  { id: 'about' as const, labelKey: 'settings.tabAbout' },
]

export interface SettingsModalProps {
  sync: UseSyncReturn
  connectedKeyboardUid?: string
  theme: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
  defaultLayout: KeyboardLayoutId
  onDefaultLayoutChange: (layout: KeyboardLayoutId) => void
  defaultAutoAdvance: boolean
  onDefaultAutoAdvanceChange: (enabled: boolean) => void
  defaultLayerPanelOpen: boolean
  onDefaultLayerPanelOpenChange: (open: boolean) => void
  defaultBasicViewType: BasicViewType
  onDefaultBasicViewTypeChange: (type: BasicViewType) => void
  defaultSplitKeyMode: SplitKeyMode
  onDefaultSplitKeyModeChange: (mode: SplitKeyMode) => void
  defaultQuickSelect: boolean
  onDefaultQuickSelectChange: (enabled: boolean) => void
  autoLockTime: AutoLockMinutes
  onAutoLockTimeChange: (m: AutoLockMinutes) => void
  maxKeymapHistory: number
  onMaxKeymapHistoryChange: (n: number) => void
  onClose: () => void
  hubEnabled: boolean
  onHubEnabledChange: (enabled: boolean) => void
  hubAuthenticated: boolean
  hubDisplayName: string | null
  /**
   * Live "can the user write to Hub" flag from useHubState. We pass
   * the resolved boolean instead of recomputing in SettingsModal so
   * Key-Labels Upload/Update/Remove buttons share the same gate as
   * favorite / layout-store Hub actions (`hubReady && displayName`).
   * Optional with a `false` default so test renders can omit it.
   */
  hubCanUpload?: boolean
  onHubDisplayNameChange: (name: string) => Promise<{ success: boolean; error?: string }>
  hubAuthConflict?: boolean
  onResolveAuthConflict?: (name: string) => Promise<{ success: boolean; error?: string }>
  hubAccountDeactivated?: boolean
}
