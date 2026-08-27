// SPDX-License-Identifier: GPL-2.0-or-later
// Keymap-C / PDF export generator callbacks fed into useFileIO. Split out
// of App.tsx (Task-split-app-tsx).

import { useCallback } from 'react'
import type { useKeyboard } from './useKeyboard'
import type { decodeLayoutOptions } from '../../shared/kle/layout-options'
import type { deserializeAllMacros } from '../../preload/macro'
import { generateKeymapC } from '../../shared/keymap-export'
import { generateKeymapPdf } from '../../shared/pdf-export'
import {
  serialize as serializeKeycode,
  serializeForCExport,
  keycodeLabel,
  isMask,
  findOuterKeycode,
  findInnerKeycode,
} from '../../shared/keycodes/keycodes'

interface Params {
  keyboard: ReturnType<typeof useKeyboard>
  deviceName: string
  decodedLayoutOptions: ReturnType<typeof decodeLayoutOptions>
  deserializedMacros: ReturnType<typeof deserializeAllMacros> | undefined
}

export function useFileGenerators({ keyboard, deviceName, decodedLayoutOptions, deserializedMacros }: Params) {
  const keymapCGenerator = useCallback(
    () => generateKeymapC({
      layers: keyboard.layers,
      matrixRows: keyboard.rows,
      matrixCols: keyboard.cols,
      keymap: keyboard.keymap,
      encoderLayout: keyboard.encoderLayout,
      encoderCount: keyboard.encoderCount,
      serializeKeycode: serializeForCExport,
      customKeycodes: keyboard.definition?.customKeycodes,
    }),
    [keyboard.layers, keyboard.rows, keyboard.cols, keyboard.keymap, keyboard.encoderLayout, keyboard.encoderCount, keyboard.definition?.customKeycodes],
  )

  const pdfGenerator = useCallback(
    () => generateKeymapPdf({
      deviceName,
      layers: keyboard.layers,
      keys: keyboard.layout?.keys ?? [],
      keymap: keyboard.keymap,
      encoderLayout: keyboard.encoderLayout,
      encoderCount: keyboard.encoderCount,
      layoutOptions: decodedLayoutOptions,
      serializeKeycode,
      keycodeLabel,
      isMask,
      findOuterKeycode,
      findInnerKeycode,
      tapDance: keyboard.tapDanceEntries,
      combo: keyboard.comboEntries,
      keyOverride: keyboard.keyOverrideEntries,
      altRepeatKey: keyboard.altRepeatKeyEntries,
      macros: deserializedMacros,
    }),
    [deviceName, keyboard.layers, keyboard.layout, keyboard.keymap, keyboard.encoderLayout, keyboard.encoderCount, decodedLayoutOptions,
     keyboard.tapDanceEntries, keyboard.comboEntries, keyboard.keyOverrideEntries, keyboard.altRepeatKeyEntries, deserializedMacros],
  )

  return { keymapCGenerator, pdfGenerator }
}
