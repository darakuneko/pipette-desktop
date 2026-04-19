// SPDX-License-Identifier: GPL-2.0-or-later
// Filesystem path helpers for the typing-analytics JSONL master files.
// All functions take the userData root as the first argument so they
// are trivially testable without Electron: production callers pass
// `app.getPath('userData')`, tests pass a tmpdir.

import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isUtcDay, type UtcDay } from './utc-day'

const JSONL_EXT = '.jsonl'

/** Returns the directory that contains one subdir per keyboard uid
 * (`userData/sync/keyboards`). Each uid subdir holds a `devices/`
 * directory of per-machine JSONL files. */
export function keyboardsRoot(userDataDir: string): string {
  return join(userDataDir, 'sync', 'keyboards')
}

/** Returns the path to the devices directory for a single keyboard uid
 * (`userData/sync/keyboards/{uid}/devices`). */
export function devicesDir(userDataDir: string, uid: string): string {
  return join(keyboardsRoot(userDataDir), uid, 'devices')
}

/** Returns the path to the per-device JSONL master file for a single
 * (keyboard uid, machineHash) pair. Each device writes only to its own
 * file — the 1-writer invariant follows from this convention. */
export function deviceJsonlPath(
  userDataDir: string,
  uid: string,
  machineHash: string,
): string {
  return join(devicesDir(userDataDir, uid), `${machineHash}.jsonl`)
}

export interface DeviceJsonlRef {
  uid: string
  machineHash: string
  path: string
}

/** Stable identifier for a single JSONL file, used as the read_pointers
 * key in sync-state. Pairs with {@link parseReadPointerKey}. */
export function readPointerKey(uid: string, machineHash: string): string {
  return `${uid}|${machineHash}`
}

export function parseReadPointerKey(key: string): { uid: string; machineHash: string } | null {
  const idx = key.indexOf('|')
  if (idx <= 0 || idx === key.length - 1) return null
  return { uid: key.slice(0, idx), machineHash: key.slice(idx + 1) }
}

async function safeReaddir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Discover every `{userDataDir}/sync/keyboards/{uid}/devices/*.jsonl`
 * file that exists on disk. Used by the cache rebuild path to enumerate
 * every source of truth without relying on sync-state (which can lag
 * behind the filesystem after a fresh Google Drive sync). Unreadable
 * directories are silently treated as empty. Uses `withFileTypes` so
 * each level avoids an extra `stat` per entry. */
export async function listAllDeviceJsonlFiles(
  userDataDir: string,
): Promise<DeviceJsonlRef[]> {
  const refs: DeviceJsonlRef[] = []
  for (const uidEntry of await safeReaddir(keyboardsRoot(userDataDir))) {
    if (!uidEntry.isDirectory()) continue
    const uid = uidEntry.name
    for (const devEntry of await safeReaddir(devicesDir(userDataDir, uid))) {
      if (!devEntry.isFile()) continue
      if (!devEntry.name.endsWith(JSONL_EXT)) continue
      const machineHash = devEntry.name.slice(0, -JSONL_EXT.length)
      if (machineHash.length === 0) continue
      refs.push({ uid, machineHash, path: join(devicesDir(userDataDir, uid), devEntry.name) })
    }
  }
  return refs
}

// --- v7 per-day layout ------------------------------------------------
// Each device owns one directory per keyboard uid, and within it one
// JSONL file per UTC calendar day:
//
//   {userDataDir}/sync/keyboards/{uid}/devices/{machineHash}/{YYYY-MM-DD}.jsonl
//
// The helpers below compose and enumerate that tree. They coexist with
// the v6 flat helpers above until the flush/rebuild paths switch over.

/** Directory that holds one JSONL file per day for a single
 * (keyboard uid, machineHash). */
export function deviceDayDir(
  userDataDir: string,
  uid: string,
  machineHash: string,
): string {
  return join(devicesDir(userDataDir, uid), machineHash)
}

/** Per-day JSONL master file for a single
 * (keyboard uid, machineHash, UTC day). */
export function deviceDayJsonlPath(
  userDataDir: string,
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): string {
  return join(deviceDayDir(userDataDir, uid, machineHash), `${utcDay}${JSONL_EXT}`)
}

export interface DeviceDayJsonlRef {
  uid: string
  machineHash: string
  utcDay: UtcDay
  path: string
}

function parseDayFilename(name: string): UtcDay | null {
  if (!name.endsWith(JSONL_EXT)) return null
  const day = name.slice(0, -JSONL_EXT.length)
  return isUtcDay(day) ? day : null
}

/** UTC days for which a JSONL file currently exists under
 * `{hash}/`, returned in ascending lexicographic order (which equals
 * chronological order for `YYYY-MM-DD`). Invalid filenames and
 * non-`jsonl` entries are ignored. Missing directory ⇒ empty list. */
export async function listDeviceDays(
  userDataDir: string,
  uid: string,
  machineHash: string,
): Promise<UtcDay[]> {
  const days: UtcDay[] = []
  for (const entry of await safeReaddir(deviceDayDir(userDataDir, uid, machineHash))) {
    if (!entry.isFile()) continue
    const day = parseDayFilename(entry.name)
    if (day !== null) days.push(day)
  }
  return days.sort()
}

/** Discover every
 * `{userDataDir}/sync/keyboards/{uid}/devices/{hash}/{YYYY-MM-DD}.jsonl`
 * file on disk. v6 flat files (`{hash}.jsonl` directly under
 * `devices/`) are ignored. Each returned ref is sorted by
 * `(uid, machineHash, utcDay)` ascending, which lets the cache-rebuild
 * path replay days chronologically per device. */
export async function listAllDeviceDayJsonlFiles(
  userDataDir: string,
): Promise<DeviceDayJsonlRef[]> {
  const refs: DeviceDayJsonlRef[] = []
  for (const uidEntry of await safeReaddir(keyboardsRoot(userDataDir))) {
    if (!uidEntry.isDirectory()) continue
    const uid = uidEntry.name
    for (const hashEntry of await safeReaddir(devicesDir(userDataDir, uid))) {
      if (!hashEntry.isDirectory()) continue
      const machineHash = hashEntry.name
      const dayDir = deviceDayDir(userDataDir, uid, machineHash)
      for (const dayEntry of await safeReaddir(dayDir)) {
        if (!dayEntry.isFile()) continue
        const day = parseDayFilename(dayEntry.name)
        if (day === null) continue
        refs.push({ uid, machineHash, utcDay: day, path: join(dayDir, dayEntry.name) })
      }
    }
  }
  refs.sort((a, b) => {
    if (a.uid !== b.uid) return a.uid < b.uid ? -1 : 1
    if (a.machineHash !== b.machineHash) return a.machineHash < b.machineHash ? -1 : 1
    return a.utcDay < b.utcDay ? -1 : a.utcDay > b.utcDay ? 1 : 0
  })
  return refs
}
