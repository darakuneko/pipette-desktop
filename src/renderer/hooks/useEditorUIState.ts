// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { LIGHTING_TYPES } from '../app-types'
import type { QmkSettingsTab } from '../../shared/types/protocol'
import settingsDefs from '../../shared/qmk-settings-defs.json'

interface Options {
  isDummy: boolean
  effectiveIsDummy: boolean
  supportedQsids: Set<number>
  lighting: string | undefined
  dynamicCounts: { combo: number; altRepeatKey: number; keyOverride: number }
  keymapScale: number
  setKeymapScale: (scale: number) => void
}

export function useEditorUIState(options: Options) {
  const { isDummy, effectiveIsDummy, supportedQsids, lighting, dynamicCounts, keymapScale, setKeymapScale } = options

  // Unlock dialog
  const [showUnlockDialog, setShowUnlockDialog] = useState(false)
  const [unlockMacroWarning, setUnlockMacroWarning] = useState(false)

  // Matrix
  const [matrixState, setMatrixState] = useState({ matrixMode: false, hasMatrixTester: false })

  // Keymap scale — persisted via devicePrefs (ref keeps callback stable)
  const scaleRef = useRef(keymapScale)
  scaleRef.current = keymapScale
  const adjustKeymapScale = useCallback((delta: number) => {
    setKeymapScale(scaleRef.current + delta)
  }, [setKeymapScale])

  const handleMatrixModeChange = useCallback((matrixMode: boolean, hasMatrixTester: boolean) => {
    setMatrixState({ matrixMode, hasMatrixTester })
  }, [])

  // Typing test
  const [typingTestMode, setTypingTestMode] = useState(false)

  // Split edit
  const [splitEdit, setSplitEdit] = useState(false)
  const [activePane, setActivePane] = useState<'primary' | 'secondary'>('primary')
  const [primaryLayer, setPrimaryLayer] = useState(0)
  const [secondaryLayer, setSecondaryLayer] = useState(0)

  const handleTypingTestModeChange = useCallback((enabled: boolean) => {
    setTypingTestMode(enabled)
    if (enabled) {
      setSplitEdit(false)
      setActivePane('primary')
    }
  }, [])

  const handleSplitEditChange = useCallback((enabled: boolean) => {
    setSplitEdit(enabled)
    setActivePane('primary')
    if (enabled) setSecondaryLayer(primaryLayer)
  }, [primaryLayer])

  const currentLayer = splitEdit && activePane === 'secondary' ? secondaryLayer : primaryLayer
  const setCurrentLayer = useCallback((l: number) => {
    if (splitEdit && activePane === 'secondary') setSecondaryLayer(l)
    else setPrimaryLayer(l)
  }, [splitEdit, activePane])

  // Modals
  const [showLightingModal, setShowLightingModal] = useState(false)
  const [comboInitialIndex, setComboInitialIndex] = useState<number | null>(null)
  const [altRepeatKeyInitialIndex, setAltRepeatKeyInitialIndex] = useState<number | null>(null)
  const [keyOverrideInitialIndex, setKeyOverrideInitialIndex] = useState<number | null>(null)

  // Feature support flags
  const visibleSettingsNames = useMemo(() => {
    if (effectiveIsDummy || supportedQsids.size === 0) return new Set<string>()
    const tabs = (settingsDefs as { tabs: QmkSettingsTab[] }).tabs
    return new Set(
      tabs
        .filter((tab) => tab.fields.some((f) => supportedQsids.has(f.qsid)))
        .map((tab) => tab.name),
    )
  }, [supportedQsids, effectiveIsDummy])

  const tapHoldSupported = visibleSettingsNames.has('Tap-Hold')
  const mouseKeysSupported = visibleSettingsNames.has('Mouse keys')
  const magicSupported = visibleSettingsNames.has('Magic')
  const graveEscapeSupported = visibleSettingsNames.has('Grave Escape')
  const autoShiftSupported = visibleSettingsNames.has('Auto Shift')
  const oneShotKeysSupported = visibleSettingsNames.has('One Shot Keys')
  const comboSettingsSupported = visibleSettingsNames.has('Combo')
  const hasAnySettings =
    tapHoldSupported || mouseKeysSupported || magicSupported ||
    graveEscapeSupported || autoShiftSupported || oneShotKeysSupported ||
    comboSettingsSupported

  const lightingSupported = !isDummy && LIGHTING_TYPES.has(lighting ?? '')

  const comboSupported = !effectiveIsDummy && dynamicCounts.combo > 0
  const altRepeatKeySupported = !effectiveIsDummy && dynamicCounts.altRepeatKey > 0
  const keyOverrideSupported = !effectiveIsDummy && dynamicCounts.keyOverride > 0

  // Close modals when feature support lost
  useEffect(() => {
    if (!lightingSupported) setShowLightingModal(false)
    if (!comboSupported) setComboInitialIndex(null)
    if (!altRepeatKeySupported) setAltRepeatKeyInitialIndex(null)
    if (!keyOverrideSupported) setKeyOverrideInitialIndex(null)
  }, [lightingSupported, comboSupported, altRepeatKeySupported, keyOverrideSupported])

  const resetUIState = useCallback(() => {
    setTypingTestMode(false)
    setPrimaryLayer(0)
    setSecondaryLayer(0)
    setSplitEdit(false)
    setActivePane('primary')
    setShowUnlockDialog(false)
    setUnlockMacroWarning(false)
    setMatrixState({ matrixMode: false, hasMatrixTester: false })
  }, [])

  return {
    // Unlock
    showUnlockDialog,
    setShowUnlockDialog,
    unlockMacroWarning,
    setUnlockMacroWarning,
    // Matrix
    matrixState,
    handleMatrixModeChange,
    // Scale
    keymapScale,
    adjustKeymapScale,
    // Typing test
    typingTestMode,
    handleTypingTestModeChange,
    // Split edit
    splitEdit,
    handleSplitEditChange,
    activePane,
    setActivePane,
    primaryLayer,
    secondaryLayer,
    currentLayer,
    setCurrentLayer,
    // Modals
    showLightingModal,
    setShowLightingModal,
    comboInitialIndex,
    setComboInitialIndex,
    altRepeatKeyInitialIndex,
    setAltRepeatKeyInitialIndex,
    keyOverrideInitialIndex,
    setKeyOverrideInitialIndex,
    // Feature support
    tapHoldSupported,
    mouseKeysSupported,
    magicSupported,
    graveEscapeSupported,
    autoShiftSupported,
    oneShotKeysSupported,
    comboSettingsSupported,
    hasAnySettings,
    lightingSupported,
    comboSupported,
    altRepeatKeySupported,
    keyOverrideSupported,
    // Reset
    resetUIState,
  }
}
