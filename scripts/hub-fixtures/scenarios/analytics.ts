// SPDX-License-Identifier: GPL-2.0-or-later
// Handler scenarios of the Analyze posts (hub-ipc-analytics.ts and the
// private analytics upload of hub-ipc-private.ts): the checks of the saved
// filter condition and their order against the post id and the title, and,
// on the typing analytics seed and userData of the Analyze export golden
// (../analytics-export/cases.ts), the posts themselves: the multipart
// bodies, the token retry and the Hub's failures, the post id linked to the
// saved filter (and what happens when it cannot be), and the preview. The
// generator (../analytics-export/record-analytics-handlers.test.ts) seeds
// the database these need.

import { ok, tokenRule, type Scenario } from '../handler-scenario'
import type { HubRule } from '../hub-harness'
import type { Tree } from '../../sync-fixtures/harness'
import { exportTree } from '../analytics-export/cases'

const UID = '0xA1B2'
const DIR = `sync/keyboards/${UID}/analyze_filters`
const json = (value: unknown): string => JSON.stringify(value, null, 2)

const entry = (id: string, filename: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  filename,
  savedAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

const TREE: Tree = {
  [`${DIR}/index.json`]: json({
    uid: UID,
    entries: [
      entry('f-ok', 'f_ok.json'),
      entry('f-deleted', 'f_ok.json', { deletedAt: '2026-10-02T00:00:00.000Z' }),
      entry('f-notjson', 'f_notjson.json'),
      entry('f-v2', 'f_v2.json'),
      entry('f-norange', 'f_norange.json'),
    ],
  }),
  // No keymap snapshot exists for this range.
  [`${DIR}/f_ok.json`]: JSON.stringify({ version: 1, range: { fromMs: 1_790_000_000_000, toMs: 1_790_086_400_000 }, filters: { deviceScopes: ['own'] } }),
  [`${DIR}/f_notjson.json`]: '{not json',
  [`${DIR}/f_v2.json`]: JSON.stringify({ version: 2, range: { fromMs: 0, toMs: 1 } }),
  [`${DIR}/f_norange.json`]: JSON.stringify({ version: 1, range: { fromMs: 0 } }),
}

const KEYBOARD = { productName: 'Corne', vendorId: 0x4653, productId: 1 }
const upload = (over: Record<string, unknown> = {}) => ({
  uid: UID,
  entryId: 'f-ok',
  title: 'Stats',
  thumbnailBase64: '/9j/4A==',
  keyboard: KEYBOARD,
  fingerOverrides: {},
  layoutComparisonInputs: null,
  ...over,
})
const preview = (over: Record<string, unknown> = {}) => ({
  uid: UID,
  entryId: 'f-ok',
  keyboard: KEYBOARD,
  fingerOverrides: {},
  layoutComparisonInputs: null,
  ...over,
})

export const ANALYTICS_SCENARIOS: Scenario[] = [
  {
    name: 'the saved filter condition is checked before the title',
    tree: TREE,
    rules: [],
    steps: [
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [upload({ uid: '', title: '' })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [upload({ uid: 5 })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [upload({ entryId: '' })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [upload({ uid: '../x' })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [upload({ entryId: 'nope', title: '' })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [upload({ entryId: 'f-deleted' })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [upload({ entryId: 'f-notjson' })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [upload({ entryId: 'f-v2' })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [upload({ entryId: 'f-norange' })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [upload({ title: '' })] },
      { call: 'HUB_UPDATE_ANALYTICS_POST', args: [{ ...upload({ uid: '' }), postId: 'bad id' }] },
      { call: 'HUB_UPDATE_ANALYTICS_POST', args: [{ ...upload({ uid: '' }), postId: 'post-1' }] },
      { call: 'HUB_UPLOAD_PRIVATE_ANALYTICS_POST', args: [{ ...upload({ entryId: 'nope' }), expiresInDays: 7 }] },
    ],
  },
  {
    name: 'a preview that cannot be built is a failed validation',
    tree: TREE,
    rules: [],
    steps: [
      { call: 'HUB_PREVIEW_ANALYTICS_POST', args: [preview()] },
      { call: 'HUB_PREVIEW_ANALYTICS_POST', args: [preview({ entryId: 'nope' })] },
      { call: 'HUB_PREVIEW_ANALYTICS_POST', args: [preview({ uid: '' })] },
      { call: 'HUB_PREVIEW_ANALYTICS_POST', args: [preview({ uid: '../x' })] },
    ],
  },
]

// --- On the export seed ---

const SEEDED_UID = 'uid-a'
const ALPHA = { productName: 'Alpha Beta/2', vendorId: 0xfeed, productId: 1 }

/** Upload parameters of a saved filter of the export seed. One small
 *  category keeps the export, and so the golden file, short. */
const seededUpload = (over: Record<string, unknown> = {}) => ({
  uid: SEEDED_UID,
  entryId: 'f-own',
  title: '  Stats  ',
  thumbnailBase64: '/9j/4A==',
  keyboard: ALPHA,
  fingerOverrides: {},
  layoutComparisonInputs: null,
  categories: ['layer'],
  ...over,
})
const seededPreview = (over: Record<string, unknown> = {}) => ({
  uid: SEEDED_UID,
  entryId: 'f-own',
  keyboard: ALPHA,
  fingerOverrides: {},
  layoutComparisonInputs: null,
  categories: ['layer'],
  ...over,
})

const rule = (method: string, path: string, responses: HubRule['responses']): HubRule => ({ method, path, responses })

export const ANALYTICS_POST_SCENARIOS: Scenario[] = [
  {
    name: 'a public post is uploaded, updated and linked to its saved filter',
    tree: exportTree(),
    rules: [
      tokenRule(2),
      rule('POST', '/api/files', [
        ok({ id: 'post-1', title: 'Stats' }),
        { status: 429, json: { ok: false, error: 'slow down' }, headers: { 'Retry-After': '2' } },
        ok({ id: 'post-2', title: 'Stats' }),
        { status: 403, json: { ok: false, error: 'deactivated' } },
        { status: 200, json: { ok: false, error: 'nope' } },
      ]),
      rule('PUT', '/api/files/post-2', [{ status: 401, text: 'expired' }, ok({ id: 'post-2', title: 'Stats' })]),
      rule('PUT', '/api/files/gone', [{ status: 404, json: { ok: false, error: 'Not found' } }]),
    ],
    steps: [
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload()] },
      // The export is built before the title, the file name and the
      // thumbnail are checked.
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload({ title: ' ' })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload({ keyboard: { ...ALPHA, productName: 7 } })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload({ thumbnailBase64: null })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload({ entryId: 'f-small', keyboard: { ...ALPHA, productName: '' } })] },
      { call: 'HUB_UPDATE_ANALYTICS_POST', args: [{ ...seededUpload({ title: 'Stats 2' }), postId: 'post-2' }] },
      { call: 'HUB_UPDATE_ANALYTICS_POST', args: [{ ...seededUpload({ title: '' }), postId: 'post-2' }] },
      { call: 'HUB_UPDATE_ANALYTICS_POST', args: [{ ...seededUpload(), postId: 'gone' }] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload()] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload()] },
    ],
  },
  {
    name: 'the post id the Hub answers is linked as the store takes it',
    tree: exportTree(),
    rules: [
      tokenRule(1),
      rule('POST', '/api/files', [
        ok({ id: '  post-3  ' }),
        // An id that is not a string: the store refuses it, the upload
        // still succeeds.
        ok({ id: 5 }),
        // No id: the link is cleared.
        ok({ title: 'Stats' }),
        // No data at all.
        { status: 200, json: { ok: true } },
      ]),
    ],
    steps: [
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload()] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload({ entryId: 'f-small' })] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload()] },
      { call: 'HUB_UPLOAD_ANALYTICS_POST', args: [seededUpload()] },
    ],
  },
  {
    name: 'a private analytics post links nothing',
    tree: exportTree(),
    rules: [
      tokenRule(1),
      rule('POST', '/api/private/files', [
        ok({ id: 'priv-1', token: 'tok-1', url: '/p/priv-1?token=tok-1', expires_at: '2026-10-23 00:00:00.000Z' }),
        ok({ id: 'priv-2', token: 'tok-2', url: '/p/priv-2?token=tok-2', expires_at: null }),
        { status: 429, json: { ok: false, error: 'daily limit' }, headers: { 'Retry-After': '3600' } },
        ok(null),
      ]),
    ],
    steps: [
      { call: 'HUB_UPLOAD_PRIVATE_ANALYTICS_POST', args: [{ ...seededUpload(), expiresInDays: 7 }] },
      { call: 'HUB_UPLOAD_PRIVATE_ANALYTICS_POST', args: [{ ...seededUpload(), expiresInDays: null }] },
      { call: 'HUB_UPLOAD_PRIVATE_ANALYTICS_POST', args: [{ ...seededUpload(), expiresInDays: 30 }] },
      { call: 'HUB_UPLOAD_PRIVATE_ANALYTICS_POST', args: [{ ...seededUpload({ title: '' }), expiresInDays: 7 }] },
      { call: 'HUB_UPLOAD_PRIVATE_ANALYTICS_POST', args: [{ ...seededUpload(), expiresInDays: 1 }] },
    ],
  },
  {
    name: 'the preview reports the size and the validation without a request',
    tree: exportTree(),
    rules: [],
    steps: [
      { call: 'HUB_PREVIEW_ANALYTICS_POST', args: [seededPreview()] },
      { call: 'HUB_PREVIEW_ANALYTICS_POST', args: [seededPreview({ entryId: 'f-small', categories: undefined })] },
      { call: 'HUB_PREVIEW_ANALYTICS_POST', args: [seededPreview({ entryId: 'f-long' })] },
      { call: 'HUB_PREVIEW_ANALYTICS_POST', args: [seededPreview({ entryId: 'f-early' })] },
      { call: 'HUB_PREVIEW_ANALYTICS_POST', args: [seededPreview({ keyboard: null })] },
    ],
  },
]
