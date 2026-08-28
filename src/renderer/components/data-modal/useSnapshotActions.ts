// SPDX-License-Identifier: GPL-2.0-or-later
// Standalone snapshot export/hub actions for Data modal (works with v2 VilFiles only)

import { useCallback } from 'react'
import { generateKeymapC } from '../../../shared/keymap-export'
import { generateKeymapPdf } from '../../../shared/pdf-export'
import { isVilFile } from '../../../shared/vil-file'
import { vilToVialGuiJson } from '../../../shared/vil-compat'
import { FALLBACK_VIAL_PROTOCOL } from '../../../shared/favorite-data'
import {
  serializeForCExport,
  keycodeLabel,
  isMask,
  findOuterKeycode,
  findInnerKeycode,
} from '../../../shared/keycodes/keycodes'
import {
  buildSnapshotExportParams,
  buildVilExportContext,
} from '../../export/snapshot-export-params'
import { buildHubPostPayload } from '../../export/snapshot-hub-payload'
import type { VilFile } from '../../../shared/types/protocol'

interface Options {
  uid: string
  deviceName: string
}

// KeyboardDefinition (the static JSON bundled in a snapshot) never carries
// a macro count — dynamic_keymap_macro_get_count is a live protocol query,
// not part of the definition file, so this always falls back to 16 (the
// common VIA/Vial default).
const FALLBACK_MACRO_COUNT = 16

// useKeyboardLoaders.ts falls back to 9 for the live-keyboard read path;
// this is the snapshot-export fallback and intentionally differs.
const FALLBACK_VIA_PROTOCOL = 12

function loadVilData(uid: string, entryId: string): Promise<VilFile | null> {
  return window.vialAPI.snapshotStoreLoad(uid, entryId).then((result) => {
    if (!result.success || !result.data) return null
    const parsed: unknown = JSON.parse(result.data)
    if (!isVilFile(parsed)) return null
    if (parsed.version !== 2 || !parsed.definition) return null
    return parsed
  }).catch(() => null)
}

// Export protocol values a loaded snapshot resolves to: vial/via protocol are
// read from the snapshot's own recorded values, falling back to the shared
// default when a snapshot predates that field. Macro count has no
// definition-level source (dynamic_keymap_macro_get_count is a live protocol
// query, not part of the definition file) so it always falls back to 16 (the
// common VIA/Vial default).
function resolveExportProtocols(vilData: VilFile) {
  return {
    macroCount: FALLBACK_MACRO_COUNT,
    vialProtocol: vilData.vialProtocol ?? FALLBACK_VIAL_PROTOCOL,
    viaProtocol: vilData.viaProtocol ?? FALLBACK_VIA_PROTOCOL,
  }
}

// `loadVilData` guarantees a v2 snapshot with its own embedded definition,
// so there is no live-definition fallback here. Resolves protocols once so
// every caller reuses the same params/protocols pair for the action.
function buildExportBundle(vilData: VilFile) {
  const protocols = resolveExportProtocols(vilData)
  const params = buildSnapshotExportParams(vilData, {
    fallbackDefinition: null,
    macroCount: protocols.macroCount,
    vialProtocol: protocols.vialProtocol,
  })
  return { params, protocols }
}

export function useSnapshotActions({ uid, deviceName }: Options) {
  const handleExportVil = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadVilData(uid, entryId)
      if (!vilData) return
      const { params, protocols } = buildExportBundle(vilData)
      const json = vilToVialGuiJson(vilData, buildVilExportContext(vilData, params, protocols))
      await window.vialAPI.saveLayout(json, deviceName)
    } catch { /* non-critical */ }
  }, [uid, deviceName])

  const handleExportKeymapC = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadVilData(uid, entryId)
      if (!vilData) return
      const { params } = buildExportBundle(vilData)
      const content = generateKeymapC({ ...params, serializeKeycode: serializeForCExport })
      await window.vialAPI.exportKeymapC(content, deviceName)
    } catch { /* non-critical */ }
  }, [uid, deviceName])

  const handleExportPdf = useCallback(async (entryId: string) => {
    try {
      const vilData = await loadVilData(uid, entryId)
      if (!vilData) return
      const { params } = buildExportBundle(vilData)
      const base64 = generateKeymapPdf({
        ...params,
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
      const { params, protocols } = buildExportBundle(vilData)
      const payload = await buildHubPostPayload(vilData, params, protocols, { label, deviceName })
      await window.vialAPI.hubUploadPost(payload)
    } catch { /* non-critical */ }
  }, [uid, deviceName])

  const handleUpdateOnHub = useCallback(async (entryId: string, hubPostId: string, label: string) => {
    try {
      const vilData = await loadVilData(uid, entryId)
      if (!vilData) return
      const { params, protocols } = buildExportBundle(vilData)
      const payload = await buildHubPostPayload(vilData, params, protocols, { label, deviceName })
      await window.vialAPI.hubUpdatePost({ postId: hubPostId, ...payload })
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
