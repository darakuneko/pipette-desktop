// SPDX-License-Identifier: GPL-2.0-or-later
// Handler scenarios of the favorite posts (hub-ipc-favorite.ts and the
// private favorite upload of hub-ipc-private.ts): the checks in their
// order, the reading of the favorite store and the export JSON the
// multipart carries.

import { ok, tokenRule, type Scenario } from '../handler-scenario'
import type { Tree } from '../../sync-fixtures/harness'

const DIR = 'sync/favorites/tapDance'
const json = (value: unknown): string => JSON.stringify(value, null, 2)

const entry = (id: string, filename: string, over: Record<string, unknown> = {}) => ({
  id,
  label: `Label ${id} "é"`,
  filename,
  savedAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

const TAP_DANCE = { onTap: 4, onHold: 0x0102, onDoubleTap: 0x5100, onTapHold: 0, tappingTerm: 200 }

/** A tap-dance favorite store with entries for each check. */
const TREE: Tree = {
  [`${DIR}/index.json`]: json({
    type: 'tapDance',
    entries: [
      entry('td-1', 'tapDance_1.json'),
      entry('td-deleted', 'tapDance_2.json', { deletedAt: '2026-10-02T00:00:00.000Z' }),
      entry('td-badname', '../escape.json'),
      entry('td-empty', 'tapDance_empty.json'),
      entry('td-mismatch', 'tapDance_macro.json'),
    ],
  }),
  [`${DIR}/tapDance_1.json`]: json({ type: 'tapDance', data: TAP_DANCE }),
  [`${DIR}/tapDance_2.json`]: json({ type: 'tapDance', data: TAP_DANCE }),
  [`${DIR}/tapDance_empty.json`]: json({ type: 'tapDance', data: null }),
  [`${DIR}/tapDance_macro.json`]: json({ type: 'macro', data: [] }),
}

const POST = { id: 'post-1', title: 'TD' }
const PRIVATE = { id: 'priv-1', token: 'tok-1', url: '/p/priv-1?token=tok-1', expires_at: '2026-11-15T00:00:00.000Z' }
const params = (over: Record<string, unknown> = {}) => ({ type: 'tapDance', entryId: 'td-1', title: ' TD ', vialProtocol: 6, ...over })

export const FAVORITE_SCENARIOS: Scenario[] = [
  {
    name: 'upload, update and upload privately a tap-dance favorite',
    tree: TREE,
    rules: [
      tokenRule(1),
      { method: 'POST', path: '/api/files', responses: [ok(POST)] },
      { method: 'PUT', path: '/api/files/post-1', responses: [ok(POST)] },
      { method: 'POST', path: '/api/private/files', responses: [ok(PRIVATE)] },
    ],
    steps: [
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params()] },
      { call: 'HUB_UPDATE_FAVORITE_POST', args: [{ ...params({ vialProtocol: 5 }), postId: 'post-1' }] },
      { call: 'HUB_UPLOAD_PRIVATE_FAVORITE_POST', args: [{ ...params(), expiresInDays: 30 }] },
    ],
  },
  {
    name: 'the checks of a favorite post, in order',
    tree: TREE,
    rules: [],
    steps: [
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ type: 'nope', vialProtocol: -1, title: '' })] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ vialProtocol: -1, title: '' })] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ vialProtocol: 1.5 })] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ vialProtocol: '6' })] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ title: '  ', entryId: 'nope' })] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ entryId: 'nope' })] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ entryId: 'td-deleted' })] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ entryId: 'td-badname' })] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ entryId: 'td-empty' })] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ entryId: 'td-mismatch' })] },
      { call: 'HUB_UPDATE_FAVORITE_POST', args: [{ ...params({ type: 'nope' }), postId: 'bad id' }] },
      { call: 'HUB_UPDATE_FAVORITE_POST', args: [{ ...params({ type: 'nope' }), postId: 'post-1' }] },
      { call: 'HUB_UPLOAD_PRIVATE_FAVORITE_POST', args: [{ ...params({ entryId: 'nope' }), expiresInDays: 7 }] },
    ],
  },
]
