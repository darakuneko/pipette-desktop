// SPDX-License-Identifier: GPL-2.0-or-later
//
// buildSnapshotExportParams/buildVilExportContext are the single shared
// implementation behind useEntryOperations.buildEntryParams and
// useSnapshotActions.buildExportBundle — this pins their field-by-field
// contract directly so both call sites can stay thin wrappers. Definition
// precedence (snapshot's own definition vs. the fallback definition) is
// pinned end-to-end by useEntryOperations.test.ts instead of being
// duplicated here.

import { describe, it, expect } from 'vitest'
import { buildSnapshotExportParams, buildVilExportContext } from '../snapshot-export-params'
import type { KeyboardDefinition, VilFile } from '../../../shared/types/protocol'

const SNAPSHOT_DEFINITION: KeyboardDefinition = {
  matrix: { rows: 1, cols: 1 },
  layouts: { keymap: [['0,0']] },
  customKeycodes: [{ name: 'SNAP_KC', title: 'SNAP_KC', shortName: 'SNAP_KC' }],
}

function buildVilData(overrides: Partial<VilFile> = {}): VilFile {
  return {
    uid: 'test-uid',
    keymap: {},
    encoderLayout: {},
    macros: [],
    layoutOptions: 0,
    tapDance: [],
    combo: [],
    keyOverride: [],
    altRepeatKey: [],
    qmkSettings: {},
    ...overrides,
  }
}

describe('buildSnapshotExportParams', () => {
  it('with no definition at all (fallbackDefinition null, snapshot has none), degrades to empty geometry', () => {
    const vilData = buildVilData()

    const params = buildSnapshotExportParams(vilData, {
      fallbackDefinition: null,
      macroCount: 16,
      vialProtocol: 6,
    })

    expect(params.keys).toEqual([])
    expect(params.matrixRows).toBe(0)
    expect(params.matrixCols).toBe(0)
    expect(params.encoderCount).toBe(0)
    expect(params.layoutOptions.size).toBe(0)
    expect(params.customKeycodes).toBeUndefined()
  })

  it('prefers macroJson over the raw macro buffer when both are present', () => {
    const vilData = buildVilData({
      definition: SNAPSHOT_DEFINITION,
      macros: [104, 105, 0], // would decode to text "hi" if the buffer were used
      macroJson: [[['text', 'from-json']]],
    })

    const params = buildSnapshotExportParams(vilData, {
      fallbackDefinition: null,
      macroCount: 16,
      vialProtocol: 1,
    })

    expect(params.macros).toEqual([[{ type: 'text', text: 'from-json' }]])
  })

  it('falls back to splitMacroBuffer + deserializeMacro when macroJson is absent', () => {
    const vilData = buildVilData({
      definition: SNAPSHOT_DEFINITION,
      macros: [104, 105, 0], // 'h', 'i', NUL terminator
    })

    const params = buildSnapshotExportParams(vilData, {
      fallbackDefinition: null,
      macroCount: 16,
      vialProtocol: 1, // pre-advanced-macros: plain ASCII decodes to text
    })

    expect(params.macros).toEqual([[{ type: 'text', text: 'hi' }]])
  })
})

describe('buildVilExportContext', () => {
  it('derives rows/cols/layers/encoderCount from the passed-in params, and re-decodes macroActions', () => {
    const vilData = buildVilData({
      definition: SNAPSHOT_DEFINITION,
      keymap: { '0,0': 4, '1,0': 5 },
      macros: [104, 105, 0],
    })
    const params = buildSnapshotExportParams(vilData, {
      fallbackDefinition: null,
      macroCount: 16,
      vialProtocol: 1,
    })

    const context = buildVilExportContext(vilData, params, {
      vialProtocol: 1,
      viaProtocol: 12,
      macroCount: 16,
    })

    expect(context.rows).toBe(1)
    expect(context.cols).toBe(1)
    expect(context.layers).toBe(2)
    expect(context.encoderCount).toBe(0)
    expect(context.vialProtocol).toBe(1)
    expect(context.viaProtocol).toBe(12)
    expect(context.macroActions).toEqual([[['text', 'hi']]])
  })
})
