// SPDX-License-Identifier: GPL-2.0-or-later
// Handler scenarios of the Analyze posts (hub-ipc-analytics.ts and the
// private analytics upload of hub-ipc-private.ts) that end before the
// export is built: the checks of the saved filter condition and their
// order against the post id and the title. The export itself needs the
// typing analytics database and is recorded with the analytics seed by
// its own generator.

import type { Scenario } from '../handler-scenario'
import type { Tree } from '../../sync-fixtures/harness'

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
