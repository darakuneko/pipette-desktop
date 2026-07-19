// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared "is this Hub result already installed locally?" check for the
// three pack modals' Find-on-Hub tab. Unifies what were three
// different rules:
//   - Key Labels: name match only (case-insensitive).
//   - Language/Theme Packs: `hubPostId` match only.
// Both signals are real and worth keeping — a renamed local copy of a
// downloaded pack no longer matches by name, and a from-scratch local
// import that happens to share a Hub pack's name has no `hubPostId`
// yet — so the unified rule checks `hubPostId` first, then falls back
// to a case-insensitive name match.

export interface InstalledDetectionEntry {
  hubPostId?: string
  name: string
}

export function isHubItemInstalled(
  item: { id: string; name: string },
  installedEntries: readonly InstalledDetectionEntry[],
): boolean {
  for (const entry of installedEntries) {
    if (entry.hubPostId && entry.hubPostId === item.id) return true
  }
  const nameLower = item.name.trim().toLowerCase()
  for (const entry of installedEntries) {
    if (entry.name.trim().toLowerCase() === nameLower) return true
  }
  return false
}
