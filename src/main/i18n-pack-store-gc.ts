// SPDX-License-Identifier: GPL-2.0-or-later
//
// GC: purge tombstones older than the TTL, then sweep orphan pack-body
// files — see `runGcUnderLock`'s doc for the single-lock post-pass
// contract `pack-gc.ts` relies on.

import { readFile, readdir, unlink } from 'node:fs/promises'
import { notifyChange } from './sync/sync-service'
import { log } from './logger'
import { sweepOrphanFiles } from './utils/sweep-orphan-pack-bodies'
import {
  I18N_INDEX_SYNC_UNIT,
  I18N_PACK_TOMBSTONE_TTL_MS,
  type I18nPackIndex,
  type I18nPackMeta,
} from '../shared/types/i18n-store'
import { getIndexPath, getPackPath, getPacksDir, withIndexWriteLock, writeIndex } from './i18n-pack-store-internal'

async function purgeExpiredTombstonesInPlace(index: I18nPackIndex): Promise<{ removed: number; touched: boolean }> {
  const cutoff = Date.now() - I18N_PACK_TOMBSTONE_TTL_MS
  const kept: I18nPackMeta[] = []
  let removed = 0
  for (const meta of index.metas) {
    if (meta.deletedAt && new Date(meta.deletedAt).getTime() < cutoff) {
      removed += 1
      // Best-effort delete the pack body — the meta itself is dropped.
      try { await unlink(getPackPath(meta.id)) } catch { /* swallow */ }
      continue
    }
    kept.push(meta)
  }
  if (removed === 0) return { removed: 0, touched: false }
  index.metas = kept
  return { removed, touched: true }
}

/**
 * Distinguishes a genuinely untrustworthy index from a legitimately
 * empty one, for `runGcUnderLock`'s sweep-safety check:
 *   - Index file present and parses to an array `.metas` → trustworthy,
 *     whatever it contains (including empty).
 *   - Index file missing AND the packs dir is also missing/empty → a
 *     fresh store that never saved anything — legitimately empty.
 *   - Index file missing but the packs dir has at least one `.json`
 *     file → the index was lost (crash, partial migration, manual
 *     tampering) while pack bodies still exist; an empty roster here
 *     would make the sweep below delete every one of them. Untrustworthy.
 *   - Index file present but unparseable (corrupt JSON / non-array
 *     `.metas`) → untrustworthy regardless of the packs dir.
 * `ok: false` short-circuits BOTH purge and sweep in `runGcUnderLock` —
 * there is no trustworthy roster to purge tombstones from either.
 */
async function readIndexForGc(): Promise<{ ok: true; index: I18nPackIndex } | { ok: false }> {
  let raw: string
  try {
    raw = await readFile(getIndexPath(), 'utf-8')
  } catch {
    try {
      const entries = await readdir(getPacksDir())
      if (entries.some((f) => f.endsWith('.json'))) return { ok: false }
    } catch {
      // packs dir doesn't exist either — legitimately empty, fall through
    }
    return { ok: true, index: { metas: [] } }
  }
  try {
    const parsed = JSON.parse(raw) as I18nPackIndex
    if (Array.isArray(parsed?.metas)) return { ok: true, index: parsed }
  } catch {
    // fall through to ok: false
  }
  return { ok: false }
}

/**
 * Single-lock post-pass GC: purge expired tombstones (writing the index
 * once if anything changed) then sweep orphan pack-body files — all
 * inside ONE `withIndexWriteLock` acquisition instead of purge and
 * sweep each separately re-reading the index under their own lock.
 * Halves the lock/read round-trips `pack-gc.ts` previously needed per
 * store, and closes the purge→sweep interleave window a separate-lock
 * sequence would otherwise leave open (a concurrent write landing
 * between the two could make the sweep see a stale, pre-purge index).
 * Wired at the PASS level only (never per sync unit) via `pack-gc.ts` —
 * see its module doc for why per-unit sweeping is unsafe (index and
 * pack-body sync units merge in parallel with no ordering guarantee).
 *
 * `options.skipSweep` — set by `pack-gc.ts` when at least one of this
 * store's sync units failed to merge in the pass that triggered this
 * call: the just-read index cannot be trusted as a complete "still
 * active" roster in that case, so sweeping against it risks deleting a
 * body file for an entry that simply hasn't merged in yet. Purge still
 * runs (index-only, safe regardless).
 *
 * When the index itself is untrustworthy (`readIndexForGc` returns
 * `ok: false` — missing while pack bodies exist, or unparseable), BOTH
 * purge and sweep are skipped and a unit-name-only warning is logged —
 * an empty-roster fallback here would otherwise make the sweep below
 * delete every pack body on disk.
 */
export async function runGcUnderLock(options?: { skipSweep?: boolean }): Promise<{ purged: number; swept: number }> {
  return withIndexWriteLock(async () => {
    const safeIndex = await readIndexForGc()
    if (!safeIndex.ok) {
      log('warn', `pack-gc: skipped ${I18N_INDEX_SYNC_UNIT} sweep — index missing/unreadable while pack bodies exist`)
      return { purged: 0, swept: 0 }
    }
    const index = safeIndex.index
    const purgeResult = await purgeExpiredTombstonesInPlace(index)
    if (purgeResult.touched) {
      await writeIndex(index)
      notifyChange(I18N_INDEX_SYNC_UNIT)
    }
    if (options?.skipSweep) {
      log('warn', `pack-gc: skipped ${I18N_INDEX_SYNC_UNIT} sweep — a sync unit failed this pass`)
      return { purged: purgeResult.removed, swept: 0 }
    }
    const known = new Set(index.metas.map((m) => `${m.id}.json`))
    const swept = await sweepOrphanFiles(getPacksDir(), known)
    return { purged: purgeResult.removed, swept }
  })
}
