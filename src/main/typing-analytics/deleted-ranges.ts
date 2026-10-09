// SPDX-License-Identifier: GPL-2.0-or-later
// The deleted-ranges file of one (keyboard uid, machineHash): time ranges
// that another device deleted from that device's typing data. Each entry
// removes the rows whose time (minute start, session start) is inside
// `[startMs, endMs)` and at or before `cutoffMs`, the moment the delete was
// asked for, so typing recorded after the delete stays. Entries never change
// once written; devices combine their copies by taking the union of the ids.
//
// File shape: `{ version: 1, entries: [{ id, startMs, endMs, cutoffMs }] }`.

import { localDayRangeMs } from '../../shared/local-day-range'

const DELETED_RANGES_FILE_VERSION = 1

/** Longest accepted id, a bound on hostile input. */
const MAX_ID_LENGTH = 128

/** A range of time to delete: `[startMs, endMs)`, limited to times at or
 * before `cutoffMs` (the moment the delete was asked for). */
export interface DeleteRange {
  startMs: number
  endMs: number
  cutoffMs: number
}

export type DeletedRangeEntry = DeleteRange & { id: string }

export interface DeletedRangesUnion {
  entries: DeletedRangeEntry[]
  /** The other side held an id this side lacks. */
  localChanged: boolean
  /** This side holds an id the other side lacks. */
  remoteNeedsUpdate: boolean
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isDeletedRangeEntry(value: unknown): value is DeletedRangeEntry {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return typeof e.id === 'string'
    && e.id.length > 0
    && e.id.length <= MAX_ID_LENGTH
    && isTime(e.startMs)
    && isTime(e.endMs)
    && e.endMs > e.startMs
    && isTime(e.cutoffMs)
}

/** Fixed order so every device writes the same file for the same set. */
function sortEntries(entries: DeletedRangeEntry[]): DeletedRangeEntry[] {
  return entries.sort((a, b) => a.cutoffMs - b.cutoffMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Only the four known fields, so stray fields of a remote copy are not
 * written back. */
function pickEntry(e: DeletedRangeEntry): DeletedRangeEntry {
  return { id: e.id, startMs: e.startMs, endMs: e.endMs, cutoffMs: e.cutoffMs }
}

/** The valid entries of a parsed file, sorted, the first copy of each id
 * kept. Null when the file itself has the wrong shape. */
export function parseDeletedRangesFile(value: unknown): DeletedRangeEntry[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const file = value as Record<string, unknown>
  if (file.version !== DELETED_RANGES_FILE_VERSION || !Array.isArray(file.entries)) return null
  const byId = new Map<string, DeletedRangeEntry>()
  for (const e of file.entries) {
    if (isDeletedRangeEntry(e) && !byId.has(e.id)) byId.set(e.id, pickEntry(e))
  }
  return sortEntries([...byId.values()])
}

export function serializeDeletedRanges(entries: readonly DeletedRangeEntry[]): string {
  return JSON.stringify({ version: DELETED_RANGES_FILE_VERSION, entries }, null, 2)
}

/** Union by id; for an id both sides hold, the local copy is kept. */
export function unionDeletedRanges(
  local: readonly DeletedRangeEntry[],
  other: readonly DeletedRangeEntry[],
): DeletedRangesUnion {
  const localIds = new Set(local.map((e) => e.id))
  const otherIds = new Set(other.map((e) => e.id))
  const added = other.filter((e) => !localIds.has(e.id))
  return {
    entries: sortEntries([...local, ...added].map(pickEntry)),
    localChanged: added.length > 0,
    remoteNeedsUpdate: local.some((e) => !otherIds.has(e.id)),
  }
}

/** One entry per run of consecutive local calendar days in `dates`
 * (`YYYY-MM-DD`, any order, duplicates allowed), all with `cutoffMs`.
 * Throws `RangeError` for a value that is not a date. */
export function deletedRangesForLocalDays(
  dates: readonly string[],
  cutoffMs: number,
  newId: () => string,
): DeletedRangeEntry[] {
  const ranges = dates.map((date) => {
    const range = localDayRangeMs(date)
    if (!range) throw new RangeError(`Invalid local day: ${date}`)
    return range
  }).sort((a, b) => a.startMs - b.startMs)
  const joined: Array<{ startMs: number; endMs: number }> = []
  for (const range of ranges) {
    const last = joined.at(-1)
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs)
    else joined.push({ ...range })
  }
  return joined.map((range) => ({ id: newId(), ...range, cutoffMs }))
}

/** The entry for "delete everything recorded up to now": every time at or
 * before `cutoffMs`. */
export function deletedRangeForAll(cutoffMs: number, id: string): DeletedRangeEntry {
  return { id, startMs: 0, endMs: cutoffMs + 1, cutoffMs }
}
