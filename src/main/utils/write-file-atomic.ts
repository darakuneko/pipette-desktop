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
// (`*.json.<pid>.<hex>.tmp`) — keep the two in step. When the target's
// name is so long that the temp name would pass the 255-byte name limit
// (`MAX_NAME_BYTES`), the temp name starts with the target's name cut
// short instead; pack names are short enough never to be cut.
//
// On a failure — writing the temp file itself (e.g. ENOSPC, which can
// still leave a partial file on disk before rejecting) or renaming it
// into place — the temp file is removed on a best-effort basis before the
// original error is rethrown. If the process dies between the write and
// the rename, the temp file stays behind; only the pack directories are
// swept, so elsewhere (including `local/auth/`) it is left in place.
// Does not create the parent directory — callers mkdir before calling this.
// `writeFileAtomicSync` does the same with synchronous fs calls, for state
// that must be on disk before the caller's next step.

import { randomBytes } from 'node:crypto'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { truncateUtf8, utf8ByteLength } from '../../shared/utils/utf8-truncate'

/** Name limit of the common file systems, in UTF-8 bytes (`utf8-truncate.ts`). */
const MAX_NAME_BYTES = 255

function tmpPathFor(path: string): string {
  const suffix = `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const name = basename(path)
  const room = MAX_NAME_BYTES - utf8ByteLength(suffix)
  if (utf8ByteLength(name) <= room) return `${path}${suffix}`
  return `${path.slice(0, path.length - name.length)}${truncateUtf8(name, room)}${suffix}`
}

export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const tmpPath = tmpPathFor(path)
  try {
    await writeFile(tmpPath, content)
    await rename(tmpPath, path)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}

export function writeFileAtomicSync(path: string, content: string | Uint8Array): void {
  const tmpPath = tmpPathFor(path)
  try {
    writeFileSync(tmpPath, content)
    renameSync(tmpPath, path)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // Best effort, as above.
    }
    throw err
  }
}
