// SPDX-License-Identifier: GPL-2.0-or-later
// Handler scenarios of the Key Labels Hub (hub-ipc-key-labels.ts): list,
// detail, timestamps, download (the Hub id becomes the local id), upload
// (409 is a duplicate name), update, sync (keeps the local name) and
// delete, with the store's answers on missing entries.

import { ok, tokenRule, type Scenario } from '../handler-scenario'
import type { HubRule } from '../hub-harness'
import { saveRecord } from '../../../src/main/key-label-store'

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'Eucalyn',
  map: { KC_A: 'A', KC_B: 'ビー' },
  composite_labels: null,
  keymap_applicable: false,
  uploaded_by: 'u-1',
  uploader_name: 'Uploader',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-05T00:00:00.000Z',
  ...over,
})

const rule = (method: string, path: string, responses: HubRule['responses'], extra: Partial<HubRule> = {}): HubRule => ({ method, path, responses, ...extra })

async function seed(): Promise<void> {
  await saveRecord({ id: 'kl-local', name: 'Local', map: { KC_A: 'あ' } })
  await saveRecord({
    id: 'kl-linked',
    name: 'Linked',
    map: { KC_A: 'A' },
    compositeLabels: { 'LSFT(KC_1)': '!' },
    keymapApplicable: true,
    hubPostId: 'hub-linked',
    uploaderName: 'Me',
    hubUpdatedAt: '2026-10-01T00:00:00.000Z',
  })
}

export const KEY_LABEL_SCENARIOS: Scenario[] = [
  {
    name: 'list, detail and timestamps',
    rules: [
      rule('GET', '/api/key-labels', [ok({ items: [item('kl-1')], total: 1, page: 1, per_page: 20 })], { repeat: true }),
      rule('GET', '/api/key-labels/kl-1', [ok(item('kl-1')), { status: 404, text: 'Not Found' }]),
      rule('POST', '/api/key-labels/timestamps', [ok({ items: [{ id: 'kl-2', updated_at: 'b' }, { id: 'kl-1', updated_at: 'a' }] }), { status: 400, text: 'too many' }]),
    ],
    steps: [
      { call: 'KEY_LABEL_HUB_LIST', args: [] },
      { call: 'KEY_LABEL_HUB_LIST', args: [{ q: '  euc ', page: 0, perPage: 500 }] },
      { call: 'KEY_LABEL_HUB_LIST', args: [{ q: '', page: 2.5, perPage: 0 }] },
      { call: 'KEY_LABEL_HUB_DETAIL', args: ['kl-1'] },
      { call: 'KEY_LABEL_HUB_DETAIL', args: ['kl-1'] },
      { call: 'KEY_LABEL_HUB_DETAIL', args: ['bad id'] },
      { call: 'KEY_LABEL_HUB_TIMESTAMPS', args: [['kl-1', 'kl-2', 'kl-1', 'kl-3']] },
      { call: 'KEY_LABEL_HUB_TIMESTAMPS', args: [['kl-1']] },
      { call: 'KEY_LABEL_HUB_TIMESTAMPS', args: [[]] },
      { call: 'KEY_LABEL_HUB_TIMESTAMPS', args: [['ok', 'bad id']] },
      { call: 'KEY_LABEL_HUB_TIMESTAMPS', args: ['kl-1'] },
    ],
  },
  {
    name: 'a list that fails is an IO error',
    rules: [rule('GET', '/api/key-labels', [{ status: 503, text: 'down' }, { status: 200, json: { ok: false, error: 'bad query' } }])],
    steps: [
      { call: 'KEY_LABEL_HUB_LIST', args: [{ q: 'x' }] },
      { call: 'KEY_LABEL_HUB_LIST', args: [{ q: 'x' }] },
    ],
  },
  {
    name: 'download keeps the Hub id as the local id; the detail is best-effort',
    seed,
    rules: [
      rule('GET', '/api/key-labels/hub-1/download', [{ status: 200, json: { name: 'Eucalyn', map: { KC_A: 'A' }, composite_labels: { 'LSFT(KC_2)': '@' }, keymap_applicable: true } }]),
      rule('GET', '/api/key-labels/hub-1', [ok(item('hub-1'))]),
      rule('GET', '/api/key-labels/hub-2/download', [{ status: 200, json: { name: 'Onishi', map: { KC_A: 'O' }, composite_labels: null } }]),
      rule('GET', '/api/key-labels/hub-2', [{ status: 404, text: 'Not Found' }]),
      rule('GET', '/api/key-labels/hub-3/download', [{ status: 404, text: 'Not Found' }]),
    ],
    steps: [
      { call: 'KEY_LABEL_HUB_DOWNLOAD', args: ['hub-1'] },
      { call: 'KEY_LABEL_HUB_DOWNLOAD', args: ['hub-2'] },
      { call: 'KEY_LABEL_HUB_DOWNLOAD', args: ['hub-3'] },
      { call: 'KEY_LABEL_HUB_DOWNLOAD', args: ['a/b'] },
    ],
  },
  {
    name: 'upload sets the Hub id and uploader; a 409 is a duplicate name',
    seed,
    rules: [
      tokenRule(1),
      rule('POST', '/api/key-labels', [ok(item('hub-new', { name: 'Local', uploader_name: 'Me' })), { status: 409, text: 'exists' }, { status: 500, text: 'boom' }]),
    ],
    steps: [
      { call: 'KEY_LABEL_HUB_UPLOAD', args: ['kl-local'] },
      { call: 'KEY_LABEL_HUB_UPLOAD', args: ['kl-linked'] },
      { call: 'KEY_LABEL_HUB_UPLOAD', args: ['kl-linked'] },
      { call: 'KEY_LABEL_HUB_UPLOAD', args: ['nope'] },
      { call: 'KEY_LABEL_HUB_UPLOAD', args: [5] },
    ],
  },
  {
    name: 'update keeps the uploader and takes updated_at',
    seed,
    rules: [
      tokenRule(1),
      rule('PUT', '/api/key-labels/hub-linked', [ok(item('hub-linked', { name: 'Linked', uploader_name: 'Someone', updated_at: '2026-10-09T00:00:00.000Z' })), { status: 409, text: 'exists' }]),
    ],
    steps: [
      { call: 'KEY_LABEL_HUB_UPDATE', args: ['kl-linked'] },
      { call: 'KEY_LABEL_HUB_UPDATE', args: ['kl-linked'] },
      { call: 'KEY_LABEL_HUB_UPDATE', args: ['kl-local'] },
      { call: 'KEY_LABEL_HUB_UPDATE', args: ['nope'] },
      { call: 'KEY_LABEL_HUB_UPDATE', args: [null] },
    ],
  },
  {
    name: 'sync refreshes the payload and keeps the local name',
    seed,
    rules: [
      rule('GET', '/api/key-labels/hub-linked/download', [
        { status: 200, json: { name: 'Renamed on Hub', map: { KC_Z: 'Z' }, composite_labels: null, keymap_applicable: false } },
        { status: 200, json: { name: 'Again', map: { KC_Y: 'Y' }, composite_labels: { 'LSFT(KC_3)': '#' } } },
        { status: 500, text: 'down' },
      ]),
      rule('GET', '/api/key-labels/hub-linked', [ok(item('hub-linked', { uploader_name: null, updated_at: '2026-10-10T00:00:00.000Z' })), { status: 500, text: 'down' }]),
    ],
    steps: [
      { call: 'KEY_LABEL_HUB_SYNC', args: ['kl-linked'] },
      { call: 'KEY_LABEL_HUB_SYNC', args: ['kl-linked'] },
      { call: 'KEY_LABEL_HUB_SYNC', args: ['kl-linked'] },
      { call: 'KEY_LABEL_HUB_SYNC', args: ['kl-local'] },
      { call: 'KEY_LABEL_HUB_SYNC', args: ['nope'] },
    ],
  },
  {
    name: 'delete clears the Hub id',
    seed,
    rules: [tokenRule(1), rule('DELETE', '/api/key-labels/hub-linked', [{ status: 500, text: 'boom' }, ok(null)])],
    steps: [
      { call: 'KEY_LABEL_HUB_DELETE', args: ['kl-linked'] },
      { call: 'KEY_LABEL_HUB_DELETE', args: ['kl-linked'] },
      { call: 'KEY_LABEL_HUB_DELETE', args: ['kl-linked'] },
      { call: 'KEY_LABEL_HUB_DELETE', args: ['nope'] },
      { call: 'KEY_LABEL_HUB_DELETE', args: [{}] },
    ],
  },
]
