// SPDX-License-Identifier: GPL-2.0-or-later
// Display helpers shared between the Bigrams Top / Slow / Heatmap
// views. Numeric keycode pair ids are decoded to human-readable
// labels via the keycodes utility, with a raw-id fallback so a partial
// decode still surfaces actionable rows.

import { codeToLabel } from '../../../shared/keycodes/keycodes'
import { withSerializeProtocol } from '../../../shared/keycodes/with-protocol'
import type { TypingBigramTopEntry } from '../../../shared/types/typing-analytics'
import { rolloverRatio } from './analyze-rollover'
import { snapshotCodeLabel } from './analyze-snapshot-codes'

/** Splits a stored n-gram id — `"4_11"` (bigram) or `"4_11_42"`
 * (trigram) — into its numeric codes, or `null` when the part count
 * isn't 2 or 3, any part is empty, or any part is not a finite number
 * (shared validation for `bigramPairLabel`/`bigramPairLabels`). Reject
 * empty parts explicitly: `Number('')` coerces to 0 rather than NaN,
 * which would otherwise label `"4_"` as `"A → "` instead of falling
 * back to the raw id. */
function parseNgramCodes(bigramId: string): number[] | null {
  const parts = bigramId.split('_')
  if (parts.length !== 2 && parts.length !== 3) return null
  if (parts.some((p) => p.length === 0)) return null
  const codes = parts.map(Number)
  if (codes.some((n) => !Number.isFinite(n))) return null
  return codes
}

/** Resolves one numeric n-gram code to a display label. When `code` is
 * in `qmkByCode` (from `buildSnapshotQmkByCode`/`useSnapshotQmkByCode`),
 * that's the snapshot's own recorded qmkId string, resolved via
 * `snapshotCodeLabel` (no serialize round-trip, so it doesn't matter
 * that the snapshot's keyboard may have had more layers/macros/TDs
 * than the session currently sees). A code missing from the map falls
 * back to `codeToLabel` — the caller is responsible for running that
 * fallback under the snapshot's own protocol (see
 * `withSerializeProtocol` callers below). */
function resolveNgramLabel(code: number, qmkByCode?: ReadonlyMap<number, string>): string {
  const qmkId = qmkByCode?.get(code)
  return qmkId !== undefined ? snapshotCodeLabel(qmkId) : codeToLabel(code)
}

/** Convert a stored n-gram id into a display label such as `"A → H"`
 * or `"A → H → Bksp"`. Falls back to the raw id when
 * `parseNgramCodes` can't parse it, so the renderer never throws on
 * schema drift.
 *
 * Any code missing from `qmkByCode` resolves via `codeToLabel`, scoped
 * to the snapshot's own protocol via `withSerializeProtocol` — unlike
 * before, where this fallback had NO protocol wrapper at all and
 * resolved protocol-dependent codes (e.g. `QK_BOOT`) against whatever
 * protocol happened to be globally active. Without `qmkByCode` every
 * part takes the miss path, reproducing today's behavior exactly.
 *
 * For rendering many rows at once (a ranking table), prefer
 * `bigramPairLabels` below — it resolves every row's miss codes under
 * a single `withSerializeProtocol` scope instead of one
 * `recreateKeycodes` round-trip per row. */
export function bigramPairLabel(
  bigramId: string,
  qmkByCode?: ReadonlyMap<number, string>,
  vialProtocol?: number,
): string {
  const codes = parseNgramCodes(bigramId)
  if (!codes) return bigramId
  const hasMiss = codes.some((n) => !qmkByCode?.has(n))
  const labels = hasMiss
    ? withSerializeProtocol(vialProtocol, () => codes.map((n) => resolveNgramLabel(n, qmkByCode)))
    : codes.map((n) => resolveNgramLabel(n, qmkByCode))
  return labels.join(' → ')
}

/** Batched sibling of `bigramPairLabel` for a whole ranking table's
 * worth of rows: resolves every row's miss codes under ONE
 * `withSerializeProtocol` scope instead of paying a `recreateKeycodes`
 * round-trip per row (the same batching `buildSpeedRanking` in
 * key-heatmap-helpers.ts applies to the Speed ranking). Order and
 * malformed-id fallback match `bigramPairLabel` exactly, one label per
 * input id. */
export function bigramPairLabels(
  bigramIds: readonly string[],
  qmkByCode?: ReadonlyMap<number, string>,
  vialProtocol?: number,
): string[] {
  const parsed = bigramIds.map(parseNgramCodes)
  const hasAnyMiss = parsed.some((codes) => codes?.some((n) => !qmkByCode?.has(n)))
  const resolveAll = (): string[] => parsed.map((codes, i) =>
    codes ? codes.map((n) => resolveNgramLabel(n, qmkByCode)).join(' → ') : bigramIds[i],
  )
  return hasAnyMiss ? withSerializeProtocol(vialProtocol, resolveAll) : resolveAll()
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
