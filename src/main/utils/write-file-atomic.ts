// SPDX-License-Identifier: GPL-2.0-or-later
//
// Temp-file-then-rename write so a reader can never observe a torn
// (partially-written) file. Used by the JSON stores and indexes under
// `userData/sync/` and `userData/local/`, and for the safeStorage-encrypted
// secrets and password-change state under `userData/local/auth/` (binary
// content is written byte-for-byte).
//
// Each call writes its own temp file, `<path>.<pid>.<random hex>.tmp`, in
// the target's directory, so concurrent writes to the same path never
// share, overwrite or delete each other's temp file; the last rename wins.
// `sweep-orphan-pack-bodies.ts` matches this name format for pack bodies
// (`*.json.<pid>.<hex>.tmp`) — keep the two in step.
//
// On a failure — writing the temp file itself (e.g. ENOSPC, which can
// still leave a partial file on disk before rejecting) or renaming it
// into place — the temp file is removed on a best-effort basis before the
// original error is rethrown. If the process dies between the write and
// the rename, the temp file stays behind; only the pack directories are
// swept, so elsewhere (including `local/auth/`) it is left in place.
// Does not create the parent directory — callers mkdir before calling this.

import { randomBytes } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'

export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmpPath, content)
    await rename(tmpPath, path)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}
