// SPDX-License-Identifier: GPL-2.0-or-later
// Every Hub API function of the Electron code (hub-client.ts, hub-i18n.ts,
// hub-theme.ts, hub-key-labels.ts) with representative inputs, for the
// request-log generator (record-hub-request-log-fixtures.test.ts).
//
// A call is written to the golden file as its function and its JSON
// arguments; a file argument is `{ name, base64 }` (its bytes). The Rust
// test calls the function of the same name with the same arguments.

import * as client from '../../src/main/hub/hub-client'
import * as i18n from '../../src/main/hub/hub-i18n'
import * as theme from '../../src/main/hub/hub-theme'
import * as keyLabels from '../../src/main/hub/hub-key-labels'
import type { HubI18nPackBody, HubThemePackBody } from '../../src/shared/types/hub'

/** The three ways the Hub client reads an answer: `strict` wants
 *  `{ ok, data, error? }` (hub-client.ts and hub-key-labels.ts
 *  `hubFetch`; only hub-client.ts has a 404 error of its own),
 *  `lenient` unwraps `{ ok }` when it is there (hub-i18n.ts and
 *  hub-theme.ts `hubFetchJson`), `download` reads the body as it is and
 *  never retries. */
export type Reader = 'strict' | 'strict-key-labels' | 'lenient' | 'download'

export interface FileArg {
  name: string
  base64: string
}

export interface ApiCall {
  /** `<module>.<function>` */
  fn: string
  args: unknown[]
  reader: Reader
  method: string
  /** The path the request goes to (without the query). */
  path: string
  /** `data` of the successful answer (sent wrapped in `{ ok, data }`,
   *  bare for `download`). */
  data: unknown
}

type Fn = (...args: never[]) => Promise<unknown>

const FUNCTIONS: Record<string, Fn> = {
  'hub-client.authenticateWithHub': client.authenticateWithHub,
  'hub-client.fetchAuthMe': client.fetchAuthMe,
  'hub-client.patchAuthMe': client.patchAuthMe,
  'hub-client.fetchMyPosts': client.fetchMyPosts,
  'hub-client.fetchMyPostsByKeyboard': client.fetchMyPostsByKeyboard,
  'hub-client.patchPostOnHub': client.patchPostOnHub,
  'hub-client.deletePostFromHub': client.deletePostFromHub,
  'hub-client.uploadPostToHub': client.uploadPostToHub,
  'hub-client.updatePostOnHub': client.updatePostOnHub,
  'hub-client.uploadPrivatePostToHub': client.uploadPrivatePostToHub,
  'hub-client.deletePrivatePostFromHub': client.deletePrivatePostFromHub,
  'hub-client.uploadFeaturePostToHub': client.uploadFeaturePostToHub,
  'hub-client.updateFeaturePostOnHub': client.updateFeaturePostOnHub,
  'hub-client.uploadPrivateFeaturePostToHub': client.uploadPrivateFeaturePostToHub,
  'hub-client.uploadAnalyticsPostToHub': client.uploadAnalyticsPostToHub,
  'hub-client.updateAnalyticsPostOnHub': client.updateAnalyticsPostOnHub,
  'hub-client.uploadPrivateAnalyticsPostToHub': client.uploadPrivateAnalyticsPostToHub,
  'hub-i18n.fetchI18nPostList': i18n.fetchI18nPostList,
  'hub-i18n.downloadI18nPostBody': i18n.downloadI18nPostBody,
  'hub-i18n.fetchI18nPackTimestamps': i18n.fetchI18nPackTimestamps,
  'hub-i18n.uploadI18nPostToHub': i18n.uploadI18nPostToHub,
  'hub-i18n.updateI18nPostOnHub': i18n.updateI18nPostOnHub,
  'hub-i18n.deleteI18nPostFromHub': i18n.deleteI18nPostFromHub,
  'hub-theme.fetchThemePostList': theme.fetchThemePostList,
  'hub-theme.downloadThemePostBody': theme.downloadThemePostBody,
  'hub-theme.fetchThemePackTimestamps': theme.fetchThemePackTimestamps,
  'hub-theme.uploadThemePostToHub': theme.uploadThemePostToHub,
  'hub-theme.updateThemePostOnHub': theme.updateThemePostOnHub,
  'hub-theme.deleteThemePostFromHub': theme.deleteThemePostFromHub,
  'hub-key-labels.fetchKeyLabelList': keyLabels.fetchKeyLabelList,
  'hub-key-labels.fetchKeyLabelDetail': keyLabels.fetchKeyLabelDetail,
  'hub-key-labels.fetchKeyLabelTimestamps': keyLabels.fetchKeyLabelTimestamps,
  'hub-key-labels.downloadKeyLabel': keyLabels.downloadKeyLabel,
  'hub-key-labels.uploadKeyLabel': keyLabels.uploadKeyLabel,
  'hub-key-labels.updateKeyLabel': keyLabels.updateKeyLabel,
  'hub-key-labels.deleteKeyLabel': keyLabels.deleteKeyLabel,
}

function isFileArg(value: unknown): value is FileArg {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as FileArg).name === 'string' &&
    typeof (value as FileArg).base64 === 'string' &&
    Object.keys(value).length === 2
  )
}

/** `value` with every `{ name, base64 }` turned into `{ name, data }`. */
function withBuffers(value: unknown): unknown {
  if (isFileArg(value)) return { name: value.name, data: Buffer.from(value.base64, 'base64') }
  if (Array.isArray(value)) return value.map(withBuffers)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withBuffers(v)]))
  }
  return value
}

export function runCall(call: ApiCall): Promise<unknown> {
  const fn = FUNCTIONS[call.fn]
  if (fn === undefined) throw new Error(`hub fixture harness: unknown function ${call.fn}`)
  return (fn as (...args: unknown[]) => Promise<unknown>)(...call.args.map(withBuffers))
}

// --- Inputs ---

const file = (name: string, bytes: number[] | string): FileArg => ({
  name,
  base64: (typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes)).toString('base64'),
})

/** The five files of a keymap post; the PDF and the JPEG are not UTF-8. */
const KEYMAP_FILES = {
  vil: file('My_Board.vil', '{"version":1,"layout":[[[0,1]]]}'),
  pipette: file('My_Board.pipette', '{"name":"キー"}'),
  c: file('My_Board.c', 'const uint16_t PROGMEM keymaps[] = {\r\n};\n'),
  pdf: file('My_Board.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x0d, 0x0a]),
  thumbnail: file('My_Board.jpg', [0xff, 0xd8, 0xff, 0xe0, 0x2d, 0x2d, 0x0d, 0x0a]),
}

const FEATURE_JSON = file('macro.json', '{"app":"pipette","version":3,"vial_protocol":6,"macro":[]}')
const ANALYTICS_JSON = file('Corne.json', '{"version":1,"kind":"analytics","label":"é"}')
const ANALYTICS_THUMB = file('Corne.jpg', [0xff, 0xd8, 0x00, 0x80])

const I18N_PACK: HubI18nPackBody = { name: 'Japanese', version: '1.2.0', common: { save: '保存', cancel: 'キャンセル' }, z: 'last', a: 'first' }
const THEME_PACK: HubThemePackBody = {
  name: 'Nord',
  version: '1.0.0',
  colorScheme: 'dark',
  colors: { bg: '#2e3440', fg: '#eceff4' },
} as unknown as HubThemePackBody

const USER = { id: 'u-1', email: 'user@example.com', display_name: 'User', role: 'user' }
const POST = { id: 'post-1', title: 'Title' }
const PRIVATE = { id: 'priv-1', token: 'tok-1', url: '/p/priv-1?token=tok-1', expires_at: '2026-10-23T00:00:00.000Z' }
const MY_POST = { id: 'post-1', title: 'Title', keyboard_name: 'Corne', created_at: '2026-10-01T00:00:00.000Z' }
const PACK_SUMMARY = {
  id: 'pack-1',
  name: 'Japanese',
  version: '1.2.0',
  uploaded_by: 'u-1',
  uploader_name: 'User',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
}
const KEY_LABEL = {
  id: 'kl-1',
  name: 'Eucalyn',
  map: { KC_A: 'A' },
  composite_labels: null,
  keymap_applicable: true,
  uploaded_by: 'u-1',
  uploader_name: 'User',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
}
const TIMESTAMPS = { items: [{ id: 'a', updated_at: '2026-10-02T00:00:00.000Z' }] }

const call = (fn: string, args: unknown[], reader: Reader, method: string, path: string, data: unknown): ApiCall => ({
  fn,
  args,
  reader,
  method,
  path,
  data,
})

export const CALLS: ApiCall[] = [
  call('hub-client.authenticateWithHub', ['id-token-1'], 'strict', 'POST', '/api/auth/token', { token: 'jwt-1', user: USER }),
  call('hub-client.authenticateWithHub', ['id-token-1', 'New Name "q"'], 'strict', 'POST', '/api/auth/token', { token: 'jwt-1', user: USER }),
  call('hub-client.authenticateWithHub', ['id-token-1', ''], 'strict', 'POST', '/api/auth/token', { token: 'jwt-1', user: USER }),
  call('hub-client.fetchAuthMe', ['jwt-1'], 'strict', 'GET', '/api/auth/me', USER),
  call('hub-client.patchAuthMe', ['jwt-1', 'ユーザー'], 'strict', 'PATCH', '/api/auth/me', USER),
  call('hub-client.fetchMyPosts', ['jwt-1'], 'strict', 'GET', '/api/files/me', { items: [MY_POST], total: 1, page: 1, per_page: 20 }),
  call('hub-client.fetchMyPosts', ['jwt-1', { page: 2 }], 'strict', 'GET', '/api/files/me', { items: [], total: 1, page: 2, per_page: 20 }),
  call('hub-client.fetchMyPosts', ['jwt-1', { page: 3, per_page: 50 }], 'strict', 'GET', '/api/files/me', { items: [], total: 1, page: 3, per_page: 50 }),
  call('hub-client.fetchMyPostsByKeyboard', ['jwt-1', 'My Board/ä&x=1 +'], 'strict', 'GET', '/api/files/me/keyboard', [MY_POST]),
  call('hub-client.patchPostOnHub', ['jwt-1', 'post-1', { title: 'New title' }], 'strict', 'PATCH', '/api/files/post-1', null),
  call('hub-client.deletePostFromHub', ['jwt-1', 'post-1'], 'strict', 'DELETE', '/api/files/post-1', null),
  call('hub-client.uploadPostToHub', ['jwt-1', 'Title\nline', 'My Board\r\nv2', KEYMAP_FILES], 'strict', 'POST', '/api/files', POST),
  call('hub-client.updatePostOnHub', ['jwt-1', 'post-1', 'Title', 'My Board', KEYMAP_FILES], 'strict', 'PUT', '/api/files/post-1', POST),
  call('hub-client.uploadPrivatePostToHub', ['jwt-1', 'Title', 'My Board', KEYMAP_FILES, 7], 'strict', 'POST', '/api/private/files', PRIVATE),
  call('hub-client.uploadPrivatePostToHub', ['jwt-1', 'Title', 'My Board', KEYMAP_FILES, null], 'strict', 'POST', '/api/private/files', PRIVATE),
  call('hub-client.deletePrivatePostFromHub', ['jwt-1', 'files', 'priv-1'], 'strict', 'DELETE', '/api/private/files/priv-1', null),
  call('hub-client.deletePrivatePostFromHub', ['jwt-1', 'files', 'a b/c'], 'strict', 'DELETE', '/api/private/files/a%20b%2Fc', null),
  call('hub-client.uploadFeaturePostToHub', ['jwt-1', 'Macro', 'macro', FEATURE_JSON], 'strict', 'POST', '/api/files', POST),
  call('hub-client.updateFeaturePostOnHub', ['jwt-1', 'post-1', 'Macro', 'macro', FEATURE_JSON], 'strict', 'PUT', '/api/files/post-1', POST),
  call('hub-client.uploadPrivateFeaturePostToHub', ['jwt-1', 'Macro', 'macro', FEATURE_JSON, 30], 'strict', 'POST', '/api/private/files', PRIVATE),
  call('hub-client.uploadPrivateFeaturePostToHub', ['jwt-1', 'Macro', 'macro', FEATURE_JSON, null], 'strict', 'POST', '/api/private/files', PRIVATE),
  call('hub-client.uploadAnalyticsPostToHub', ['jwt-1', 'Stats', ANALYTICS_JSON, ANALYTICS_THUMB], 'strict', 'POST', '/api/files', POST),
  call('hub-client.updateAnalyticsPostOnHub', ['jwt-1', 'post-1', 'Stats', ANALYTICS_JSON, ANALYTICS_THUMB], 'strict', 'PUT', '/api/files/post-1', POST),
  call('hub-client.uploadPrivateAnalyticsPostToHub', ['jwt-1', 'Stats', ANALYTICS_JSON, ANALYTICS_THUMB, 180], 'strict', 'POST', '/api/private/files', PRIVATE),
  call('hub-i18n.fetchI18nPostList', [{}], 'lenient', 'GET', '/api/i18n-packs', { items: [PACK_SUMMARY], total: 1, page: 1, per_page: 20 }),
  call('hub-i18n.fetchI18nPostList', [{ q: '  ja  ', name: ' Japanese ', page: 2, perPage: 50 }], 'lenient', 'GET', '/api/i18n-packs', { items: [{ id: 'p', name: 'n', version: '1.0.0', created_at: 'c' }], total: 1, page: 2, per_page: 50 }),
  call('hub-i18n.fetchI18nPostList', [{ q: '   ', name: '', page: 0 }], 'lenient', 'GET', '/api/i18n-packs', { items: [], total: 0, page: 0, per_page: 20 }),
  call('hub-i18n.downloadI18nPostBody', ['pack-1'], 'download', 'GET', '/api/i18n-packs/pack-1/download', { version: 1, kind: 'i18n', exportedAt: '2026-10-01T00:00:00.000Z', pack: I18N_PACK }),
  call('hub-i18n.fetchI18nPackTimestamps', [['a', 'b']], 'lenient', 'POST', '/api/i18n-packs/timestamps', TIMESTAMPS),
  call('hub-i18n.uploadI18nPostToHub', ['jwt-1', I18N_PACK], 'lenient', 'POST', '/api/i18n-packs', POST),
  call('hub-i18n.updateI18nPostOnHub', ['jwt-1', 'pack-1', I18N_PACK], 'lenient', 'PUT', '/api/i18n-packs/pack-1', POST),
  call('hub-i18n.deleteI18nPostFromHub', ['jwt-1', 'pack-1'], 'lenient', 'DELETE', '/api/i18n-packs/pack-1', null),
  call('hub-theme.fetchThemePostList', [{}], 'lenient', 'GET', '/api/theme-packs', { items: [PACK_SUMMARY], total: 1, page: 1, per_page: 20 }),
  call('hub-theme.fetchThemePostList', [{ q: ' nord ', name: 'Nord', page: 1, perPage: 10 }], 'lenient', 'GET', '/api/theme-packs', { items: [], total: 0, page: 1, per_page: 10 }),
  call('hub-theme.downloadThemePostBody', ['theme-1'], 'lenient', 'GET', '/api/theme-packs/theme-1/download', THEME_PACK),
  call('hub-theme.fetchThemePackTimestamps', [['a']], 'lenient', 'POST', '/api/theme-packs/timestamps', TIMESTAMPS),
  call('hub-theme.uploadThemePostToHub', ['jwt-1', THEME_PACK], 'lenient', 'POST', '/api/theme-packs', POST),
  call('hub-theme.updateThemePostOnHub', ['jwt-1', 'theme-1', THEME_PACK], 'lenient', 'PUT', '/api/theme-packs/theme-1', POST),
  call('hub-theme.deleteThemePostFromHub', ['jwt-1', 'theme-1'], 'lenient', 'DELETE', '/api/theme-packs/theme-1', null),
  call('hub-key-labels.fetchKeyLabelList', [{}], 'strict-key-labels', 'GET', '/api/key-labels', { items: [KEY_LABEL], total: 1, page: 1, per_page: 20 }),
  call('hub-key-labels.fetchKeyLabelList', [{ q: ' euc ', page: 2, perPage: 100 }], 'strict-key-labels', 'GET', '/api/key-labels', { items: [], total: 1, page: 2, per_page: 100 }),
  call('hub-key-labels.fetchKeyLabelDetail', ['kl-1'], 'strict-key-labels', 'GET', '/api/key-labels/kl-1', KEY_LABEL),
  call('hub-key-labels.fetchKeyLabelTimestamps', [['kl-1', 'kl-2']], 'strict-key-labels', 'POST', '/api/key-labels/timestamps', TIMESTAMPS),
  call('hub-key-labels.downloadKeyLabel', ['kl-1'], 'download', 'GET', '/api/key-labels/kl-1/download', { name: 'Eucalyn', map: { KC_A: 'A' }, composite_labels: null }),
  call('hub-key-labels.uploadKeyLabel', ['jwt-1', { name: 'Eucalyn', map: { KC_B: 'B', KC_A: 'A' } }], 'strict-key-labels', 'POST', '/api/key-labels', KEY_LABEL),
  call('hub-key-labels.uploadKeyLabel', ['jwt-1', { name: 'Eucalyn', map: {}, compositeLabels: null, keymapApplicable: true }], 'strict-key-labels', 'POST', '/api/key-labels', KEY_LABEL),
  call('hub-key-labels.uploadKeyLabel', ['jwt-1', { name: 'Eucalyn', map: { KC_A: 'A' }, compositeLabels: { 'LSFT(KC_1)': '!' }, keymapApplicable: false }], 'strict-key-labels', 'POST', '/api/key-labels', KEY_LABEL),
  call('hub-key-labels.updateKeyLabel', ['jwt-1', 'kl-1', { name: 'Eucalyn', map: { KC_A: 'A' } }], 'strict-key-labels', 'PUT', '/api/key-labels/kl-1', KEY_LABEL),
  call('hub-key-labels.deleteKeyLabel', ['jwt-1', 'kl-1'], 'strict-key-labels', 'DELETE', '/api/key-labels/kl-1', null),
]

/** One call per function, for the table of answers. */
export function onePerFunction(): ApiCall[] {
  const seen = new Set<string>()
  return CALLS.filter((c) => {
    if (seen.has(c.fn)) return false
    seen.add(c.fn)
    return true
  })
}
