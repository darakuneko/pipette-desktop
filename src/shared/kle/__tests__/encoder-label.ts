// SPDX-License-Identifier: GPL-2.0-or-later

// Real Vial KLE encoder label: "idx,dir" followed by 9 newlines then "e" —
// under the KLE parser's default (no-centering) alignment, raw label index 9
// reorders into canonical position 4, which is what marks a key as an
// encoder (verified against kle-parser.ts's labelMap).
export function encoderLabel(idx: number, dir: number): string {
  return `${idx},${dir}${'\n'.repeat(9)}e`
}
