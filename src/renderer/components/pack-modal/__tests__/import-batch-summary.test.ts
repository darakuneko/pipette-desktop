// SPDX-License-Identifier: GPL-2.0-or-later
//
// Direct coverage for the two-header failure banner: `notSavedFailures`
// (files that never landed on disk) must never be reported under the
// same header as `hubSyncFailures` (files that DID save, but whose push
// to an already-linked Hub post failed) — see the module doc in
// import-batch-summary.ts for why that distinction matters.

import { describe, it, expect } from 'vitest'
import type { TFunction } from 'i18next'
import { buildImportBatchFailureSummary, type ImportBatchFailure } from '../import-batch-summary'

const t = ((key: string, params?: Record<string, unknown>) => (
  params ? `${key}:${String(params.count)}` : key
)) as unknown as TFunction

describe('buildImportBatchFailureSummary', () => {
  it('returns null when both failure lists are empty', () => {
    expect(buildImportBatchFailureSummary(t, [], [])).toBeNull()
  })

  it('renders only the not-saved header and lines when there are no hub-sync failures', () => {
    const notSaved: ImportBatchFailure[] = [{ fileName: 'bad.json', reason: 'parse error' }]
    const summary = buildImportBatchFailureSummary(t, notSaved, [])
    expect(summary).toBe('common.importBatchFailed:1\nbad.json: parse error')
    expect(summary).not.toContain('importBatchHubSyncFailed')
  })

  it('renders only the hub-sync header and lines when every file saved but sync failed', () => {
    const hubSync: ImportBatchFailure[] = [{ fileName: 'good.json', reason: 'network down' }]
    const summary = buildImportBatchFailureSummary(t, [], hubSync)
    expect(summary).toBe('common.importBatchHubSyncFailed:1\ngood.json: network down')
    // The saved-but-not-synced case must never claim the file "could not
    // be imported" — that header belongs only to notSavedFailures.
    expect(summary).not.toContain('importBatchFailed:')
  })

  it('renders both blocks, not-saved first then hub-sync, separated by a blank line', () => {
    const notSaved: ImportBatchFailure[] = [{ fileName: 'bad.json', reason: 'parse error' }]
    const hubSync: ImportBatchFailure[] = [{ fileName: 'good.json', reason: 'network down' }]
    const summary = buildImportBatchFailureSummary(t, notSaved, hubSync)
    expect(summary).toBe(
      'common.importBatchFailed:1\nbad.json: parse error\n\ncommon.importBatchHubSyncFailed:1\ngood.json: network down',
    )
  })
})
