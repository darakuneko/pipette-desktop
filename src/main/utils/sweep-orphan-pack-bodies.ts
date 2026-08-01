// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared orphan-file sweep body for the i18n/theme pack stores: deletes
// any `.json` file in `packsDir` that has no matching entry in
// `knownFileNames`, plus any stray `*.json.tmp` leftover — the
// temp-file half of `writeFileAtomic`'s temp-file-then-rename that never
// got renamed (a crash between the write and the rename). A `.tmp` file
// is always an orphan by construction: nothing ever reads it back, and
// `knownFileNames` (built from real `.json` entries) can never contain
// its name, so it's swept unconditionally rather than checked against
// the known set. Both stores call this from inside their own
// `withIndexWriteLock` (see each store's `runGcUnderLock` doc) so a
// concurrent save/rename/delete can't race the sweep reading a stale
// index — the lock itself stays store-private, only the sweep body is
// shared here.

import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Best-effort: a missing `packsDir` or a per-file unlink failure is
 *  swallowed, returning however many files were actually removed. */
export async function sweepOrphanFiles(packsDir: string, knownFileNames: ReadonlySet<string>): Promise<number> {
  let removed = 0
  try {
    const entries = await readdir(packsDir)
    for (const file of entries) {
      const isOrphanCandidate = file.endsWith('.json.tmp') ||
        (file.endsWith('.json') && !knownFileNames.has(file))
      if (!isOrphanCandidate) continue
      try {
        await unlink(join(packsDir, file))
        removed += 1
      } catch { /* swallow */ }
    }
  } catch {
    // packs dir may not exist yet
  }
  return removed
}
