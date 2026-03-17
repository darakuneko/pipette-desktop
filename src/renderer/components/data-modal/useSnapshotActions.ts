// SPDX-License-Identifier: GPL-2.0-or-later
// Standalone snapshot export/hub actions for Data modal (works with v2 VilFiles only)

import { useCallback } from 'react'
import { decodeLayoutOptions } from '../../../shared/kle/layout-options'
import { generateKeymapC } from '../../../shared/keymap-export'
import { generateKeymapPdf } from '../../../shared/pdf-export'
import { generatePdfThumbnail } from '../../utils/pdf-thumbnail'
import { isVilFile, recordToMap, deriveLayerCount } from '../../../shared/vil-file'
import { vilToVialGuiJson } from '../../../shared/vil-compat'
import {
  splitMacroBuffer,
  deserializeMacro,
  macroActionsToJson,
  jsonToMacroActions,
} from '../../../preload/macro'
import {
  serialize as serializeKeycode,
  serializeForCExport,
  keycodeLabel,
  isMask,
  findOuterKeycode,
  findInnerKeycode,
} from '../../../shared/keycodes/keycodes'
import { parseKle } from '../../../shared/kle/kle-parser'
import type { VilFile } from '../../../shared/types/protocol'

interface Options {
  uid: string
  deviceName: string
}

function loadVilData(uid: string, entryId: string): Promise<VilFile | null> {
  return window.vialAPI.snapshotStoreLoad(uid, entryId).then((result) => {
    if (!result.success || !result.data) return null
    const parsed: unknown = JSON.parse(result.data)
    if (!isVilFile(parsed)) return null
    if (parsed.version !== 2 || !parsed.definition) return null
    return parsed
  }).catch(() => null)
}

function buildParams(vilData: VilFile) {
  const def = vilData.definition!
  const kleResult = parseKle(def.layouts.keymap as unknown[][])
  const labels = def.layouts?.labels
  const encoderCount = def.layouts?.keymap
    ? (def.layouts.keymap as unknown[][]).flat().filter((k) => typeof k === 'string' && k.includes('\n\n\n\n\n\n\n\n\n\ne')).length
    : 0
  const macroCount = def.macro_count ?? 16
  const vialProtocol = vilData.vialProtocol ?? 9

  return {
    layers: deriveLayerCount(vilData.keymap),
    keys: kleResult.keys,
    keymap: recordToMap(vilData.keymap),
    encoderLayout: recordToMap(vilData.encoderLayout),
    encoderCount,
    layoutOptions: labels
      ? decodeLayoutOptions(vilData.layoutOptions, labels)
      : new Map<number, number>(),
    serializeKeycode,
    customKeycodes: def.customKeycodes,
    tapDance: vilData.tapDance,
    combo: vilData.combo,
    keyOverride: vilData.keyOverride,
    altRepeatKey: vilData.altRepeatKey,
    macros: vilData.macroJson
      ? vilData.macroJson.map((m) => jsonToMacroActions(JSON.stringify(m)) ?? [])
      : splitMacroBuffer(vilData.macros, macroCount)
          .map((m) => deserializeMacro(m, vialProtocol)),
  }
}

export function useSnapshotActions({ uid, deviceName }: Options) {
  const handleExportVil = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadVilData(uid, entryId)
      if (!vilData) return
      const def = vilData.definition!
      const macroCount = def.macro_count ?? 16
      const vialProtocol = vilData.vialProtocol ?? 9
      const viaProtocol = vilData.viaProtocol ?? 12
      const rows = def.matrix?.rows ?? 0
      const cols = def.matrix?.cols ?? 0
      const encoderCount = buildParams(vilData).encoderCount
      const macroActions = splitMacroBuffer(vilData.macros, macroCount)
        .map((m) => JSON.parse(macroActionsToJson(deserializeMacro(m, vialProtocol))) as unknown[])
      const json = vilToVialGuiJson(vilData, {
        rows,
        cols,
        layers: deriveLayerCount(vilData.keymap),
        encoderCount,
        vialProtocol,
        viaProtocol,
        macroActions,
      })
      await window.vialAPI.saveLayout(json, deviceName)
    } catch { /* non-critical */ }
  }, [uid, deviceName])

  const handleExportKeymapC = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadVilData(uid, entryId)
      if (!vilData) return
      const content = generateKeymapC({ ...buildParams(vilData), serializeKeycode: serializeForCExport })
      await window.vialAPI.exportKeymapC(content, deviceName)
    } catch { /* non-critical */ }
  }, [uid, deviceName])

  const handleExportPdf = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadVilData(uid, entryId)
      if (!vilData) return
      const base64 = generateKeymapPdf({
        ...buildParams(vilData),
        deviceName,
        keycodeLabel,
        isMask,
        findOuterKeycode,
        findInnerKeycode,
      })
      await window.vialAPI.exportPdf(base64, deviceName)
    } catch { /* non-critical */ }
  }, [uid, deviceName])

  const handleUploadToHub = useCallback(async (entryId: string, label: string) => {
    try {
      const vilData = await loadVilData(uid, entryId)
      if (!vilData) return
      const params = buildParams(vilData)
      const pdfBase64 = generateKeymapPdf({
        ...params,
        deviceName,
        keycodeLabel,
        isMask,
        findOuterKeycode,
        findInnerKeycode,
      })
      const def = vilData.definition!
      const macroCount = def.macro_count ?? 16
      const vialProtocol = vilData.vialProtocol ?? 9
      const viaProtocol = vilData.viaProtocol ?? 12
      const rows = def.matrix?.rows ?? 0
      const cols = def.matrix?.cols ?? 0
      const encoderCount = params.encoderCount
      const macroActions = splitMacroBuffer(vilData.macros, macroCount)
        .map((m) => JSON.parse(macroActionsToJson(deserializeMacro(m, vialProtocol))) as unknown[])
      const thumbnailBase64 = await generatePdfThumbnail(pdfBase64)
      await window.vialAPI.hubUploadPost({
        title: label || deviceName,
        keyboardName: deviceName,
        vilJson: vilToVialGuiJson(vilData, { rows, cols, layers: deriveLayerCount(vilData.keymap), encoderCount, vialProtocol, viaProtocol, macroActions }),
        pipetteJson: JSON.stringify(vilData, null, 2),
        keymapC: generateKeymapC({ ...params, serializeKeycode: serializeForCExport }),
        pdfBase64,
        thumbnailBase64,
      })
      // Update hubPostId in snapshot after upload
      const listResult = await window.vialAPI.snapshotStoreList(uid)
      const _entry = listResult.entries?.find((e) => e.id === entryId)
      // hubPostId is updated server-side via the upload response
    } catch { /* non-critical */ }
  }, [uid, deviceName])

  const handleUpdateOnHub = useCallback(async (entryId: string, hubPostId: string, label: string) => {
    try {
      const vilData = await loadVilData(uid, entryId)
      if (!vilData) return
      const params = buildParams(vilData)
      const pdfBase64 = generateKeymapPdf({
        ...params,
        deviceName,
        keycodeLabel,
        isMask,
        findOuterKeycode,
        findInnerKeycode,
      })
      const def = vilData.definition!
      const macroCount = def.macro_count ?? 16
      const vialProtocol = vilData.vialProtocol ?? 9
      const viaProtocol = vilData.viaProtocol ?? 12
      const rows = def.matrix?.rows ?? 0
      const cols = def.matrix?.cols ?? 0
      const encoderCount = params.encoderCount
      const macroActions = splitMacroBuffer(vilData.macros, macroCount)
        .map((m) => JSON.parse(macroActionsToJson(deserializeMacro(m, vialProtocol))) as unknown[])
      const thumbnailBase64 = await generatePdfThumbnail(pdfBase64)
      await window.vialAPI.hubUpdatePost({
        postId: hubPostId,
        title: label || deviceName,
        keyboardName: deviceName,
        vilJson: vilToVialGuiJson(vilData, { rows, cols, layers: deriveLayerCount(vilData.keymap), encoderCount, vialProtocol, viaProtocol, macroActions }),
        pipetteJson: JSON.stringify(vilData, null, 2),
        keymapC: generateKeymapC({ ...params, serializeKeycode: serializeForCExport }),
        pdfBase64,
        thumbnailBase64,
      })
    } catch { /* non-critical */ }
  }, [uid, deviceName])

  const handleRemoveFromHub = useCallback(async (hubPostId: string) => {
    try {
      await window.vialAPI.hubDeletePost(hubPostId)
    } catch { /* non-critical */ }
  }, [])

  return {
    handleExportVil,
    handleExportKeymapC,
    handleExportPdf,
    handleUploadToHub,
    handleUpdateOnHub,
    handleRemoveFromHub,
  }
}
