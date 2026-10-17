// SPDX-License-Identifier: GPL-2.0-or-later
// Scenarios of the startup auto-update of Hub-linked language packs
// (i18n-startup-sync.ts): which packs are checked, skipped, downloaded,
// missing on the Hub or rejected, the log lines and the change broadcast.
// The downloads run in parallel, so the requests are written sorted.

import { ok, type Scenario } from '../handler-scenario'
import { savePack } from '../../../src/main/i18n-pack-store'

const pack = (name: string, extra: Record<string, unknown> = {}) => ({ name, version: '1.0.0', common: { save: name }, ...extra })
const exportOf = (body: unknown) => ({ version: 1, kind: 'i18n', exportedAt: '2026-10-10T00:00:00.000Z', pack: body })

async function seed(): Promise<void> {
  await savePack({ id: 'pack-same', pack: pack('Same'), hubPostId: 'hub-same', hubUpdatedAt: '2026-10-01T00:00:00.000Z' })
  await savePack({ id: 'pack-old', pack: pack('Old'), hubPostId: 'hub-old', hubUpdatedAt: '2026-10-01T00:00:00.000Z', enabled: false })
  await savePack({ id: 'pack-gone', pack: pack('Gone'), hubPostId: 'hub-gone', hubUpdatedAt: '2026-10-01T00:00:00.000Z' })
  await savePack({ id: 'pack-never', pack: pack('Never'), hubPostId: 'hub-never' })
  await savePack({ id: 'pack-bad', pack: pack('Bad'), hubPostId: 'hub-bad' })
  await savePack({ id: 'pack-local', pack: pack('Local') })
}

const TIMESTAMPS_BODY = { ids: ['hub-same', 'hub-old', 'hub-gone', 'hub-never', 'hub-bad'] }

export const STARTUP_SYNC_SCENARIOS: Scenario[] = [
  {
    name: 'only packs with newer Hub content are downloaded',
    seed,
    rules: [
      {
        method: 'POST',
        path: '/api/i18n-packs/timestamps',
        body: TIMESTAMPS_BODY,
        responses: [
          ok({
            items: [
              { id: 'hub-same', updated_at: '2026-10-01T00:00:00.000Z' },
              { id: 'hub-old', updated_at: '2026-10-08T00:00:00.000Z' },
              { id: 'hub-never', updated_at: '2026-10-09T00:00:00.000Z' },
              { id: 'hub-bad', updated_at: '2026-10-09T00:00:00.000Z' },
            ],
          }),
        ],
      },
      // Renamed on the Hub: the unattended save keeps the local name.
      { method: 'GET', path: '/api/i18n-packs/hub-old/download', responses: [{ status: 200, json: exportOf(pack('Old renamed', { extra: { key: 'v' } })) }] },
      { method: 'GET', path: '/api/i18n-packs/hub-never/download', responses: [{ status: 200, json: exportOf(pack('Never')) }] },
      { method: 'GET', path: '/api/i18n-packs/hub-bad/download', responses: [{ status: 200, json: exportOf(pack('Bad', { version: 'nope' })) }] },
    ],
    steps: [{ startupSync: true }],
    unordered: true,
  },
  {
    name: 'a failed download is counted and the rest go on',
    seed,
    rules: [
      {
        method: 'POST',
        path: '/api/i18n-packs/timestamps',
        responses: [ok({ items: [{ id: 'hub-old', updated_at: '2026-10-08T00:00:00.000Z' }, { id: 'hub-never', updated_at: 'x' }] })],
      },
      { method: 'GET', path: '/api/i18n-packs/hub-old/download', responses: [{ status: 500, text: 'down' }] },
      { method: 'GET', path: '/api/i18n-packs/hub-never/download', responses: [{ status: 429, text: 'slow', headers: { 'Retry-After': '1' } }] },
    ],
    steps: [{ startupSync: true }],
    unordered: true,
  },
  {
    name: 'a failed timestamps request ends the pass',
    seed,
    rules: [{ method: 'POST', path: '/api/i18n-packs/timestamps', responses: [{ status: 503, text: 'down' }] }],
    steps: [{ startupSync: true }],
  },
  {
    name: 'no Hub-linked pack sends nothing',
    seed: async () => {
      await savePack({ id: 'pack-local', pack: pack('Local') })
      await savePack({ id: 'pack-blank', pack: pack('Blank'), hubPostId: '   ' })
    },
    rules: [],
    steps: [{ startupSync: true }],
  },
]
