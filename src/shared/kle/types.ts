// SPDX-License-Identifier: GPL-2.0-or-later
// KLE (Keyboard Layout Editor) type definitions
// Based on https://github.com/ijprest/kle-serial

/** A single key in a KLE layout */
export interface KleKey {
  x: number
  y: number
  width: number
  height: number
  x2: number
  y2: number
  width2: number
  height2: number
  rotation: number
  rotationX: number
  rotationY: number
  color: string
  labels: (string | null)[] // 12 elements
  textColor: (string | null)[]
  textSize: (number | null)[]
  row: number
  col: number
  encoderIdx: number // -1 if not encoder
  encoderDir: number // 0=CW, 1=CCW, -1 if not encoder
  layoutIndex: number // -1 if no layout option
  layoutOption: number // -1 if no layout option
  decal: boolean
  nub: boolean
  stepped: boolean
  ghost: boolean
}

/** Parsed keyboard layout from KLE data */
export interface KeyboardLayout {
  keys: KleKey[]
}
