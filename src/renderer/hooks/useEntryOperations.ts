// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import { generateKeymapC } from '../../shared/keymap-export'
import { generateKeymapPdf } from '../../shared/pdf-export'
import {
  isVilFile,
  isVilFileV1,
  migrateVilFileToV2,
} from '../../shared/vil-file'
import { vilToVialGuiJson } from '../../shared/vil-compat'
import {
  serializeForCExport,
  keycodeLabel,
  isMask,
  findOuterKeycode,
  findInnerKeycode,
} from '../../shared/keycodes/keycodes'
import {
  buildSnapshotExportParams,
  buildVilExportContext as buildVilExportContextShared,
  type SnapshotExportParams,
} from '../export/snapshot-export-params'
import { buildHubPostPayload } from '../export/snapshot-hub-payload'
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

  const buildEntryParams = useCallback((vilData: VilFile) => (
    buildSnapshotExportParams(vilData, { fallbackDefinition: definition, macroCount, vialProtocol })
  ), [definition, macroCount, vialProtocol])

  const buildVilExportContext = useCallback((
    vilData: VilFile,
    params?: SnapshotExportParams,
  ) => (
    buildVilExportContextShared(vilData, params ?? buildEntryParams(vilData), {
      vialProtocol,
      viaProtocol,
      macroCount,
    })
  ), [macroCount, vialProtocol, viaProtocol, buildEntryParams])

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
    return buildHubPostPayload(vilData, params, { vialProtocol, viaProtocol, macroCount }, {
      label: entry.label,
      deviceName,
    })
  }, [buildEntryParams, vialProtocol, viaProtocol, macroCount, deviceName])

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
