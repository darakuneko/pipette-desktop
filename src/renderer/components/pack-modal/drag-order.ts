// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pure list-reordering helper shared by every draggable pack list
// (Key Labels, and — from Phase 2 — Language Packs / Theme Packs).
// Mirrors the `applyDragOrder` function that originally lived in
// `KeyLabelsModal.tsx`.

/**
 * Re-order `items` according to `order` (a list of ids in the desired
 * position). Any item not listed in `order` — typically one that
 * arrived mid-drag from a remote sync — keeps its underlying relative
 * position behind the explicitly-ordered prefix, so a row is never
 * silently dropped.
 */
export function applyDragOrder<T>(
  items: T[],
  order: string[] | null,
  getId: (item: T) => string,
): T[] {
  if (!order) return items
  const byId = new Map<string, T>()
  for (const item of items) byId.set(getId(item), item)
  const seen = new Set<string>()
  const out: T[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (!item || seen.has(id)) continue
    out.push(item)
    seen.add(id)
  }
  for (const item of items) {
    if (!seen.has(getId(item))) out.push(item)
  }
  return out
}
