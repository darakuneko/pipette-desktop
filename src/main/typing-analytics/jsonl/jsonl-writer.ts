// SPDX-License-Identifier: GPL-2.0-or-later
// Append-only writer for the per-device typing-analytics JSONL master
// files. The 1-writer per-file invariant is enforced by convention: a
// device only ever writes its own {machineHash}.jsonl and never touches
// other devices' files, so plain appendFile (no lock) is safe.

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JsonlRow } from './jsonl-row'
import { serializeRow } from './jsonl-row'

/** Append `rows` to the JSONL file at `path`, creating parent directories
 * as needed. Every row is serialized with a trailing newline so a
 * partial write cannot fake-complete a later line. A zero-length input
 * is a no-op (avoids the empty-fsync on idle flushes and also keeps the
 * file from being created before the first real row lands). */
export async function appendRowsToFile(
  path: string,
  rows: readonly JsonlRow[],
): Promise<void> {
  if (rows.length === 0) return
  await mkdir(dirname(path), { recursive: true })
  const payload = rows.map(serializeRow).join('')
  await appendFile(path, payload, 'utf8')
}
