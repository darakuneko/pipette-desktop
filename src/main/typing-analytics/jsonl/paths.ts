// SPDX-License-Identifier: GPL-2.0-or-later
// Filesystem path helpers for the typing-analytics JSONL master files.
// All functions take the userData root as the first argument so they
// are trivially testable without Electron: production callers pass
// `app.getPath('userData')`, tests pass a tmpdir.

import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

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
      if (!devEntry.name.endsWith('.jsonl')) continue
      const machineHash = devEntry.name.slice(0, -'.jsonl'.length)
      if (machineHash.length === 0) continue
      refs.push({ uid, machineHash, path: join(devicesDir(userDataDir, uid), devEntry.name) })
    }
  }
  return refs
}
