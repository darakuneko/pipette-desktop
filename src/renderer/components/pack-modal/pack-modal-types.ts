// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared types for the three pack-management modals (Language Packs,
// Theme Packs, Key Labels) and their common shell (`PackManagerModal`).
// Each modal keeps its own delete cascade and row columns on top of this
// shared shape.

/** Inline per-row success/error feedback shown under the Hub action line. */
export interface PackActionResult {
  id: string
  kind: 'success' | 'error'
  message: string
}

export type PackManagerTabId = 'installed' | 'hub'
