// SPDX-License-Identifier: GPL-2.0-or-later
// Handler scenarios of the keymap posts (hub-ipc-posts.ts) and the
// private (unlisted) posts (hub-ipc-private.ts): the order of the input
// checks, the multipart bodies and the answers.

import { repeat } from '../expand'
import { ok, tokenRule, type Scenario } from '../handler-scenario'
import type { HubRule } from '../hub-harness'

const MB = 1024 * 1024
// (2 MB + 1) and (10 MB + 2) are multiples of 3: 'AAAA' is 3 bytes.

/** A keymap post's parameters; the PDF and the JPEG are not UTF-8. */
const post = (over: Record<string, unknown> = {}) => ({
  title: '  My keymap  ',
  keyboardName: ' My Board/v2 ',
  vilJson: '{"version":1}',
  pipetteJson: '{"name":"キー"}',
  keymapC: 'const uint16_t keymaps[] = {};\n',
  pdfBase64: 'JVBERi0A/w0K',
  thumbnailBase64: '/9j/4C0tDQo=',
  ...over,
})

const POST = { id: 'post-1', title: 'My keymap' }
const PRIVATE = { id: 'priv-1', token: 'tok-1', url: '/p/priv-1?token=tok-1', expires_at: '2026-10-23T00:00:00.000Z' }
const MY_POST = { id: 'post-1', title: 'My keymap', keyboard_name: 'My Board', created_at: '2026-10-01T00:00:00.000Z' }

const rule = (method: string, path: string, responses: HubRule['responses'], repeat = false): HubRule => ({ method, path, responses, repeat })

export const POST_SCENARIOS: Scenario[] = [
  {
    name: 'upload, update, rename and delete a keymap post',
    rules: [
      tokenRule(1),
      rule('POST', '/api/files', [ok(POST)]),
      rule('PUT', '/api/files/post-1', [ok({ id: 'post-1', title: 'Renamed' })]),
      rule('PATCH', '/api/files/post-1', [ok(null)]),
      rule('DELETE', '/api/files/post-1', [ok(null)]),
    ],
    steps: [
      { call: 'HUB_UPLOAD_POST', args: [post()] },
      { call: 'HUB_UPDATE_POST', args: [{ ...post({ title: 'Renamed', keyboardName: 'Board' }), postId: 'post-1' }] },
      { call: 'HUB_PATCH_POST', args: [{ postId: 'post-1', title: ' New title ' }] },
      { call: 'HUB_DELETE_POST', args: ['post-1'] },
    ],
  },
  {
    name: 'a 401 sends the same multipart body again with the new token',
    rules: [tokenRule(2), rule('POST', '/api/files', [{ status: 401, text: 'expired' }, ok(POST)])],
    steps: [{ call: 'HUB_UPLOAD_POST', args: [post()] }],
  },
  {
    name: 'the checks come before any request, in order',
    rules: [],
    steps: [
      { call: 'HUB_UPLOAD_POST', args: [post({ title: '   ' })] },
      { call: 'HUB_UPLOAD_POST', args: [post({ title: 'x'.repeat(201) })] },
      { call: 'HUB_UPLOAD_POST', args: [post({ title: 5 })] },
      { call: 'HUB_UPLOAD_POST', args: [post({ thumbnailBase64: repeat('AAAA', (2 * MB + 1) / 3) })] },
      { call: 'HUB_UPLOAD_POST', args: [post({ pdfBase64: repeat('AAAA', (10 * MB + 2) / 3), vilJson: repeat('x', 10 * MB + 1) })] },
      { call: 'HUB_UPDATE_POST', args: [{ ...post({ title: '' }), postId: 'bad id' }] },
      { call: 'HUB_UPDATE_POST', args: [{ ...post({ title: '' }), postId: 'post-1' }] },
      { call: 'HUB_UPDATE_POST', args: [{ ...post({ thumbnailBase64: repeat('AAAA', (2 * MB + 1) / 3) }), postId: '' }] },
      { call: 'HUB_PATCH_POST', args: [{ postId: 'a/b', title: '' }] },
      { call: 'HUB_PATCH_POST', args: [{ postId: 'post-1', title: '' }] },
      { call: 'HUB_DELETE_POST', args: [''] },
      { call: 'HUB_DELETE_POST', args: ['../x'] },
      { call: 'HUB_FETCH_MY_KEYBOARD_POSTS', args: ['   '] },
      { call: 'HUB_FETCH_MY_KEYBOARD_POSTS', args: ['x'.repeat(101)] },
      { call: 'HUB_FETCH_MY_KEYBOARD_POSTS', args: [7] },
    ],
  },
  {
    name: 'my posts: paging is clamped and total pages are counted',
    rules: [
      tokenRule(1),
      rule('GET', '/api/files/me', [
        ok({ items: [MY_POST], total: 41, page: 1, per_page: 20 }),
        ok({ items: [], total: 0, page: 1, per_page: 100 }),
        ok({ items: [], total: 5, page: 3, per_page: 0 }),
        ok({ items: [], total: null, page: 2, per_page: 10 }),
      ]),
    ],
    steps: [
      { call: 'HUB_FETCH_MY_POSTS', args: [] },
      { call: 'HUB_FETCH_MY_POSTS', args: [{ page: 0, per_page: 500 }] },
      { call: 'HUB_FETCH_MY_POSTS', args: [{ page: 2.7, per_page: 0.5 }] },
      { call: 'HUB_FETCH_MY_POSTS', args: [{ page: -3, per_page: 10 }] },
    ],
  },
  {
    name: 'my posts of one keyboard',
    rules: [tokenRule(1), rule('GET', '/api/files/me/keyboard', [ok([MY_POST]), { status: 500, text: 'x' }])],
    steps: [
      { call: 'HUB_FETCH_MY_KEYBOARD_POSTS', args: ['  My Board & Co  '] },
      { call: 'HUB_FETCH_MY_KEYBOARD_POSTS', args: ['My Board'] },
    ],
  },
  {
    name: 'the answers of a failed post request',
    rules: [
      tokenRule(1),
      rule('POST', '/api/files', [
        { status: 413, text: 'Payload Too Large' },
        { status: 200, json: { ok: false, error: 'Invalid file' } },
        { status: 429, text: '{"ok":false,"error":"Daily limit"}', headers: { 'Retry-After': '3600' } },
        { status: 403, text: 'banned' },
      ]),
      rule('DELETE', '/api/files/post-1', [{ status: 404, text: 'Not Found' }]),
    ],
    steps: [
      { call: 'HUB_UPLOAD_POST', args: [post()] },
      { call: 'HUB_UPLOAD_POST', args: [post()] },
      { call: 'HUB_UPLOAD_POST', args: [post()] },
      { call: 'HUB_UPLOAD_POST', args: [post()] },
      { call: 'HUB_DELETE_POST', args: ['post-1'] },
    ],
  },
]

export const PRIVATE_SCENARIOS: Scenario[] = [
  {
    name: 'upload a private keymap post with and without an expiry',
    rules: [tokenRule(1), rule('POST', '/api/private/files', [ok(PRIVATE), ok({ ...PRIVATE, expires_at: null })])],
    steps: [
      { call: 'HUB_UPLOAD_PRIVATE_POST', args: [{ ...post(), expiresInDays: 7 }] },
      { call: 'HUB_UPLOAD_PRIVATE_POST', args: [{ ...post(), expiresInDays: null }] },
      { call: 'HUB_UPLOAD_PRIVATE_POST', args: [{ ...post({ title: '' }), expiresInDays: 7 }] },
    ],
  },
  {
    name: 'delete a private post; gone already counts as deleted',
    rules: [
      tokenRule(1),
      rule('DELETE', '/api/private/files/priv-1', [ok(null), { status: 404, text: 'Not Found' }, { status: 500, text: 'boom' }]),
      rule('DELETE', '/api/private/other/x%20y', [ok(null)]),
    ],
    steps: [
      { call: 'HUB_DELETE_PRIVATE_POST', args: ['files', 'priv-1'] },
      { call: 'HUB_DELETE_PRIVATE_POST', args: ['files', 'priv-1'] },
      { call: 'HUB_DELETE_PRIVATE_POST', args: ['files', 'priv-1'] },
      { call: 'HUB_DELETE_PRIVATE_POST', args: ['other', 'x y'] },
      { call: 'HUB_DELETE_PRIVATE_POST', args: ['files', ''] },
      { call: 'HUB_DELETE_PRIVATE_POST', args: ['files', 5] },
    ],
  },
]
