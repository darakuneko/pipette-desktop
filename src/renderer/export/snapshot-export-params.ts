// SPDX-License-Identifier: GPL-2.0-or-later

import { decodeLayoutOptions } from '../../shared/kle/layout-options'
import { parseDefinitionLayout } from '../../shared/kle/definition-layout'
import { recordToMap, deriveLayerCount } from '../../shared/vil-file'
import {
  splitMacroBuffer,
  deserializeMacro,
  macroActionsToJson,
  jsonToMacroActions,
} from '../../preload/macro'
import { serialize as serializeKeycode } from '../../shared/keycodes/keycodes'
import type { VilFile, KeyboardDefinition } from '../../shared/types/protocol'
import type { VilExportContext } from '../../shared/vil-compat'

export interface SnapshotExportParamOpts {
  /** Definition to use when the snapshot itself carries none (v1 snapshots). */
  fallbackDefinition: KeyboardDefinition | null
  macroCount: number
  vialProtocol: number
}

// Superset param object shared by the keymap.c / PDF / hub export paths;
// keys and layoutOptions are consumed only by the PDF generator.
// The whole geometry (keys, matrix, labels, custom keycodes, encoders)
// comes from one definition: a v2 snapshot's own embedded one, with the
// fallback definition backfilling v1 snapshots only.
export function buildSnapshotExportParams(vilData: VilFile, opts: SnapshotExportParamOpts) {
  const def = vilData.definition ?? opts.fallbackDefinition
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
      : splitMacroBuffer(vilData.macros, opts.macroCount)
          .map((m) => deserializeMacro(m, opts.vialProtocol)),
  }
}

export type SnapshotExportParams = ReturnType<typeof buildSnapshotExportParams>

// Mirrors the subset of SnapshotExportParamOpts that must match whatever
// opts built `params` (macroCount, vialProtocol), plus viaProtocol which
// buildSnapshotExportParams never needs.
export type VilExportContextOpts =
  Pick<SnapshotExportParamOpts, 'macroCount' | 'vialProtocol'> & { viaProtocol: number }

// Derives the vial-gui export context (rows/cols/layers/encoderCount) from
// an already-built params object, plus a freshly re-decoded macroActions
// list (vilToVialGuiJson needs the vial-gui JSON macro shape, not the
// MacroAction[] shape params.macros carries — unlike params.macros, this
// always re-decodes the raw macro buffer and ignores macroJson).
export function buildVilExportContext(
  vilData: VilFile,
  params: Pick<SnapshotExportParams, 'matrixRows' | 'matrixCols' | 'layers' | 'encoderCount'>,
  opts: VilExportContextOpts,
): VilExportContext {
  const macroActions = splitMacroBuffer(vilData.macros, opts.macroCount)
    .map((m) => JSON.parse(macroActionsToJson(deserializeMacro(m, opts.vialProtocol))) as unknown[])
  return {
    rows: params.matrixRows,
    cols: params.matrixCols,
    layers: params.layers,
    encoderCount: params.encoderCount,
    vialProtocol: opts.vialProtocol,
    viaProtocol: opts.viaProtocol,
    macroActions,
  }
}
