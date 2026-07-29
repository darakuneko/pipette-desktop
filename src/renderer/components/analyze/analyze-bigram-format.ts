// SPDX-License-Identifier: GPL-2.0-or-later
// Display helpers shared between the Bigrams Top / Slow / Heatmap
// views. Numeric keycode pair ids are decoded to human-readable
// labels via the keycodes utility, with a raw-id fallback so a partial
// decode still surfaces actionable rows.

import { codeToLabel } from '../../../shared/keycodes/keycodes'
import type { TypingBigramTopEntry } from '../../../shared/types/typing-analytics'
import { rolloverRatio } from './analyze-rollover'

/** Convert a stored n-gram id — `"4_11"` (bigram) or `"4_11_42"`
 * (trigram) — into a display label such as `"A → H"` or
 * `"A → H → Bksp"`. Falls back to the raw id when the part count isn't
 * 2 or 3, any part is empty, or any part is not a finite number, so
 * the renderer never throws on schema drift. */
export function bigramPairLabel(bigramId: string): string {
  const parts = bigramId.split('_')
  if (parts.length !== 2 && parts.length !== 3) return bigramId
  // Reject empty parts explicitly: `Number('')` coerces to 0 rather
  // than NaN, which would otherwise label `"4_"` as `"A → "` instead
  // of returning the raw id.
  if (parts.some((p) => p.length === 0)) return bigramId
  const codes = parts.map(Number)
  if (codes.some((n) => !Number.isFinite(n))) return bigramId
  return codes.map((n) => codeToLabel(n)).join(' → ')
}

/** This pair's own observed rollover rate — entry adapter over the
 * canonical {@link rolloverRatio} contract (see that function's doc
 * comment for the null-pairing rationale). Trigram entries always
 * resolve to null here since `aggregatePairTotals` never populates
 * their overlap accumulators. Shared by the ranking tables and the
 * Bigrams CSV export so both surfaces agree on what counts as
 * "unobserved".
 *
 * `overlapCount == null` short-circuits to null locally instead of
 * coalescing to 0 and letting `rolloverRatio`'s own `on` check catch
 * it: `?? 0` would silently manufacture a fake "0 overlaps observed"
 * count whenever `overlapCount` is absent, correct today only because
 * the wire contract happens to always pair it with `overlapN` — a
 * guard this local removes the need to trust. */
export function rolloverRatioFromEntry(entry: Pick<TypingBigramTopEntry, 'overlapCount' | 'overlapN'>): number | null {
  if (entry.overlapCount == null) return null
  return rolloverRatio(entry.overlapCount, entry.overlapN)
}
