// SPDX-License-Identifier: GPL-2.0-or-later

// Shared KLE test fixtures for the keyboard widget / matrix-wires test
// suites: a default KleKey factory, common gutter/cell fixtures, and the
// virtual-device GPK60-63R definition loader used by several of them.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KleKey, KeyboardLayout } from '../../../../shared/kle/types'
import { parseDefinitionLayout } from '../../../../shared/kle/definition-layout'
import type { KeyboardDefinition } from '../../../../shared/types/protocol'
import type { MatrixWiresGutter } from '../matrix-wires'

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

/** A gutter fixture wide enough for label-placement math without a real
 *  KeyboardWidget render — used by suites that don't care about the exact
 *  gutter size, only that one is present. */
export const NO_GUTTER: MatrixWiresGutter = { originX: -10, originY: -10, size: 20, fontSize: 10 }

/** No overrides — every key's effective position is its own physical
 *  (row, col), matching `buildMatrixWires`'s documented fallback. */
export const IDENTITY_CELLS = new Map<string, { row: number; col: number }>()

/** Loads the virtual GPK60-63R device's keyboard layout — a real,
 *  non-trivial definition (sparse rows, encoders) shared by suites that
 *  exercise matrix-wires geometry against actual keyboard data instead of
 *  hand-built fixtures. */
export function loadVirtualDeviceLayout(): KeyboardLayout {
  const fixturePath = join(__dirname, '../../../../main/virtual-device/gpk60-63r-definition.json')
  const definition = JSON.parse(readFileSync(fixturePath, 'utf-8')) as KeyboardDefinition
  const { layout } = parseDefinitionLayout(definition)
  if (!layout) throw new Error('gpk60-63r-definition.json produced no layout')
  return layout
}
