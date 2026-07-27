// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { popoverInstanceKey } from '../keymap-editor-popover'
import type { PopoverState } from '../keymap-editor-types'

const RECT_A = { top: 0, left: 0, bottom: 40, right: 60, width: 60, height: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
const RECT_B = { top: 10, left: 10, bottom: 50, right: 70, width: 60, height: 40, x: 10, y: 10, toJSON: () => ({}) } as DOMRect

describe('popoverInstanceKey', () => {
  it('differs when the position (row/col) changes — this is what makes Auto Move advance remount the popover', () => {
    const a: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'key', row: 0, col: 0, maskClicked: false }
    const b: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'key', row: 0, col: 1, maskClicked: false }
    expect(popoverInstanceKey(a)).not.toBe(popoverInstanceKey(b))
  })

  it('differs when maskClicked changes', () => {
    const a: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'key', row: 0, col: 0, maskClicked: false }
    const b: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'key', row: 0, col: 0, maskClicked: true }
    expect(popoverInstanceKey(a)).not.toBe(popoverInstanceKey(b))
  })

  it('differs between a key target and an encoder target at the same position-like fields', () => {
    const key: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'key', row: 0, col: 0, maskClicked: false }
    const encoder: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'encoder', idx: 0, dir: 0, maskClicked: false }
    expect(popoverInstanceKey(key)).not.toBe(popoverInstanceKey(encoder))
  })

  it('differs when the encoder idx/dir changes', () => {
    const a: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'encoder', idx: 0, dir: 0, maskClicked: false }
    const b: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'encoder', idx: 0, dir: 1, maskClicked: false }
    const c: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'encoder', idx: 1, dir: 0, maskClicked: false }
    expect(popoverInstanceKey(a)).not.toBe(popoverInstanceKey(b))
    expect(popoverInstanceKey(a)).not.toBe(popoverInstanceKey(c))
  })

  it('stays the same when only anchorRect changes — position measurement is not part of the target identity', () => {
    const a: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'key', row: 0, col: 0, maskClicked: false }
    const b: NonNullable<PopoverState> = { anchorRect: RECT_B, kind: 'key', row: 0, col: 0, maskClicked: false }
    expect(popoverInstanceKey(a)).toBe(popoverInstanceKey(b))
  })

  it('is stable for the same target regardless of layer or anchorRect — the function takes no currentLayer ' +
    'parameter at all, so a layer-only change at the call site (KeymapEditor) can never remount the popover; ' +
    'that case is handled by usePopoverKeycodeWorkflow\'s own currentLayer effect instead, which lets activeTab survive it', () => {
    const state: NonNullable<PopoverState> = { anchorRect: RECT_A, kind: 'key', row: 2, col: 3, maskClicked: false }
    expect(popoverInstanceKey(state)).toBe(popoverInstanceKey({ ...state, anchorRect: RECT_B }))
  })
})
