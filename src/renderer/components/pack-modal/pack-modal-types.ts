// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared types for the three pack-management modals (Language Packs,
// Theme Packs, Key Labels). Phase 1 of the pack-modal-unification plan
// extracts the common shell (PackManagerModal / PackListRow /
// PackHubTab) while keeping every existing per-feature asymmetry
// (delete cascade, hub search ordering, installed-detection, columns,
// drag) exactly as it behaves today. See
// `.claude/plans/Plan-pack-modal-unification.md`.

/** Inline per-row success/error feedback shown under the Hub action line. */
export interface PackActionResult {
  id: string
  kind: 'success' | 'error'
  message: string
}

export type PackManagerTabId = 'installed' | 'hub'
