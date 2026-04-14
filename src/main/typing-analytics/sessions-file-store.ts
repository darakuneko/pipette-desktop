// SPDX-License-Identifier: GPL-2.0-or-later
// Append-only writer for typing session records. One JSONL file per
// keyboard per *start* date — sessions that span midnight stay in the
// start-date file rather than being split, matching the design in
// .claude/plans/typing-analytics.md.

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TypingSessionRecord } from '../../shared/types/typing-analytics'
import { sessionsFilePath } from './typing-analytics-paths'

/** Append a session record to its start-date JSONL file. */
export async function appendSessionRecord(
  uid: string,
  record: TypingSessionRecord,
): Promise<void> {
  const startDate = record.start.slice(0, 10) // YYYY-MM-DD
  const path = sessionsFilePath(uid, startDate)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf-8')
}
