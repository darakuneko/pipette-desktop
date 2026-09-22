// SPDX-License-Identifier: GPL-2.0-or-later

// Shared KLE test fixtures for the keyboard widget / matrix-wires test
// suites: a default KleKey factory, common gutter/cell fixtures, and the
// virtual-device GPK60-63R definition loader used by several of them.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KleKey, KeyboardLayout } from '../../../../shared/kle/types'
import { parseDefinitionLayout } from '../../../../shared/kle/definition-layout'
import type { KeyboardDefinition } from '../../../../shared/types/protocol'

export function makeKey(overrides: Partial<KleKey> = {}): KleKey {
  return {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    x2: 0,
    y2: 0,
    width2: 1,
    height2: 1,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    color: '',
    labels: [],
    textColor: [],
    textSize: [],
    row: 0,
    col: 0,
    encoderIdx: -1,
    encoderDir: -1,
    layoutIndex: -1,
    layoutOption: -1,
    decal: false,
    nub: false,
    stepped: false,
    ghost: false,
    ...overrides,
  }
}

/** A font size fixture used by suites that don't care about label
 *  stacking specifics, only that `buildMatrixWires` receives one. */
export const NO_GUTTER_FONT_SIZE = 10

/** No overrides — every key's effective position is its own physical
 *  (row, col), matching `buildMatrixWires`'s documented fallback. */
export const IDENTITY_CELLS = new Map<string, { row: number; col: number }>()

/** Three keys anchored at the same physical x (one full physical column)
 *  but wired to three different matrix columns — the View Matrix layout
 *  that produces overlapping column-number gutter labels. Each key gets
 *  its own row so they don't also collide on the row axis. */
export function makeColumnStackKeys(): KleKey[] {
  return [
    makeKey({ row: 0, col: 1, x: 0, y: 0 }),
    makeKey({ row: 1, col: 3, x: 0, y: 1 }),
    makeKey({ row: 2, col: 7, x: 0, y: 2 }),
  ]
}

function loadLayoutFixture(fixturePath: string, label: string): KeyboardLayout {
  const definition = JSON.parse(readFileSync(fixturePath, 'utf-8')) as KeyboardDefinition
  const { layout } = parseDefinitionLayout(definition)
  if (!layout) throw new Error(`${label} produced no layout`)
  return layout
}

/** Loads the virtual GPK60-63R device's keyboard layout — a real,
 *  non-trivial definition (sparse rows, encoders) shared by suites that
 *  exercise matrix-wires geometry against actual keyboard data instead of
 *  hand-built fixtures. */
export function loadVirtualDeviceLayout(): KeyboardLayout {
  const fixturePath = join(__dirname, '../../../../main/virtual-device/gpk60-63r-definition.json')
  return loadLayoutFixture(fixturePath, 'gpk60-63r-definition.json')
}

/** Loads the split-keyboard e2e fixture (rows 0-3 left half, rows 4-7
 *  right half, cols 0-4 shared) shared by this suite's label-order
 *  regression test and the View Matrix Wires e2e test. Its thumb rows (3
 *  and 7) carry asymmetric rotation origins, so their label anchors land
 *  a fraction of a pixel apart. */
export function loadSplitThumbLayout(): KeyboardLayout {
  const fixturePath = join(__dirname, '../../../../../e2e/fixtures/e2e_test_split_thumb.json')
  return loadLayoutFixture(fixturePath, 'e2e_test_split_thumb.json')
}
