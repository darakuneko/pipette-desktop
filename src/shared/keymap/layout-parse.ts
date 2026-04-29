// SPDX-License-Identifier: GPL-2.0-or-later
//
// Parse `keyboard-layouts.ts` display strings (e.g. "?\n6", "Ç    ~",
// "\\\n/    |") and build forward / reverse maps used by Layout
// Optimizer (Plan-analyze-layout-comparison).
//
// Format:
//   - First line (before "\n"): shift label (optional).
//   - Second line (after "\n") OR the entire string when no "\n":
//     base label, optionally followed by "    altgr" (4 spaces).
//   - The first code point of the base segment is the lookup char in
//     reverse maps (lowercased to keep case-insensitive matching).
//
// QWERTY is the implicit baseline: layouts only override the qmkIds
// that differ. Forward maps therefore start from the QWERTY printable
// set (derived from the keycodes registry) and apply layout-specific
// overrides on top.
//
// shift / altgr resolution is parsed but not used by reverse maps in
// Phase 1 — Layout Comparison compares base char distributions only.

import { qmkIdToKeycode } from '../keycodes/keycodes'

export interface ParsedLayoutEntry {
  base: string
  shift?: string
  altgr?: string
}

export interface LayoutShape {
  /** qmkId → display string. QWERTY base is implied for missing keys. */
  map: Record<string, string>
}

const ALTGR_SEPARATOR = '    '

/** Parse a single layout display string into base / shift / altgr. */
export function parseLayoutEntry(raw: string): ParsedLayoutEntry {
  if (!raw) return { base: '' }
  const lines = raw.split('\n')
  const baseLine = lines.length >= 2 ? lines[1] : lines[0]
  const baseSplit = splitAltgr(baseLine ?? '')
  const entry: ParsedLayoutEntry = { base: baseSplit.main }
  if (baseSplit.altgr !== undefined) entry.altgr = baseSplit.altgr
  if (lines.length >= 2) {
    const shiftSplit = splitAltgr(lines[0] ?? '')
    entry.shift = shiftSplit.main
  }
  return entry
}

function splitAltgr(line: string): { main: string; altgr?: string } {
  const idx = line.indexOf(ALTGR_SEPARATOR)
  if (idx === -1) return { main: line }
  return {
    main: line.slice(0, idx),
    altgr: line.slice(idx + ALTGR_SEPARATOR.length),
  }
}

let qwertyBaseCache: Map<string, string> | null = null

/** qmkId → printable lowercase char for the QWERTY baseline. */
function getQwertyBase(): Map<string, string> {
  if (qwertyBaseCache) return qwertyBaseCache
  const map = new Map<string, string>()
  for (const keycode of qmkIdToKeycode.values()) {
    if (keycode.printable !== undefined) {
      map.set(keycode.qmkId, keycode.printable)
    }
  }
  qwertyBaseCache = map
  return map
}

// Cache keyed on `layout.map` (the inner record) instead of the outer
// LayoutShape so callers can recreate the wrapper object cheaply
// without busting the cache, as long as the underlying map reference
// is stable.
type LayoutMap = LayoutShape['map']
const forwardCache = new WeakMap<LayoutMap, Map<string, ParsedLayoutEntry>>()
const reverseCache = new WeakMap<LayoutMap, Map<string, string>>()

/** qmkId → parsed entry, with QWERTY base seed + layout overrides. */
export function getForwardMap(layout: LayoutShape): Map<string, ParsedLayoutEntry> {
  const cached = forwardCache.get(layout.map)
  if (cached) return cached
  const fwd = new Map<string, ParsedLayoutEntry>()
  for (const [qmkId, base] of getQwertyBase()) {
    fwd.set(qmkId, { base })
  }
  for (const [qmkId, raw] of Object.entries(layout.map)) {
    fwd.set(qmkId, parseLayoutEntry(raw))
  }
  forwardCache.set(layout.map, fwd)
  return fwd
}

/** Lowercase base char → qmkId. First insertion wins on collisions. */
export function getReverseMap(layout: LayoutShape): Map<string, string> {
  const cached = reverseCache.get(layout.map)
  if (cached) return cached
  const rev = new Map<string, string>()
  for (const [qmkId, entry] of getForwardMap(layout)) {
    const ch = firstCodePoint(entry.base)
    if (ch === undefined) continue
    const key = ch.toLowerCase()
    if (!rev.has(key)) rev.set(key, qmkId)
  }
  reverseCache.set(layout.map, rev)
  return rev
}

export function firstCodePoint(s: string): string | undefined {
  for (const ch of s) return ch
  return undefined
}
