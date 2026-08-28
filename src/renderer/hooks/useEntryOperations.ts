// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import { decodeLayoutOptions } from '../../shared/kle/layout-options'
import { generateKeymapC } from '../../shared/keymap-export'
import { generateKeymapPdf } from '../../shared/pdf-export'
import { generatePdfThumbnail } from '../utils/pdf-thumbnail'
import {
  isVilFile,
  isVilFileV1,
  migrateVilFileToV2,
  recordToMap,
  deriveLayerCount,
} from '../../shared/vil-file'
import { vilToVialGuiJson } from '../../shared/vil-compat'
import { parseDefinitionLayout } from '../../shared/kle/definition-layout'
import {
  splitMacroBuffer,
  deserializeMacro,
  macroActionsToJson,
  jsonToMacroActions,
} from '../../preload/macro'
import {
  serialize as serializeKeycode,
  serializeForCExport,
  keycodeLabel,
  isMask,
  findOuterKeycode,
  findInnerKeycode,
} from '../../shared/keycodes/keycodes'
import type { VilFile, KeyboardDefinition } from '../../shared/types/protocol'
import type { SnapshotMeta } from '../../shared/types/snapshot-store'

interface Options {
  keyboardUid: string | undefined
  definition: KeyboardDefinition | null
  macroCount: number
  vialProtocol: number
  viaProtocol: number
  qmkSettingsValues: Record<string, number[]>
  dynamicCountsFeatureFlags: number
  layoutStoreEntries: SnapshotMeta[]
  deviceName: string
}

export function useEntryOperations(options: Options) {
  const {
    keyboardUid,
    definition,
    macroCount,
    vialProtocol,
    viaProtocol,
    qmkSettingsValues,
    dynamicCountsFeatureFlags,
    layoutStoreEntries,
    deviceName,
  } = options

  const backfillQmkSettings = useCallback((vil: VilFile): boolean => {
    if (Object.keys(vil.qmkSettings).length === 0 &&
        Object.keys(qmkSettingsValues).length > 0) {
      vil.qmkSettings = { ...qmkSettingsValues }
      return true
    }
    return false
  }, [qmkSettingsValues])

  const loadEntryVilData = useCallback(async (entryId: string): Promise<VilFile | null> => {
    try {
      const result = await window.vialAPI.snapshotStoreLoad(keyboardUid!, entryId)
      if (!result.success || !result.data) return null
      const parsed: unknown = JSON.parse(result.data)
      if (!isVilFile(parsed)) return null

      let vil = parsed
      let dirty = false

      if (isVilFileV1(parsed) && definition) {
        vil = migrateVilFileToV2(parsed, {
          definition,
          viaProtocol,
          vialProtocol,
          featureFlags: dynamicCountsFeatureFlags,
        })
        dirty = true
      }

      if (backfillQmkSettings(vil)) dirty = true

      if (dirty) {
        window.vialAPI.snapshotStoreUpdate(
          keyboardUid!,
          entryId,
          JSON.stringify(vil, null, 2),
          vil.version ?? 1,
        ).then((r) => { if (!r.success) console.warn('[Snapshot] update failed:', r.error) })
      }

      return vil
    } catch {
      return null
    }
  }, [keyboardUid, definition, backfillQmkSettings, viaProtocol, vialProtocol, dynamicCountsFeatureFlags])

  const entryExportName = useCallback((entryId: string): string => {
    const entry = layoutStoreEntries.find((e) => e.id === entryId)
    const suffix = entry?.label || entryId
    return `${deviceName}_${suffix}`
  }, [deviceName, layoutStoreEntries])

  // Superset param object shared by the keymap.c / PDF / hub export paths;
  // keys and layoutOptions are consumed only by the PDF generator.
  // The whole geometry (keys, matrix, labels, custom keycodes, encoders)
  // comes from one definition: a v2 snapshot's own embedded one, with the
  // live definition backfilling v1 snapshots only.
  const buildEntryParams = useCallback((vilData: VilFile) => {
    const def = vilData.definition ?? definition
    const { layout: defLayout, encoderCount: defEncoderCount } = def
      ? parseDefinitionLayout(def)
      : { layout: null, encoderCount: 0 }
    const labels = def?.layouts?.labels
    return {
      layers: deriveLayerCount(vilData.keymap),
      keys: defLayout?.keys ?? [],
      matrixRows: def?.matrix.rows ?? 0,
      matrixCols: def?.matrix.cols ?? 0,
      keymap: recordToMap(vilData.keymap),
      encoderLayout: recordToMap(vilData.encoderLayout),
      encoderCount: defEncoderCount,
      layoutOptions: labels
        ? decodeLayoutOptions(vilData.layoutOptions, labels)
        : new Map<number, number>(),
      serializeKeycode,
      customKeycodes: def?.customKeycodes,
      tapDance: vilData.tapDance,
      combo: vilData.combo,
      keyOverride: vilData.keyOverride,
      altRepeatKey: vilData.altRepeatKey,
      macros: vilData.macroJson
        ? vilData.macroJson.map((m) => jsonToMacroActions(JSON.stringify(m)) ?? [])
        : splitMacroBuffer(vilData.macros, macroCount)
            .map((m) => deserializeMacro(m, vialProtocol)),
    }
  }, [definition, macroCount, vialProtocol])

  const buildVilExportContext = useCallback((
    vilData: VilFile,
    params?: ReturnType<typeof buildEntryParams>,
  ) => {
    const macroActions = splitMacroBuffer(vilData.macros, macroCount)
      .map((m) => JSON.parse(macroActionsToJson(deserializeMacro(m, vialProtocol))) as unknown[])
    const p = params ?? buildEntryParams(vilData)
    return {
      rows: p.matrixRows,
      cols: p.matrixCols,
      layers: p.layers,
      encoderCount: p.encoderCount,
      vialProtocol,
      viaProtocol,
      macroActions,
    }
  }, [macroCount, vialProtocol, viaProtocol, buildEntryParams])

  const handleExportEntryVil = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadEntryVilData(entryId)
      if (!vilData) return
      const json = vilToVialGuiJson(vilData, buildVilExportContext(vilData))
      await window.vialAPI.saveLayout(json, entryExportName(entryId))
    } catch {
      // Export errors are non-critical
    }
  }, [loadEntryVilData, buildVilExportContext, entryExportName])

  const handleExportEntryKeymapC = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadEntryVilData(entryId)
      if (!vilData) return
      const content = generateKeymapC({ ...buildEntryParams(vilData), serializeKeycode: serializeForCExport })
      await window.vialAPI.exportKeymapC(content, entryExportName(entryId))
    } catch {
      // Export errors are non-critical
    }
  }, [loadEntryVilData, buildEntryParams, entryExportName])

  const handleExportEntryPdf = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadEntryVilData(entryId)
      if (!vilData) return
      const exportName = entryExportName(entryId)
      const base64 = generateKeymapPdf({
        ...buildEntryParams(vilData),
        deviceName,
        keycodeLabel,
        isMask,
        findOuterKeycode,
        findInnerKeycode,
      })
      await window.vialAPI.exportPdf(base64, exportName)
    } catch {
      // Export errors are non-critical
    }
  }, [loadEntryVilData, buildEntryParams, entryExportName, deviceName])

  const buildHubPostParams = useCallback(async (entry: { label: string }, vilData: VilFile) => {
    const params = buildEntryParams(vilData)
    const pdfBase64 = generateKeymapPdf({
      ...params,
      deviceName,
      keycodeLabel,
      isMask,
      findOuterKeycode,
      findInnerKeycode,
    })
    const thumbnailBase64 = await generatePdfThumbnail(pdfBase64)
    return {
      title: entry.label || deviceName,
      keyboardName: deviceName,
      vilJson: vilToVialGuiJson(vilData, buildVilExportContext(vilData, params)),
      pipetteJson: JSON.stringify(vilData, null, 2),
      keymapC: generateKeymapC({ ...params, serializeKeycode: serializeForCExport }),
      pdfBase64,
      thumbnailBase64,
    }
  }, [buildEntryParams, buildVilExportContext, deviceName])

  return {
    backfillQmkSettings,
    loadEntryVilData,
    entryExportName,
    buildEntryParams,
    buildVilExportContext,
    buildHubPostParams,
    handleExportEntryVil,
    handleExportEntryKeymapC,
    handleExportEntryPdf,
  }
}
