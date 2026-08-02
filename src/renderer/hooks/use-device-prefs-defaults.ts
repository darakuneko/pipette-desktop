// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import type { AppConfig, AutoLockMinutes, BasicViewType, SplitKeyMode } from '../../shared/types/app-config'

interface UseDevicePrefsDefaultsArgs {
  config: AppConfig
  set: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void
}

export function useDevicePrefsDefaults({ config, set }: UseDevicePrefsDefaultsArgs) {
  // Accept any non-empty id; Key Labels installed via the modal are
  // valid even though they are not in the built-in `LAYOUT_ID_SET`.
  const defaultLayout = typeof config.defaultKeyboardLayout === 'string'
    && config.defaultKeyboardLayout.length > 0
    ? config.defaultKeyboardLayout
    : 'qwerty'
  const defaultAutoAdvance = config.defaultAutoAdvance
  const defaultLayerPanelOpen = config.defaultLayerPanelOpen
  const defaultBasicViewType = config.defaultBasicViewType
  const defaultSplitKeyMode = config.defaultSplitKeyMode ?? 'split'
  const defaultQuickSelect = config.defaultQuickSelect ?? false

  const setDefaultLayout = useCallback((id: KeyboardLayoutId) => {
    set('defaultKeyboardLayout', id)
  }, [set])

  const setDefaultAutoAdvance = useCallback((enabled: boolean) => {
    set('defaultAutoAdvance', enabled)
  }, [set])

  const setDefaultLayerPanelOpen = useCallback((open: boolean) => {
    set('defaultLayerPanelOpen', open)
  }, [set])

  const setDefaultBasicViewType = useCallback((type: BasicViewType) => {
    set('defaultBasicViewType', type)
  }, [set])

  const setDefaultSplitKeyMode = useCallback((mode: SplitKeyMode) => {
    set('defaultSplitKeyMode', mode)
  }, [set])

  const setDefaultQuickSelect = useCallback((enabled: boolean) => {
    set('defaultQuickSelect', enabled)
  }, [set])

  const setAutoLockTime = useCallback((m: AutoLockMinutes) => {
    set('autoLockTime', m)
  }, [set])

  return {
    defaultLayout,
    defaultAutoAdvance,
    defaultLayerPanelOpen,
    defaultBasicViewType,
    defaultSplitKeyMode,
    defaultQuickSelect,
    setDefaultLayout,
    setDefaultAutoAdvance,
    setDefaultLayerPanelOpen,
    setDefaultBasicViewType,
    setDefaultSplitKeyMode,
    setDefaultQuickSelect,
    autoLockTime: config.autoLockTime,
    setAutoLockTime,
  }
}
