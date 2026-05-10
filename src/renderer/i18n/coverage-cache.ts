// SPDX-License-Identifier: GPL-2.0-or-later
//
// In-memory coverage cache for installed language packs. Coverage is
// expensive (flattens both the pack and the English baseline) so we
// cache the result keyed by `(packId, packVersion, baseRevision)` and
// invalidate when any factor changes:
//   * pack import / re-import / Hub download (packVersion changes)
//   * pack disable / delete (entry purged)
//   * English baseline updates between releases (baseRevision changes)
//   * language switch (no recompute, just lookup)
//
// The cache is module-level — Settings UI components read it via the
// `useCoverage` hook so multiple rows share the same computation.

import english from './locales/english.json'
import {
  computeCoverage,
  type CoverageResult,
} from '../../shared/i18n/coverage'

const englishObj = english as Record<string, unknown>

/** Stable identifier for the bundled English baseline. The pack
 * `version` of `english.json` doubles as the baseline revision —
 * incrementing it after a translation rebase forces every pack's
 * coverage to be recomputed on the next access. */
export const BASE_REVISION: string = typeof englishObj.version === 'string'
  ? englishObj.version
  : '0.0.0'

export const ENGLISH_PACK_BODY: Record<string, unknown> = englishObj

interface CoverageCacheEntry {
  packId: string
  packVersion: string
  baseRevision: string
  result: CoverageResult
}

const cache = new Map<string, CoverageCacheEntry>()
const subscribers = new Set<() => void>()

function notify(): void {
  for (const sub of subscribers) sub()
}

export function subscribeCoverage(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function getCachedCoverage(
  packId: string,
  packVersion: string,
): CoverageResult | null {
  const entry = cache.get(packId)
  if (!entry) return null
  if (entry.packVersion !== packVersion || entry.baseRevision !== BASE_REVISION) return null
  return entry.result
}

export function setCachedCoverage(
  packId: string,
  packVersion: string,
  result: CoverageResult,
): void {
  cache.set(packId, { packId, packVersion, baseRevision: BASE_REVISION, result })
  notify()
}

export function invalidateCoverage(packId: string): void {
  if (cache.delete(packId)) notify()
}

export function invalidateAllCoverage(): void {
  if (cache.size === 0) return
  cache.clear()
  notify()
}

/** Recompute coverage for a single pack body and cache the result.
 * Returns the freshly-computed coverage so callers can show it
 * synchronously after import. */
export function recomputeCoverageFromBody(
  packId: string,
  packVersion: string,
  packBody: unknown,
): CoverageResult {
  const result = computeCoverage(packBody, ENGLISH_PACK_BODY)
  setCachedCoverage(packId, packVersion, result)
  return result
}

/** Pull the pack body from main and refresh its coverage entry. */
export async function refreshCoverageFromIpc(
  packId: string,
  packVersion: string,
): Promise<CoverageResult | null> {
  const cached = getCachedCoverage(packId, packVersion)
  if (cached) return cached
  try {
    const result = await window.vialAPI.i18nPackGet(packId)
    if (!result.success || !result.data) return null
    return recomputeCoverageFromBody(packId, packVersion, result.data.pack)
  } catch {
    return null
  }
}
