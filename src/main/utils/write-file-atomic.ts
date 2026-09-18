// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared temp-file-then-rename write used by every read-modify-write
// index store (i18n/theme packs, local-data-import) so a reader can
// never observe a torn (partially-written) file. On a failure — writing
// the `.tmp` file itself (e.g. ENOSPC, which can still leave a partial
// file on disk before rejecting) or renaming it into place — the `.tmp`
// file is removed on a best-effort basis before the original error is
// rethrown, so a failed write never leaves an orphan behind for
// `sweep-orphan-pack-bodies.ts`'s unconditional `.tmp` sweep to find
// later. Does not create the parent directory — callers mkdir before
// calling this.

import { rename, unlink, writeFile } from 'node:fs/promises'

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp`
  try {
    await writeFile(tmpPath, content, 'utf-8')
    await rename(tmpPath, path)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}
