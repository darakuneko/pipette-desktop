// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import type { KeyboardDefinition, VilFile } from '../../shared/types/protocol'
import {
  VIAL_PROTOCOL_KEY_OVERRIDE,
} from '../../shared/constants/protocol'
import { recordToMap, deriveLayerCount } from '../../shared/vil-file'
import { splitMacroBuffer, jsonToMacroActions } from '../../preload/macro'
import { recreateKeyboardKeycodes } from '../../shared/keycodes/keycodes'
import { emptyState } from './keyboard-types'
import type { SetState, KeyboardRefs } from './keyboard-types'
import { parseDefinitionLayout } from './keyboard-state-helpers'

export function useKeyboardLoaders(
  setState: SetState,
  refs: KeyboardRefs,
): {
  loadDummy: (definition: KeyboardDefinition) => void
  loadPipetteFile: (vil: VilFile) => void
} {
  const { qmkSettingsBaselineRef } = refs

  const loadDummy = useCallback((definition: KeyboardDefinition) => {
    const rawLayers = definition.dynamic_keymap?.layer_count ?? 4
    const dummyLayers = Number.isInteger(rawLayers) && rawLayers >= 1 && rawLayers <= 32
      ? rawLayers
      : 4
    const DUMMY_MACRO_COUNT = 16
    const DUMMY_MACRO_BUFFER_SIZE = 900

    const newState = emptyState()
    newState.isDummy = true
    newState.layers = dummyLayers
    newState.layerNames = new Array<string>(dummyLayers).fill('')
    newState.macroCount = DUMMY_MACRO_COUNT
    newState.macroBufferSize = DUMMY_MACRO_BUFFER_SIZE
    newState.macroBuffer = new Array(DUMMY_MACRO_BUFFER_SIZE).fill(0)
    newState.definition = definition
    newState.rows = definition.matrix.rows
    newState.cols = definition.matrix.cols
    newState.layoutOptions = 0
    newState.unlockStatus = { unlocked: true, inProgress: false, keys: [] }

    // Parse KLE layout
    const { layout, encoderCount } = parseDefinitionLayout(definition)
    newState.layout = layout
    newState.encoderCount = encoderCount

    // Initialize keymap with KC_NO (0x0000)
    for (let layer = 0; layer < dummyLayers; layer++) {
      for (let row = 0; row < newState.rows; row++) {
        for (let col = 0; col < newState.cols; col++) {
          newState.keymap.set(`${layer},${row},${col}`, 0x0000)
        }
      }
    }

    // Initialize encoder layout with KC_NO (0x0000)
    for (let layer = 0; layer < dummyLayers; layer++) {
      for (let idx = 0; idx < newState.encoderCount; idx++) {
        newState.encoderLayout.set(`${layer},${idx},0`, 0x0000)
        newState.encoderLayout.set(`${layer},${idx},1`, 0x0000)
      }
    }

    // Recreate keycodes for the dummy keyboard
    recreateKeyboardKeycodes({
      vialProtocol: newState.vialProtocol,
      layers: newState.layers,
      macroCount: newState.macroCount,
      tapDanceCount: 0,
      customKeycodes: definition.customKeycodes ?? null,
      midi: definition.vial?.midi ?? '',
      supportedFeatures: new Set(),
    })

    setState(newState)
  }, [setState])

  const loadPipetteFile = useCallback((vil: VilFile) => {
    if (!vil.definition) {
      throw new Error('Loading a .vil file requires a v2 file with an embedded definition')
    }

    const definition = vil.definition
    const newState = emptyState()
    newState.isDummy = true
    // Use protocol versions from file if available, otherwise default to latest
    newState.viaProtocol = vil.viaProtocol ?? 9
    newState.vialProtocol = vil.vialProtocol ?? 9
    newState.definition = definition
    newState.rows = definition.matrix.rows
    newState.cols = definition.matrix.cols
    newState.layoutOptions = vil.layoutOptions
    newState.unlockStatus = { unlocked: true, inProgress: false, keys: [] }

    // Parse KLE layout
    const { layout, encoderCount } = parseDefinitionLayout(definition)
    newState.layout = layout
    newState.encoderCount = encoderCount

    // Apply keymap and encoder layout from vil data
    newState.keymap = recordToMap(vil.keymap)
    newState.encoderLayout = recordToMap(vil.encoderLayout)

    // Apply macros
    newState.macroBuffer = vil.macros
    newState.macroBufferSize = vil.macros.length > 0 ? vil.macros.length : 900
    newState.parsedMacros = vil.macroJson
      ? vil.macroJson.map((m) => jsonToMacroActions(JSON.stringify(m)) ?? [])
      : null
    // Derive macro count from parsed macros or split buffer
    if (newState.parsedMacros) {
      newState.macroCount = newState.parsedMacros.length
    } else if (vil.macros.length > 0) {
      newState.macroCount = splitMacroBuffer(vil.macros, 128).length
    } else {
      newState.macroCount = 16
    }

    // Derive layer count from keymap data
    newState.layers = deriveLayerCount(vil.keymap, newState.rows, newState.cols)
    newState.layerNames = Array.from({ length: newState.layers }, (_, i) =>
      vil.layerNames && i < vil.layerNames.length ? vil.layerNames[i] : '',
    )

    // Apply dynamic entries
    newState.tapDanceEntries = vil.tapDance
    newState.comboEntries = vil.combo
    newState.keyOverrideEntries = vil.keyOverride
    newState.altRepeatKeyEntries = vil.altRepeatKey
    const featureFlags = vil.featureFlags ?? 0
    newState.dynamicCounts = {
      tapDance: vil.tapDance.length,
      combo: vil.combo.length,
      keyOverride: vil.keyOverride.length,
      altRepeatKey: vil.altRepeatKey.length,
      featureFlags,
    }

    // Apply QMK settings (deep-copy baseline for reset support)
    newState.qmkSettingsValues = vil.qmkSettings
    qmkSettingsBaselineRef.current = Object.fromEntries(
      Object.entries(vil.qmkSettings).map(([k, v]) => [k, [...v]]),
    )
    const qsidKeys = Object.keys(vil.qmkSettings)
    newState.supportedQsids = new Set(qsidKeys.map(Number).filter((n) => !Number.isNaN(n)))

    // Set UID from vil file
    newState.uid = vil.uid

    // Recreate keycodes — derive supportedFeatures from saved data (same logic as reload)
    const supportedFeatures = new Set<string>()
    if (featureFlags & 0x01) supportedFeatures.add('caps_word')
    if (featureFlags & 0x02) supportedFeatures.add('layer_lock')
    if (newState.vialProtocol >= VIAL_PROTOCOL_KEY_OVERRIDE) {
      supportedFeatures.add('persistent_default_layer')
    }
    if (vil.altRepeatKey.length > 0) supportedFeatures.add('repeat_key')

    recreateKeyboardKeycodes({
      vialProtocol: newState.vialProtocol,
      layers: newState.layers,
      macroCount: newState.macroCount,
      tapDanceCount: vil.tapDance.length,
      customKeycodes: definition.customKeycodes ?? null,
      midi: definition.vial?.midi ?? '',
      supportedFeatures,
    })

    setState(newState)
  }, [setState, qmkSettingsBaselineRef])

  return { loadDummy, loadPipetteFile }
}
