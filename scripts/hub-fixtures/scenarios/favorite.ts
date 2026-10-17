// SPDX-License-Identifier: GPL-2.0-or-later
// Handler scenarios of the favorite posts (hub-ipc-favorite.ts and the
// private favorite upload of hub-ipc-private.ts): the checks in their
// order, the reading of the favorite store, the export JSON the
// multipart carries for each favorite type at both keycode protocols, and
// the Hub's failures, a renewed token and a short 429 on these uploads.

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

/** One favorite of each other type, with keycodes the export names. The
 *  bodies keep fields in an order of their own, with fields the store
 *  does not know, which the export keeps in place. The alt repeat key
 *  entry has no label and a save time that is not a string. */
const OTHER_TYPES: Tree = {
  'sync/favorites/macro/index.json': json({
    type: 'macro',
    entries: [entry('m-1', 'macro_1.json', { label: 'Macro\nline' })],
  }),
  'sync/favorites/macro/macro_1.json': json({
    type: 'macro',
    data: [['text', 'Hi'], ['tap', 4, 0x0102], ['delay', 100]],
  }),
  'sync/favorites/combo/index.json': json({
    type: 'combo',
    entries: [entry('c-1', 'combo_1.json')],
  }),
  'sync/favorites/combo/combo_1.json': json({
    type: 'combo',
    data: { output: 0x5100, key4: 0, key3: 0x7c16, key2: 5, key1: 4, extra: 'kept' },
  }),
  'sync/favorites/keyOverride/index.json': json({
    type: 'keyOverride',
    entries: [entry('ko-1', 'keyOverride_1.json')],
  }),
  'sync/favorites/keyOverride/keyOverride_1.json': json({
    type: 'keyOverride',
    data: {
      triggerKey: 0x0204, replacementKey: 0x2a, layers: 0xffff, triggerMods: 2,
      negativeMods: 0, suppressedMods: 2, options: 7, enabled: true,
    },
  }),
  'sync/favorites/altRepeatKey/index.json': json({
    type: 'altRepeatKey',
    entries: [{ id: 'ark-1', filename: 'altRepeatKey_1.json', savedAt: 1767225600000 }],
  }),
  'sync/favorites/altRepeatKey/altRepeatKey_1.json': json({
    type: 'altRepeatKey',
    data: { lastKey: 0x50, altKey: 0x4f, allowedMods: 0, options: 1, enabled: false },
  }),
}

const kind = (type: string, entryId: string, over: Record<string, unknown> = {}) =>
  params({ type, entryId, title: `${type} post`, ...over })

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
    name: 'upload each other favorite type, at both protocols',
    tree: OTHER_TYPES,
    rules: [
      tokenRule(1),
      {
        method: 'POST',
        path: '/api/files',
        responses: [ok({ id: 'm-post', title: 'M' }), ok({ id: 'c-post', title: 'C' }), ok({ id: 'ko-post', title: 'KO' })],
      },
      { method: 'PUT', path: '/api/files/c-post', responses: [ok({ id: 'c-post', title: 'C' })] },
      { method: 'POST', path: '/api/private/files', responses: [ok({ ...PRIVATE, id: 'ark-priv', expires_at: null })] },
    ],
    steps: [
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [kind('macro', 'm-1')] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [kind('combo', 'c-1')] },
      { call: 'HUB_UPDATE_FAVORITE_POST', args: [{ ...kind('combo', 'c-1', { vialProtocol: 5 }), postId: 'c-post' }] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [kind('keyOverride', 'ko-1', { vialProtocol: 5 })] },
      { call: 'HUB_UPLOAD_PRIVATE_FAVORITE_POST', args: [{ ...kind('altRepeatKey', 'ark-1'), expiresInDays: null }] },
    ],
  },
  {
    name: 'a favorite post through a renewed token, a short 429 and Hub failures',
    tree: TREE,
    rules: [
      tokenRule(2),
      {
        method: 'POST',
        path: '/api/files',
        responses: [
          { status: 200, json: { ok: false, error: 'Bad post' } },
          { status: 409, text: '{"ok":false,"error":"Duplicate"}' },
          { status: 403, text: '{"ok":false,"error":"Deactivated"}' },
        ],
      },
      {
        method: 'PUT',
        path: '/api/files/post-1',
        responses: [{ status: 401, text: '{"ok":false,"error":"Expired"}' }, ok(POST)],
      },
      {
        method: 'POST',
        path: '/api/private/files',
        responses: [
          { status: 429, text: '{"ok":false,"error":"Slow down"}', headers: { 'Retry-After': '2' } },
          ok(PRIVATE),
        ],
      },
    ],
    steps: [
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params({ title: 'Line\r\nbreak' })] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params()] },
      { call: 'HUB_UPLOAD_FAVORITE_POST', args: [params()] },
      { call: 'HUB_UPDATE_FAVORITE_POST', args: [{ ...params(), postId: 'post-1' }] },
      { call: 'HUB_UPLOAD_PRIVATE_FAVORITE_POST', args: [{ ...params(), expiresInDays: 7 }] },
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
