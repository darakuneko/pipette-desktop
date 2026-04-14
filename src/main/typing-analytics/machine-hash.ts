// SPDX-License-Identifier: GPL-2.0-or-later
// Derive a stable anonymized machine hash from node-machine-id and the
// persistent installation-id. The raw node-machine-id is never persisted;
// only the sha256 of the concatenation is returned.

import { createHash } from 'node:crypto'
import { machineId } from 'node-machine-id'
import { getInstallationId } from './installation-id'

let cached: string | null = null
let pending: Promise<string> | null = null

async function computeHash(): Promise<string> {
  const [installationId, nodeMachineId] = await Promise.all([
    getInstallationId(),
    machineId(true),
  ])
  const hash = createHash('sha256')
    .update(nodeMachineId)
    .update(installationId)
    .digest('hex')
  cached = hash
  return hash
}

/**
 * Return the anonymized machine hash. Concurrent callers share a single
 * in-flight promise. A failed resolution clears the pending state so the
 * next call can retry.
 */
export function getMachineHash(): Promise<string> {
  if (cached) return Promise.resolve(cached)
  if (!pending) {
    pending = computeHash().finally(() => {
      pending = null
    })
  }
  return pending
}

export function resetMachineHashCacheForTests(): void {
  cached = null
  pending = null
}
