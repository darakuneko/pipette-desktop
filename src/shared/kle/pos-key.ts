// SPDX-License-Identifier: GPL-2.0-or-later
//
// Canonical "row,col" string used as the Map / Record key for
// per-position lookups across the Analyze stack (heatmaps, ergonomics
// estimates, finger overrides, layout-comparison resolver, multi-key
// selection). One helper so the format stays in lockstep with the
// strings already shipping inside persisted overrides
// (PipetteSettings.analyze.fingerAssignments) and IPC payloads.

/** Format `(row, col)` as the project-wide `"row,col"` position key. */
export function posKey(row: number, col: number): string {
  return `${row},${col}`
}
