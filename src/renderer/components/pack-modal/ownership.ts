// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared ownership rule for the pack modals' Update/Remove gating.
// Originated in Key Labels and was duplicated verbatim into Language
// Packs and Theme Packs when Phase 3 gave them the same Author/isMine
// semantics — this extracts the one-line rule so all three read from
// a single definition instead of three copies that could drift.

/**
 * True when the current user may Update/Remove a Hub-linked row: a row
 * with no Hub post at all trivially counts as "mine" (nothing to be
 * foreign about yet); otherwise the cached uploader name must match
 * the signed-in display name. `ownerName` is deliberately a neutral
 * parameter name — Key Labels' row field is called `author`, while
 * Language/Theme Packs call theirs `uploaderName`.
 */
export function isOwnPack(hubPostId: string | null | undefined, ownerName: string, currentDisplayName: string | null): boolean {
  return !hubPostId || ownerName === currentDisplayName
}
