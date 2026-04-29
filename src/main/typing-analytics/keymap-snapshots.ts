// SPDX-License-Identifier: GPL-2.0-or-later
// Record-start keymap snapshots. Each (uid, machineHash) pair gets a
// directory of timestamped JSON files; a new snapshot is only written
// when the layout/keymap content actually differs from the most
// recent one, so the on-disk footprint stays proportional to the
// user's actual keymap edits rather than to record sessions.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  TypingKeymapSnapshot,
  TypingKeymapSnapshotSummary,
} from '../../shared/types/typing-analytics'

/** `userData/typing-analytics/keymaps/{uid}/{machineHash}/`. All
 * files inside are `<savedAt>.json` snapshots. */
function snapshotDir(userDataDir: string, uid: string, machineHash: string): string {
  return join(userDataDir, 'typing-analytics', 'keymaps', uid, machineHash)
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function readSnapshotFile(path: string): Promise<TypingKeymapSnapshot | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as TypingKeymapSnapshot
  } catch {
    return null
  }
}

/** Returns savedAt timestamps (ms) for every snapshot file in the
 * (uid, machineHash) directory, sorted ascending. Used as an index
 * so the reader can pick the one that applies to a datetime range
 * without reading every file's body. */
async function listSavedAts(userDataDir: string, uid: string, machineHash: string): Promise<number[]> {
  const entries = await safeReaddir(snapshotDir(userDataDir, uid, machineHash))
  const ts: number[] = []
  for (const name of entries) {
    const m = name.match(/^(\d+)\.json$/)
    if (!m) continue
    const n = Number.parseInt(m[1], 10)
    if (Number.isFinite(n)) ts.push(n)
  }
  return ts.sort((a, b) => a - b)
}

/** Compare the parts a Key heatmap render depends on — productName /
 * savedAt are intentionally excluded so cosmetic-only refreshes don't
 * cut a new snapshot. */
function isSameContent(a: TypingKeymapSnapshot, b: TypingKeymapSnapshot): boolean {
  if (a.layers !== b.layers) return false
  if (a.matrix.rows !== b.matrix.rows || a.matrix.cols !== b.matrix.cols) return false
  if (JSON.stringify(a.keymap) !== JSON.stringify(b.keymap)) return false
  if (JSON.stringify(a.layout) !== JSON.stringify(b.layout)) return false
  return true
}

export interface SaveSnapshotResult {
  saved: boolean
  savedAt: number | null
}

/** Write `snapshot` when it differs from the most recent snapshot for
 * the same (uid, machineHash). No-op when the content is identical;
 * used by the record-start flow so keymaps don't accumulate every
 * session. */
export async function saveKeymapSnapshotIfChanged(
  userDataDir: string,
  snapshot: TypingKeymapSnapshot,
): Promise<SaveSnapshotResult> {
  const dir = snapshotDir(userDataDir, snapshot.uid, snapshot.machineHash)
  const existing = await listSavedAts(userDataDir, snapshot.uid, snapshot.machineHash)
  const latestSavedAt = existing[existing.length - 1]
  if (typeof latestSavedAt === 'number') {
    const latest = await readSnapshotFile(join(dir, `${latestSavedAt}.json`))
    if (latest && isSameContent(latest, snapshot)) {
      return { saved: false, savedAt: latestSavedAt }
    }
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${snapshot.savedAt}.json`), JSON.stringify(snapshot), 'utf-8')
  return { saved: true, savedAt: snapshot.savedAt }
}

/** Snapshot selection rule used by the Analyze key-heatmap tab.
 * `[fromMs, toMs)` is half-open to match `RangeMs` and the chart
 * minute-bucket queries — a snapshot saved at exactly `toMs` belongs
 * to the next window, not the current one.
 *   1. If one or more snapshots fall inside `[fromMs, toMs)`, take
 *      the newest (max savedAt).
 *   2. Otherwise, take the most recent snapshot whose savedAt <=
 *      fromMs (the layout that was active when the window opened).
 *   3. Otherwise return `null` — no snapshot ever covered this range.
 */
export async function getKeymapSnapshotForRange(
  userDataDir: string,
  uid: string,
  machineHash: string,
  fromMs: number,
  toMs: number,
): Promise<TypingKeymapSnapshot | null> {
  const saveds = await listSavedAts(userDataDir, uid, machineHash)
  if (saveds.length === 0) return null
  const inRange = saveds.filter((s) => s >= fromMs && s < toMs)
  let pick: number | null = null
  if (inRange.length > 0) {
    pick = inRange[inRange.length - 1]
  } else {
    const before = saveds.filter((s) => s <= fromMs)
    if (before.length > 0) pick = before[before.length - 1]
  }
  if (pick === null) return null
  return readSnapshotFile(join(snapshotDir(userDataDir, uid, machineHash), `${pick}.json`))
}

/** Metadata-only listing for the Analyze snapshot timeline. Walks
 * every `<savedAt>.json` in the (uid, machineHash) directory,
 * strips the heavy `keymap` / `layout` payloads, and returns the
 * remaining fields sorted ascending by `savedAt`. Files that fail to
 * parse are skipped silently — the timeline only shows what is
 * currently readable. */
export async function listKeymapSnapshotSummaries(
  userDataDir: string,
  uid: string,
  machineHash: string,
): Promise<TypingKeymapSnapshotSummary[]> {
  const dir = snapshotDir(userDataDir, uid, machineHash)
  const saveds = await listSavedAts(userDataDir, uid, machineHash)
  // Read files in parallel — a user with a history of keymap edits can
  // easily accumulate dozens of snapshots; sequential awaits pay a
  // per-file syscall latency that adds up on cold caches.
  const snaps = await Promise.all(
    saveds.map((savedAt) => readSnapshotFile(join(dir, `${savedAt}.json`))),
  )
  const out: TypingKeymapSnapshotSummary[] = []
  for (const snap of snaps) {
    if (!snap) continue
    out.push({
      uid: snap.uid,
      machineHash: snap.machineHash,
      productName: snap.productName,
      savedAt: snap.savedAt,
      layers: snap.layers,
      matrix: snap.matrix,
    })
  }
  return out
}
