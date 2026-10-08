// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze filter snapshot store — save/load labelled search-condition
// snapshots per keyboard. File layout intentionally mirrors
// snapshot-store.ts so the existing index-based sync (sync-bundle /
// sync-service / merge) picks it up via the new
// "keyboards/{uid}/analyze_filters" sync unit; see snapshot-store.ts for
// the original rationale on uid validation, write locks, and
// tombstone-based deletes.

import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc/channels'
import { notifyChange } from './sync/sync-service'
import { withWriteLock } from './per-uid-write-lock'
import { secureHandle } from './ipc-guard'
import { isSafePathSegment, tsForFilename } from './utils/safe-filename'
import { writeFileAtomic } from './utils/write-file-atomic'
import {
  ANALYZE_FILTER_STORE_ERROR_MAX_ENTRIES,
  ANALYZE_FILTER_STORE_MAX_ENTRIES_PER_KEYBOARD,
  type AnalyzeFilterSnapshotIndex,
  type AnalyzeFilterSnapshotMeta,
} from '../shared/types/analyze-filter-store'
import type { HubPrivateLink } from '../shared/types/hub-private'
import { type ClockedEntry, type MetaGroup, idBodyFilename } from './sync/entry-clocks'
import { applyEntryMutation, createEntry, normalizeEntries, overwriteEntry } from './sync/entry-write'
import { readIndexMigrated } from './sync/body-filename-migration'

type AnalyzeFilterEntry = ClockedEntry<AnalyzeFilterSnapshotMeta>

interface ClockedAnalyzeFilterIndex {
  uid: string
  entries: AnalyzeFilterEntry[]
}

const MAX_ENTRIES_PER_KEYBOARD = ANALYZE_FILTER_STORE_MAX_ENTRIES_PER_KEYBOARD

function validateUid(uid: string): void {
  if (!isSafePathSegment(uid)) throw new Error('Invalid uid')
}

function getStoreDir(uid: string): string {
  return join(app.getPath('userData'), 'sync', 'keyboards', uid, 'analyze_filters')
}

function getIndexPath(uid: string): string {
  return join(getStoreDir(uid), 'index.json')
}

function getSafeFilePath(uid: string, filename: string): string {
  if (!isSafePathSegment(filename)) throw new Error('Invalid filename')
  return join(getStoreDir(uid), filename)
}

async function readIndex(uid: string): Promise<ClockedAnalyzeFilterIndex> {
  try {
    const raw = await readFile(getIndexPath(uid), 'utf-8')
    const parsed = JSON.parse(raw) as AnalyzeFilterSnapshotIndex
    if (parsed.uid === uid && Array.isArray(parsed.entries)) {
      return { ...parsed, entries: normalizeEntries('analyzeFilters', parsed.entries) }
    }
  } catch {
    // Missing or corrupt — start fresh
  }
  return { uid, entries: [] }
}

async function writeIndex(uid: string, index: ClockedAnalyzeFilterIndex): Promise<void> {
  const dir = getStoreDir(uid)
  await mkdir(dir, { recursive: true })
  await writeFileAtomic(getIndexPath(uid), JSON.stringify(index, null, 2))
}

/** `readIndex` for a caller holding the uid lock: also moves body files
 *  to id-carrying names (`migrateBodyFilenames`). */
function readIndexLocked(uid: string): Promise<ClockedAnalyzeFilterIndex> {
  return readIndexMigrated('analyzeFilters', getStoreDir(uid), () => readIndex(uid), (index) => writeIndex(uid, index))
}

/** `group` is the clock the mutation moves; `'delete'` tombstones the
 *  entry instead. */
async function updateEntry(
  uid: string,
  entryId: string,
  group: MetaGroup | 'delete',
  mutate: (entry: AnalyzeFilterEntry) => void = () => {},
): Promise<{ success: boolean; error?: string }> {
  return withWriteLock(uid, async () => {
    try {
      validateUid(uid)
      const index = await readIndexLocked(uid)
      if (!applyEntryMutation(index.entries, entryId, group, new Date(), mutate)) return { success: false, error: 'Entry not found' }
      await writeIndex(uid, index)
      notifyChange(`keyboards/${uid}/analyze_filters`)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}


export function setupAnalyzeFilterStore(): void {
  secureHandle(
    IpcChannels.ANALYZE_FILTER_STORE_LIST,
    async (
      _event,
      uid: string,
    ): Promise<{ success: boolean; entries?: AnalyzeFilterSnapshotMeta[]; error?: string }> => {
      try {
        validateUid(uid)
        const index = await readIndex(uid)
        return { success: true, entries: index.entries.filter((e) => !e.deletedAt) }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.ANALYZE_FILTER_STORE_SAVE,
    async (
      _event,
      uid: string,
      json: string,
      label: string,
      summary?: string,
    ): Promise<{ success: boolean; entry?: AnalyzeFilterSnapshotMeta; error?: string }> => {
      try {
        validateUid(uid)
        return await withWriteLock(uid, async () => {
          const index = await readIndexLocked(uid)
          const activeCount = index.entries.filter((e) => !e.deletedAt).length
          if (activeCount >= MAX_ENTRIES_PER_KEYBOARD) {
            return { success: false, error: ANALYZE_FILTER_STORE_ERROR_MAX_ENTRIES }
          }

          const dir = getStoreDir(uid)
          await mkdir(dir, { recursive: true })

          const now = new Date()
          const id = randomUUID()
          const filename = idBodyFilename('analyzeFilters', id, `${tsForFilename(now)}.json`)
          const filePath = getSafeFilePath(uid, filename)

          await writeFileAtomic(filePath, json)

          const entry = createEntry('analyzeFilters', {
            id,
            label,
            ...(summary ? { summary } : {}),
            filename,
            savedAt: now.toISOString(),
          }, now)

          index.entries.unshift(entry)
          await writeIndex(uid, index)

          notifyChange(`keyboards/${uid}/analyze_filters`)
          return { success: true, entry }
        })
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.ANALYZE_FILTER_STORE_LOAD,
    async (
      _event,
      uid: string,
      entryId: string,
    ): Promise<{ success: boolean; data?: string; error?: string }> => {
      try {
        validateUid(uid)
        const index = await readIndex(uid)
        const entry = index.entries.find((e) => e.id === entryId)
        if (!entry) return { success: false, error: 'Entry not found' }
        if (entry.deletedAt) return { success: false, error: 'Entry has been deleted' }

        const filePath = getSafeFilePath(uid, entry.filename)
        const data = await readFile(filePath, 'utf-8')
        return { success: true, data }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.ANALYZE_FILTER_STORE_UPDATE,
    async (
      _event,
      uid: string,
      entryId: string,
      json: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        validateUid(uid)
        return await withWriteLock(uid, async () => {
          const index = await readIndexLocked(uid)
          const at = index.entries.findIndex((e) => e.id === entryId)
          if (at < 0) return { success: false, error: 'Entry not found' }
          const entry = index.entries[at]
          // A user save: brings a deleted entry back (`overwriteEntry`).
          const filePath = getSafeFilePath(uid, entry.filename)
          await writeFileAtomic(filePath, json)

          index.entries[at] = overwriteEntry('analyzeFilters', entry, entry, new Date(), { body: true, explicit: true })
          await writeIndex(uid, index)

          notifyChange(`keyboards/${uid}/analyze_filters`)
          return { success: true }
        })
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.ANALYZE_FILTER_STORE_RENAME,
    async (_event, uid: string, entryId: string, newLabel: string) =>
      updateEntry(uid, entryId, 'name', (entry) => { entry.label = newLabel }),
  )

  secureHandle(
    IpcChannels.ANALYZE_FILTER_STORE_DELETE,
    async (_event, uid: string, entryId: string) =>
      updateEntry(uid, entryId, 'delete'),
  )

  // --- Set Hub Post ID ---
  // Mirrors favorite-store's setHubPostId handler. Called by the Hub
  // analytics upload IPC (`HUB_UPLOAD_ANALYTICS_POST`) on success so the
  // condition-store row can switch its primary action from "↑ Hub" to
  // "↻ Hub" without re-reading the saved JSON.
  secureHandle(
    IpcChannels.ANALYZE_FILTER_STORE_SET_HUB_POST_ID,
    async (_event, uid: string, entryId: string, hubPostId: string | null): Promise<{ success: boolean; error?: string }> => {
      return setAnalyzeFilterHubPostId(uid, entryId, hubPostId)
    },
  )

  secureHandle(
    IpcChannels.ANALYZE_FILTER_STORE_SET_HUB_PRIVATE,
    async (_event, uid: string, entryId: string, link: HubPrivateLink | null): Promise<{ success: boolean; error?: string }> => {
      return setAnalyzeFilterHubPrivate(uid, entryId, link)
    },
  )
}

/** Direct accessor used by Hub analytics IPC handlers — they need to
 * read the saved JSON for an entry by id without going through the
 * renderer round-trip. Returns the parsed payload + entry meta or
 * `null` if the entry is missing / tombstoned. */
export async function readAnalyzeFilterEntry(
  uid: string,
  entryId: string,
): Promise<{ entry: AnalyzeFilterSnapshotMeta; data: string } | null> {
  validateUid(uid)
  const index = await readIndex(uid)
  const entry = index.entries.find((e) => e.id === entryId)
  if (!entry) return null
  if (entry.deletedAt) return null
  const filePath = getSafeFilePath(uid, entry.filename)
  const data = await readFile(filePath, 'utf-8')
  return { entry, data }
}

/** Direct setter used by Hub analytics IPC handlers (Phase 3) so the
 * upload pipeline can stamp the new postId without going through the
 * renderer. The IPC handler `ANALYZE_FILTER_STORE_SET_HUB_POST_ID`
 * forwards to this function so renderer + main paths share one writer. */
export async function setAnalyzeFilterHubPostId(
  uid: string,
  entryId: string,
  hubPostId: string | null,
): Promise<{ success: boolean; error?: string }> {
  return updateEntry(uid, entryId, 'hub', (entry) => {
    const normalized = hubPostId?.trim() || null
    if (normalized === null) {
      delete entry.hubPostId
    } else {
      entry.hubPostId = normalized
      // public and private linkage are mutually exclusive
      delete entry.hubPrivate
    }
  })
}

/** Sets (or clears with `null`) the private Hub linkage on an analyze
 *  filter entry. Setting a link clears the public `hubPostId`. */
export async function setAnalyzeFilterHubPrivate(
  uid: string,
  entryId: string,
  link: HubPrivateLink | null,
): Promise<{ success: boolean; error?: string }> {
  return updateEntry(uid, entryId, 'hub', (entry) => {
    if (link === null) {
      delete entry.hubPrivate
    } else {
      entry.hubPrivate = link
      delete entry.hubPostId
    }
  })
}
