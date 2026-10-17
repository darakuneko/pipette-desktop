// SPDX-License-Identifier: GPL-2.0-or-later
// Handler scenarios of the language pack and theme pack Hub tabs
// (hub-ipc-packs.ts): upload with the uploader filled in from the list by
// name, update with `updated_at` from the timestamps, delete with the
// local link cleared, the list's parameters, the download's validation and
// the timestamps in chunks of 100.

import { ok, tokenRule, type Scenario } from '../handler-scenario'
import type { HubRule } from '../hub-harness'
import { savePack as saveI18nPack } from '../../../src/main/i18n-pack-store'
import { savePack as saveThemePack } from '../../../src/main/theme-pack-store'
import { THEME_COLOR_KEYS } from '../../../src/shared/types/theme-store'

const JA = { name: 'Japanese', version: '1.2.0', common: { save: '保存', cancel: 'キャンセル' }, z: 'last', a: 'first' }
const NORD = {
  name: 'Nord',
  version: '1.0.0',
  colorScheme: 'dark',
  colors: Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, '#2e3440'])),
}

const POST = { id: 'hub-ja', title: 'Japanese' }
const summary = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  version: '1.2.0',
  uploaded_by: 'u-1',
  uploader_name: 'Uploader',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-05T00:00:00.000Z',
  ...over,
})
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, per_page: 20 })

const rule = (method: string, path: string, responses: HubRule['responses'], query?: string): HubRule => ({ method, path, responses, ...(query === undefined ? {} : { query }) })

async function seedI18n(): Promise<void> {
  await saveI18nPack({ id: 'pack-ja', pack: JA })
  await saveI18nPack({ id: 'pack-linked', pack: { ...JA, name: 'Linked' }, hubPostId: 'hub-linked', hubUpdatedAt: '2026-10-01T00:00:00.000Z', uploaderName: 'Me' })
}

async function seedTheme(): Promise<void> {
  await saveThemePack({ id: 'theme-nord', raw: NORD })
  await saveThemePack({ id: 'theme-linked', raw: { ...NORD, name: 'Linked' }, hubPostId: 'hub-linked', hubUpdatedAt: '2026-10-01T00:00:00.000Z' })
}

/** 205 ids with duplicates: three chunks of at most 100 unique ids. */
const MANY_IDS = [...Array.from({ length: 203 }, (_, i) => `id-${String(i).padStart(3, '0')}`), 'id-000', 'id-202']
const timestampsOf = (ids: string[]) => ({ items: ids.filter((id) => !id.endsWith('7')).map((id) => ({ id, updated_at: `2026-10-0${id.length % 9}T00:00:00.000Z` })) })
/** The chunks the handler sends, each answered with the ids not ending in 7. */
function chunkRules(path: string): HubRule[] {
  const unique = [...new Set(MANY_IDS)]
  // A rule per chunk, matched by its body: the chunks go out together.
  return [0, 100, 200].map((start) => {
    const chunk = unique.slice(start, start + 100)
    return { method: 'POST', path, body: { ids: chunk }, responses: [ok(timestampsOf(chunk))] }
  })
}

export const I18N_PACK_SCENARIOS: Scenario[] = [
  {
    name: 'upload a language pack; the uploader comes from the list by name',
    seed: seedI18n,
    rules: [
      tokenRule(1),
      rule('POST', '/api/i18n-packs', [ok(POST), ok({ id: 'hub-ja2', title: 'Japanese' }), ok({ id: 'hub-ja3', title: 'Japanese' })]),
      rule('GET', '/api/i18n-packs', [
        { status: 200, json: { ok: true, data: page([summary('other', 'Japanese'), summary('hub-ja', 'Japanese')]) } },
        { status: 200, json: page([summary('other', 'Japanese')]) },
        { status: 500, text: 'list down' },
      ], 'name=Japanese'),
    ],
    steps: [
      { call: 'HUB_UPLOAD_I18N_POST', args: [{ entryId: 'pack-ja', pack: JA }] },
      { call: 'HUB_UPLOAD_I18N_POST', args: [{ entryId: 'pack-ja', pack: JA }] },
      { call: 'HUB_UPLOAD_I18N_POST', args: [{ entryId: 'pack-ja', pack: JA }] },
    ],
  },
  {
    name: 'a pack without a name looks the uploader up in the unfiltered list',
    seed: seedI18n,
    rules: [
      tokenRule(1),
      rule('POST', '/api/i18n-packs', [ok({ id: 'hub-noname', title: '' }), ok({ id: 'hub-blank', title: '' })]),
      rule('GET', '/api/i18n-packs', [
        ok(page([summary('hub-noname', 'Unnamed', { uploader_name: 'Someone' })])),
        ok(page([summary('other', 'Other'), summary('hub-blank', '   ', { updated_at: '2026-10-06T00:00:00.000Z' })])),
      ], ''),
    ],
    steps: [
      { call: 'HUB_UPLOAD_I18N_POST', args: [{ entryId: 'pack-ja', pack: { version: '1.2.0', common: { save: '保存' } } }] },
      { call: 'HUB_UPLOAD_I18N_POST', args: [{ entryId: 'pack-linked', pack: { ...JA, name: '   ' } }] },
    ],
  },
  {
    name: 'upload and update land on a pack that is not there',
    seed: seedI18n,
    rules: [
      tokenRule(1),
      rule('POST', '/api/i18n-packs', [ok(POST)]),
      rule('GET', '/api/i18n-packs', [ok(page([summary('hub-ja', 'Japanese', { uploader_name: null, updated_at: undefined })]))], 'name=Japanese'),
      rule('PUT', '/api/i18n-packs/hub-ja', [ok(POST)]),
      rule('POST', '/api/i18n-packs/timestamps', [ok({ items: [] })]),
    ],
    steps: [
      { call: 'HUB_UPLOAD_I18N_POST', args: [{ entryId: 'nope', pack: JA }] },
      { call: 'HUB_UPDATE_I18N_POST', args: [{ entryId: 'nope', pack: JA, postId: 'hub-ja' }] },
    ],
  },
  {
    name: 'update a language pack; updated_at comes from the timestamps',
    seed: seedI18n,
    rules: [
      tokenRule(1),
      rule('PUT', '/api/i18n-packs/hub-linked', [ok({ id: 'hub-linked', title: 'Linked' }), ok({ id: 'hub-linked', title: 'Linked' }), { status: 409, text: 'exists' }]),
      rule('POST', '/api/i18n-packs/timestamps', [
        ok({ items: [{ id: 'hub-linked', updated_at: '2026-10-09T00:00:00.000Z' }] }),
        { status: 500, text: 'down' },
      ]),
    ],
    steps: [
      { call: 'HUB_UPDATE_I18N_POST', args: [{ entryId: 'pack-linked', pack: { ...JA, name: 'Linked' }, postId: 'hub-linked' }] },
      { call: 'HUB_UPDATE_I18N_POST', args: [{ entryId: 'pack-linked', pack: { ...JA, name: 'Linked' }, postId: 'hub-linked' }] },
      { call: 'HUB_UPDATE_I18N_POST', args: [{ entryId: 'pack-linked', pack: { ...JA, name: 'Linked' }, postId: 'hub-linked' }] },
      { call: 'HUB_UPDATE_I18N_POST', args: [{ entryId: 'pack-linked', pack: JA, postId: 'bad id' }] },
      { call: 'HUB_UPDATE_I18N_POST', args: [null] },
      { call: 'HUB_UPLOAD_I18N_POST', args: ['params'] },
    ],
  },
  {
    name: 'delete a language pack post and unlink the local pack',
    seed: seedI18n,
    rules: [tokenRule(1), rule('DELETE', '/api/i18n-packs/hub-linked', [ok(null), ok(null), { status: 404, text: 'Not Found' }])],
    steps: [
      { call: 'HUB_DELETE_I18N_POST', args: ['hub-linked', 'pack-linked'] },
      { call: 'HUB_DELETE_I18N_POST', args: ['hub-linked', ''] },
      { call: 'HUB_DELETE_I18N_POST', args: ['hub-linked', 'pack-ja'] },
      { call: 'HUB_DELETE_I18N_POST', args: [5, 'pack-ja'] },
      { call: 'HUB_DELETE_I18N_POST', args: ['a/b', 'pack-ja'] },
    ],
  },
  {
    name: 'the list takes only parameters of the right type',
    rules: [{ ...rule('GET', '/api/i18n-packs', [ok(page([summary('hub-ja', 'Japanese')]))]), repeat: true }],
    steps: [
      { call: 'HUB_LIST_I18N_POSTS', args: [{ q: ' ja ', name: 5, page: '2', perPage: 50 }] },
      { call: 'HUB_LIST_I18N_POSTS', args: [null] },
      { call: 'HUB_LIST_I18N_POSTS', args: ['x'] },
      { call: 'HUB_LIST_I18N_POSTS', args: [{ q: '', name: '  ', page: 0, perPage: -1 }] },
    ],
  },
  {
    name: 'a downloaded language pack is validated',
    rules: [
      rule('GET', '/api/i18n-packs/hub-ja/download', [
        { status: 200, json: { version: 1, kind: 'i18n', exportedAt: '2026-10-01T00:00:00.000Z', pack: JA } },
        { status: 200, json: { version: 2, kind: 'i18n', exportedAt: 'x', pack: JA } },
        { status: 200, json: { version: 1, kind: 'i18n', exportedAt: 'x', pack: { ...JA, version: 'one' } } },
        { status: 404, text: 'Not Found' },
        { status: 429, text: 'slow', headers: { 'Retry-After': '5' } },
      ]),
    ],
    steps: [
      { call: 'HUB_DOWNLOAD_I18N_POST', args: ['hub-ja'] },
      { call: 'HUB_DOWNLOAD_I18N_POST', args: ['hub-ja'] },
      { call: 'HUB_DOWNLOAD_I18N_POST', args: ['hub-ja'] },
      { call: 'HUB_DOWNLOAD_I18N_POST', args: ['hub-ja'] },
      { call: 'HUB_DOWNLOAD_I18N_POST', args: ['hub-ja'] },
      { call: 'HUB_DOWNLOAD_I18N_POST', args: ['bad id'] },
      { call: 'HUB_DOWNLOAD_I18N_POST', args: [null] },
    ],
  },
  {
    name: 'timestamps go in chunks of 100 and come back in the asked order',
    rules: chunkRules('/api/i18n-packs/timestamps'),
    steps: [
      { call: 'HUB_I18N_PACK_TIMESTAMPS', args: [MANY_IDS] },
      { call: 'HUB_I18N_PACK_TIMESTAMPS', args: [[]] },
      { call: 'HUB_I18N_PACK_TIMESTAMPS', args: [['a', 5]] },
      { call: 'HUB_I18N_PACK_TIMESTAMPS', args: ['a'] },
    ],
    unordered: true,
  },
]

export const THEME_PACK_SCENARIOS: Scenario[] = [
  {
    name: 'upload, update and delete a theme pack post',
    seed: seedTheme,
    rules: [
      tokenRule(1),
      rule('POST', '/api/theme-packs', [ok({ id: 'hub-nord', title: 'Nord' })]),
      rule('GET', '/api/theme-packs', [ok(page([summary('hub-nord', 'Nord')]))], 'name=Nord'),
      rule('PUT', '/api/theme-packs/hub-linked', [ok({ id: 'hub-linked', title: 'Linked' })]),
      rule('POST', '/api/theme-packs/timestamps', [ok({ items: [{ id: 'hub-linked', updated_at: '2026-10-09T00:00:00.000Z' }] })]),
      rule('DELETE', '/api/theme-packs/hub-linked', [ok(null)]),
    ],
    steps: [
      { call: 'HUB_UPLOAD_THEME_POST', args: [{ entryId: 'theme-nord', pack: NORD }] },
      { call: 'HUB_UPDATE_THEME_POST', args: [{ entryId: 'theme-linked', pack: { ...NORD, name: 'Linked' }, postId: 'hub-linked' }] },
      { call: 'HUB_DELETE_THEME_POST', args: ['hub-linked', 'theme-linked'] },
      { call: 'HUB_UPDATE_THEME_POST', args: [{ entryId: 'theme-linked', pack: NORD, postId: '' }] },
      { call: 'HUB_UPLOAD_THEME_POST', args: [undefined] },
    ],
  },
  {
    name: 'a theme pack without a name looks the uploader up in the unfiltered list',
    seed: seedTheme,
    rules: [
      tokenRule(1),
      rule('POST', '/api/theme-packs', [ok({ id: 'hub-noname', title: '' }), ok({ id: 'hub-blank', title: '' })]),
      rule('GET', '/api/theme-packs', [
        ok(page([summary('hub-noname', 'Unnamed', { uploader_name: 'Someone' })])),
        ok(page([summary('hub-blank', '   ', { uploader_name: null })])),
      ], ''),
    ],
    steps: [
      { call: 'HUB_UPLOAD_THEME_POST', args: [{ entryId: 'theme-nord', pack: { version: '1.0.0', colorScheme: 'dark', colors: NORD.colors } }] },
      { call: 'HUB_UPLOAD_THEME_POST', args: [{ entryId: 'theme-linked', pack: { ...NORD, name: '   ' } }] },
    ],
  },
  {
    name: 'a downloaded theme pack is validated; the list and timestamps',
    rules: [
      rule('GET', '/api/theme-packs/hub-nord/download', [ok(NORD), { status: 200, json: NORD }, ok({ ...NORD, colorScheme: 'blue' })]),
      rule('GET', '/api/theme-packs', [ok(page([summary('hub-nord', 'Nord')]))]),
      ...chunkRules('/api/theme-packs/timestamps'),
    ],
    steps: [
      { call: 'HUB_DOWNLOAD_THEME_POST', args: ['hub-nord'] },
      { call: 'HUB_DOWNLOAD_THEME_POST', args: ['hub-nord'] },
      { call: 'HUB_DOWNLOAD_THEME_POST', args: ['hub-nord'] },
      { call: 'HUB_LIST_THEME_POSTS', args: [{ q: 'nord', page: 2 }] },
      { call: 'HUB_THEME_PACK_TIMESTAMPS', args: [MANY_IDS] },
    ],
    unordered: true,
  },
]
