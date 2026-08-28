// SPDX-License-Identifier: GPL-2.0-or-later

import { generateKeymapC } from '../../shared/keymap-export'
import { generateKeymapPdf } from '../../shared/pdf-export'
import { generatePdfThumbnail } from '../utils/pdf-thumbnail'
import { vilToVialGuiJson } from '../../shared/vil-compat'
import {
  serializeForCExport,
  keycodeLabel,
  isMask,
  findOuterKeycode,
  findInnerKeycode,
} from '../../shared/keycodes/keycodes'
import { buildVilExportContext, type SnapshotExportParams, type VilExportContextOpts } from './snapshot-export-params'
import type { HubUploadPostParams } from '../../shared/types/hub'
import type { VilFile } from '../../shared/types/protocol'

// Shared by useSnapshotActions (Data modal, standalone snapshots) and
// useEntryOperations (Layout Store entries) — both assembled a field-for-field
// identical 7-key Hub upload payload from the same params/context, so it
// lives here once. `params` and `protocols` must come from the same
// buildSnapshotExportParams call (same fallbackDefinition/macroCount/vialProtocol).
export async function buildHubPostPayload(
  vilData: VilFile,
  params: SnapshotExportParams,
  protocols: VilExportContextOpts,
  { label, deviceName }: { label: string; deviceName: string },
): Promise<HubUploadPostParams> {
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
    title: label || deviceName,
    keyboardName: deviceName,
    vilJson: vilToVialGuiJson(vilData, buildVilExportContext(vilData, params, protocols)),
    pipetteJson: JSON.stringify(vilData, null, 2),
    keymapC: generateKeymapC({ ...params, serializeKeycode: serializeForCExport }),
    pdfBase64,
    thumbnailBase64,
  }
}
