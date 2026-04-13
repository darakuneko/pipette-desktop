// SPDX-License-Identifier: GPL-2.0-or-later
// Persistent installation ID used to derive a stable machine hash.
// Stored at userData/local/installation-id outside sync/, so it never leaves
// the device and regenerates when the user deletes their application data.

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const FILE_NAME = 'installation-id'
export const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let cached: string | null = null
let pending: Promise<string> | null = null

function getInstallationIdPath(): string {
  return join(app.getPath('userData'), 'local', FILE_NAME)
}

async function loadOrCreate(): Promise<string> {
  const filePath = getInstallationIdPath()
  try {
    const raw = (await readFile(filePath, 'utf-8')).trim()
    if (INSTALLATION_ID_PATTERN.test(raw)) {
      cached = raw
      return raw
    }
  } catch {
    // Missing or unreadable — regenerate below.
  }

  const fresh = randomUUID()
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${fresh}\n`, 'utf-8')
  cached = fresh
  return fresh
}

/**
 * Return the installation ID, generating a new UUID on first access. Concurrent
 * callers share a single in-flight promise so the fs read and regeneration run
 * exactly once.
 */
export function getInstallationId(): Promise<string> {
  if (cached) return Promise.resolve(cached)
  if (!pending) {
    pending = loadOrCreate().finally(() => {
      pending = null
    })
  }
  return pending
}

export function resetInstallationIdCacheForTests(): void {
  cached = null
  pending = null
}
