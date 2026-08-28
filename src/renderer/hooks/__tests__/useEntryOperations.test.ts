// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Entry exports must describe a v2 snapshot's own embedded definition;
// the live keyboard's definition only backfills v1 snapshots.

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEntryOperations } from '../useEntryOperations'
import type { KeyboardDefinition, VilFile } from '../../../shared/types/protocol'

// Live keyboard: 2x2 grid plus one encoder (CW/CCW pair), one layout-option
// label, and its own custom keycode.
const LIVE_DEFINITION: KeyboardDefinition = {
  matrix: { rows: 2, cols: 2 },
  layouts: {
    keymap: [
      ['0,0', '0,1'],
      ['1,0', '1,1'],
      [`0,0${'\n'.repeat(9)}e`, `0,1${'\n'.repeat(9)}e`],
    ],
    labels: ['Live Option'],
  },
  customKeycodes: [{ name: 'LIVE_KC', title: 'LIVE_KC', shortName: 'LIVE_KC' }],
}

// Snapshot's own embedded definition: 1x1 grid, no encoders, no labels, a
// different custom keycode — simulates a firmware update that reshaped the
// keyboard after this snapshot was saved.
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

function useHarness() {
  return useEntryOperations({
    keyboardUid: 'test-uid',
    definition: LIVE_DEFINITION,
    macroCount: 16,
    vialProtocol: 6,
    viaProtocol: 12,
    qmkSettingsValues: {},
    dynamicCountsFeatureFlags: 0,
    layoutStoreEntries: [],
    deviceName: 'Test Keyboard',
  })
}

describe('useEntryOperations — export definition source', () => {
  it('v2 snapshot: buildEntryParams uses the snapshot own definition, not the live one', () => {
    const { result } = renderHook(useHarness)
    const vilData = buildVilData({ version: 2, definition: SNAPSHOT_DEFINITION })

    const params = result.current.buildEntryParams(vilData)

    expect(params.keys).toHaveLength(1)
    expect(params.matrixRows).toBe(1)
    expect(params.matrixCols).toBe(1)
    expect(params.encoderCount).toBe(0)
    expect(params.customKeycodes).toEqual(SNAPSHOT_DEFINITION.customKeycodes)
  })

  it('v2 snapshot without labels: does not decode layoutOptions with the live labels', () => {
    const { result } = renderHook(useHarness)
    const vilData = buildVilData({ version: 2, definition: SNAPSHOT_DEFINITION, layoutOptions: 1 })

    const params = result.current.buildEntryParams(vilData)

    expect(params.layoutOptions.size).toBe(0)
  })

  it('v1 snapshot (no embedded definition): falls back to the live definition', () => {
    const { result } = renderHook(useHarness)
    const vilData = buildVilData({ layoutOptions: 1 })

    const params = result.current.buildEntryParams(vilData)

    // 4 normal keys + the encoder pair (keys carries all parsed entries;
    // the PDF generator partitions encoders itself)
    expect(params.keys).toHaveLength(6)
    expect(params.matrixRows).toBe(2)
    expect(params.matrixCols).toBe(2)
    expect(params.encoderCount).toBe(1)
    expect(params.layoutOptions.size).toBe(1)
    expect(params.customKeycodes).toEqual(LIVE_DEFINITION.customKeycodes)
  })

  it('buildVilExportContext follows the same definition source as buildEntryParams', () => {
    const { result } = renderHook(useHarness)
    const vilData = buildVilData({ version: 2, definition: SNAPSHOT_DEFINITION })

    const context = result.current.buildVilExportContext(vilData)

    expect(context.rows).toBe(1)
    expect(context.cols).toBe(1)
    expect(context.encoderCount).toBe(0)
  })
})
