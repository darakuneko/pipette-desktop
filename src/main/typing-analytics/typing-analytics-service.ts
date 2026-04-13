// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics service — foundation only; aggregation, rotation, archive,
// and flush are layered on in later PRs as defined in .claude/plans/typing-analytics.md.

import { getInstallationId } from './installation-id'

let initialization: Promise<void> | null = null

async function initialize(): Promise<void> {
  await getInstallationId()
}

/**
 * Initialize the typing analytics service. Concurrent callers share the same
 * in-flight promise, and a failed initialization clears the cached promise so
 * the next call can retry.
 */
export function setupTypingAnalytics(): Promise<void> {
  if (!initialization) {
    initialization = initialize().catch((err) => {
      initialization = null
      throw err
    })
  }
  return initialization
}

export function resetTypingAnalyticsForTests(): void {
  initialization = null
}
