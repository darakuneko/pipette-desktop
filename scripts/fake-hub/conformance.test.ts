// SPDX-License-Identifier: GPL-2.0-or-later
// The Node fake Hub against the conformance cases it shares with the
// in-memory Hub of the pipette-hub crate (conformance-cases.json), then the
// desktop app's own Hub client (src/main/hub/hub-client.ts, hub-i18n.ts,
// hub-theme.ts, hub-key-labels.ts) against the fake, and the control
// endpoints.
//
// Run: pnpm run test:fake-hub

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CONFORMANCE, matchPattern, runCase, type Step } from './conformance-runner'
import { fakeHubEnv, startFakeHub, type FakeHub } from './server'

let hub: FakeHub

beforeEach(async () => {
  hub = await startFakeHub()
})

afterEach(async () => {
  await hub.close()
})

/** The control endpoint of a conformance control step. */
const CONTROL_PATH: Record<string, string> = {
  user: '/__control/users',
  fault: '/__control/faults',
  keyLabel: '/__control/key-labels',
  touch: '/__control/touch',
  revokeTokens: '/__control/revoke-tokens',
}

async function control(path: string, body: unknown = {}): Promise<unknown> {
  const response = await fetch(`${hub.url}${path}`, { method: 'POST', body: JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`)
  return JSON.parse(text) as unknown
}

function controlStep(step: Step): Promise<unknown> {
  const { control: kind, save: _save, ...body } = step
  const path = CONTROL_PATH[String(kind)]
  if (!path) throw new Error(`unknown control step ${String(kind)}`)
  return control(path, body)
}

async function json(path: string): Promise<unknown> {
  return (await fetch(`${hub.url}${path}`)).json()
}

describe('the fake Hub', () => {
  it('passes the conformance cases', async () => {
    expect(CONFORMANCE.cases).toHaveLength(12)
    for (const testCase of CONFORMANCE.cases) {
      await control('/__control/reset')
      await runCase(hub.url, testCase, { run: '', control: controlStep })
    }
  })

  it('listens on 127.0.0.1 only', () => {
    expect(new URL(hub.url).hostname).toBe('127.0.0.1')
    expect(fakeHubEnv(hub.url)).toEqual({ PIPETTE_HUB_URL: hub.url })
  })

  it('stops a case at a name no earlier step saved', async () => {
    const testCase = { name: 'case', steps: [{ request: 'GET /api/files/{unsaved}', expect: { status: 404 } }] }
    await expect(runCase(hub.url, testCase, { run: '' })).rejects.toThrow(/nothing saved as unsaved/)
  })

  it('reports where a pattern differs', () => {
    const saved = new Map<string, unknown>([['id', 'a']])
    expect(() => matchPattern({ data: { id: 'b' } }, { data: { id: '$saved:id' } }, saved, 'x')).toThrow(/x\.data\.id: expected "a"/)
    expect(() => matchPattern({ a: 1, b: 2 }, { $keys: ['b', 'a'] }, saved, 'x')).toThrow(/the keys/)
    expect(() => matchPattern({ a: 1 }, { a: '$absent' }, saved, 'x')).toThrow(/no a/)
    expect(() => matchPattern('2026-01-01T00:00:00.000Z', '$hubStamp', saved, 'x')).toThrow(/\$hubStamp/)
  })

  it('logs each request with its route, account and body, without tokens', async () => {
    const { data } = (await (await fetch(`${hub.url}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: 'test:alice@example.com' }),
    })).json()) as { data: { token: string } }
    await fetch(`${hub.url}/api/files/me?page=2`, { headers: { Authorization: `Bearer ${data.token}` } })
    await fetch(`${hub.url}/api/nothing`)
    expect(hub.requests).toEqual([
      { method: 'POST', path: '/api/auth/token', query: {}, op: 'auth.token', account: null, contentType: 'application/json', body: { json: { id_token: 'test:alice@example.com' } } },
      { method: 'GET', path: '/api/files/me', query: { page: '2' }, op: 'files.me', account: 'alice@example.com', contentType: null, body: null },
      { method: 'GET', path: '/api/nothing', query: {}, op: null, account: null, contentType: null, body: null },
    ])
    expect(JSON.stringify(hub.requests)).not.toContain(data.token)
    expect(await json('/__control/requests')).toEqual(hub.requests)
    await control('/__control/clear-requests')
    expect(hub.requests).toEqual([])
  })

  it('issues the same ids, stamps and JWTs on every run', async () => {
    const run = async (): Promise<unknown> => {
      await control('/__control/reset')
      const token = (await (await fetch(`${hub.url}/api/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_token: 'test:alice@example.com' }),
      })).json()) as { data: { token: string } }
      const label = await (await fetch(`${hub.url}/api/key-labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.data.token}` },
        body: JSON.stringify({ name: 'L', map: {} }),
      })).json()
      return { token, label }
    }
    const first = await run()
    expect(await run()).toEqual(first)
    expect(first).toMatchObject({
      token: { data: { user: { id: '00000000-0000-4000-8000-000000000001' } } },
      label: { data: { id: '00000000-0000-4000-8000-000000000002', created_at: '2026-01-01 00:00:01.000Z', updated_at: '2026-01-01 00:00:01.000Z' } },
    })
    const jwt = (first as { token: { data: { token: string } } }).token.data.token
    expect(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))).toEqual({
      sub: '00000000-0000-4000-8000-000000000001',
      email: 'alice@example.com',
      role: 'user',
      exp: 1_767_225_600 + 7 * 24 * 60 * 60,
      iat: 1_767_225_600,
    })
  })

  it('creates records directly: another PC\'s post, packs and a newer update time', async () => {
    const post = (await control('/__control/posts', { owner: 'alice@example.com', title: 'From PC 2', keyboardName: 'KB', updatedAt: '2026-02-01 00:00:00.000Z' })) as { id: string }
    const i18n = (await control('/__control/i18n-packs', {
      owner: 'alice@example.com',
      export: { version: 1, kind: 'i18n', exportedAt: '2026-01-01T00:00:00.000Z', pack: { name: 'Seeded', version: '1.0.0', a: 'b' } },
    })) as { id: string; updated_at: string; uploader_name: string }
    const theme = (await control('/__control/theme-packs', {
      owner: 'bob@example.com',
      pack: { name: 'Dark', version: '1.0.0', colorScheme: 'dark', colors: { surface: '#000' } },
    })) as { id: string; preview_colors: string[] }
    expect(i18n.uploader_name).toBe('alice')
    expect(theme.preview_colors).toEqual(['#000', '#cccccc', '#cccccc', '#cccccc', '#cccccc', '#cccccc', '#cccccc'])

    const { data: token } = (await (await fetch(`${hub.url}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: 'test:alice@example.com' }),
    })).json()) as { data: { token: string } }
    const mine = (await (await fetch(`${hub.url}/api/files/me`, { headers: { Authorization: `Bearer ${token.token}` } })).json()) as {
      data: { items: Array<{ id: string; updated_at: string }> }
    }
    expect(mine.data.items).toEqual([expect.objectContaining({ id: post.id, title: 'From PC 2', updated_at: '2026-02-01 00:00:00.000Z' })])

    const touched = (await control('/__control/touch', { kind: 'i18n', id: i18n.id, updatedAt: '2026-03-01 00:00:00.000Z' })) as { updated_at: string }
    expect(touched.updated_at).toBe('2026-03-01 00:00:00.000Z')
    const stamps = (await (await fetch(`${hub.url}/api/i18n-packs/timestamps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [i18n.id] }),
    })).json()) as unknown
    expect(stamps).toEqual({ ok: true, data: { items: [{ id: i18n.id, updated_at: '2026-03-01 00:00:00.000Z' }] } })
    const download = await (await fetch(`${hub.url}/api/i18n-packs/${i18n.id}/download`)).text()
    expect(JSON.parse(download)).toEqual({ version: 1, kind: 'i18n', exportedAt: '2026-01-01T00:00:00.000Z', pack: { name: 'Seeded', version: '1.0.0', a: 'b' } })

    const state = (await json('/__control/state')) as { posts: unknown[]; packs: { i18n: unknown[]; theme: unknown[] } }
    expect(state.posts).toHaveLength(1)
    expect(state.packs.theme).toHaveLength(1)
    await expect(control('/__control/touch', { kind: 'post', id: 'missing' })).rejects.toThrow(/400/)
  })
})

describe('the desktop Hub client against the fake Hub', () => {
  const savedEnv = { url: process.env.PIPETTE_HUB_URL, test: process.env.PIPETTE_HUB_TEST }
  const realFetch = globalThis.fetch

  beforeAll(() => {
    process.env.PIPETTE_HUB_TEST = '1'
    // The client falls back to the real Hub when the override is not in
    // effect; any request that does not go to 127.0.0.1 fails instead.
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname !== '127.0.0.1') return Promise.reject(new Error(`refused a request to ${url.origin}`))
      return realFetch(input, init)
    }
  })

  beforeEach(() => {
    process.env.PIPETTE_HUB_URL = hub.url
  })

  afterAll(() => {
    globalThis.fetch = realFetch
    for (const [key, value] of [['PIPETTE_HUB_URL', savedEnv.url], ['PIPETTE_HUB_TEST', savedEnv.test]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('keeps every request on the fake Hub', async () => {
    const { getHubApiBase } = await import('../../src/main/hub/hub-base')
    expect(getHubApiBase()).toBe(hub.url)
    await expect(fetch('https://pipette-hub-worker.keymaps.workers.dev/api/key-labels')).rejects.toThrow(/refused a request/)
  })

  it('signs in, uploads, lists, updates and deletes posts', async () => {
    const client = await import('../../src/main/hub/hub-client')
    const auth = await client.authenticateWithHub('test:alice@example.com', 'Alice')
    expect(auth.user).toEqual({ id: '00000000-0000-4000-8000-000000000001', email: 'alice@example.com', display_name: 'Alice', role: 'user' })
    await expect(client.authenticateWithHub('test:bob@example.com', 'alice')).rejects.toThrow(client.Hub409Error)

    const file = (name: string, text: string): { name: string; data: Buffer } => ({ name, data: Buffer.from(text) })
    const files = { vil: file('k.vil', '{}'), pipette: file('k.pipette', '{}'), c: file('k.c', ''), pdf: file('k.pdf', '%PDF'), thumbnail: file('k.jpg', 'jpg') }
    const created = await client.uploadPostToHub(auth.token, 'My keymap', 'KB', files)
    expect(created).toMatchObject({ title: 'My keymap', keyboard_name: 'KB' })
    const updated = await client.updatePostOnHub(auth.token, created.id, 'Renamed\nkeymap', 'KB', files)
    // The client turns line breaks in fields into spaces.
    expect(updated.title).toBe('Renamed keymap')
    await client.patchPostOnHub(auth.token, created.id, { title: 'Patched' })
    expect(await client.fetchMyPosts(auth.token, { page: 1, per_page: 5 })).toMatchObject({ items: [{ id: created.id, title: 'Patched' }], total: 1, page: 1, per_page: 5 })
    expect(await client.fetchMyPostsByKeyboard(auth.token, 'KB')).toHaveLength(1)
    expect(await client.fetchAuthMe(auth.token)).toMatchObject({ display_name: 'Alice' })
    expect(await client.patchAuthMe(auth.token, 'Alicia')).toMatchObject({ display_name: 'Alicia' })

    const feature = await client.uploadFeaturePostToHub(auth.token, 'Macros', 'macro', file('m.json', '{"version":3,"vial_protocol":6}'))
    expect(feature).toMatchObject({ post_type: 'macro' })
    await client.deletePostFromHub(auth.token, created.id)
    await expect(client.deletePostFromHub(auth.token, created.id)).rejects.toThrow(client.Hub404Error)

    const unlisted = await client.uploadPrivatePostToHub(auth.token, 'Secret', 'KB', files, 30)
    expect(unlisted).toMatchObject({ id: expect.any(String), token: expect.stringMatching(/^pt_v1_/), url: `/private/post/${unlisted.id}?token=${unlisted.token}` })
    await client.deletePrivatePostFromHub(auth.token, 'files', unlisted.id)
    await expect(client.deletePrivatePostFromHub(auth.token, 'files', unlisted.id)).rejects.toThrow(client.Hub404Error)

    const logged = hub.requests.find((request) => request.op === 'files.create')
    expect(logged?.contentType).toBe('multipart/form-data')
    expect(logged?.body).toEqual({
      parts: [
        { name: 'title', value: 'My keymap', size: 9 },
        { name: 'keyboard_name', value: 'KB', size: 2 },
        { name: 'vil', filename: 'k.vil', contentType: 'application/json', size: 2 },
        { name: 'pipette', filename: 'k.pipette', contentType: 'application/json', size: 2 },
        { name: 'c', filename: 'k.c', contentType: 'text/plain', size: 0 },
        { name: 'pdf', filename: 'k.pdf', contentType: 'application/pdf', size: 4 },
        { name: 'thumbnail', filename: 'k.jpg', contentType: 'image/jpeg', size: 3 },
      ],
    })
  })

  it('reads the failures the clients map to errors', async () => {
    const client = await import('../../src/main/hub/hub-client')
    const auth = await client.authenticateWithHub('test:alice@example.com')
    await control('/__control/faults', { status: 429, count: 1, retryAfter: '0', only: 'files.me' })
    expect((await client.fetchMyPosts(auth.token)).total).toBe(0)
    await control('/__control/faults', { status: 429, count: 1, retryAfter: '86400', only: 'files.me' })
    await expect(client.fetchMyPosts(auth.token)).rejects.toMatchObject({ name: 'Hub429Error', retryAfterSeconds: 86400 })
    await control('/__control/faults', { status: 200, count: 1, only: 'files.me', body: '{"ok":false,"error":"boom"}' })
    await expect(client.fetchMyPosts(auth.token)).rejects.toThrow('Hub fetch my posts failed: boom')
    await control('/__control/revoke-tokens')
    await expect(client.fetchAuthMe(auth.token)).rejects.toThrow('Hub fetch auth me failed: 401 {"ok":false,"error":"Invalid or expired token"}')
  })

  it('uploads, finds, downloads and deletes language and theme packs', async () => {
    const client = await import('../../src/main/hub/hub-client')
    const i18n = await import('../../src/main/hub/hub-i18n')
    const theme = await import('../../src/main/hub/hub-theme')
    const { token } = await client.authenticateWithHub('test:alice@example.com')

    const pack = { name: 'Klingon', version: '1.0.0', common: { save: 'Save' } }
    const uploaded = await i18n.uploadI18nPostToHub(token, pack)
    await expect(i18n.uploadI18nPostToHub(token, pack)).rejects.toThrow(client.Hub409Error)
    const listed = await i18n.fetchI18nPostList({ name: 'klingon' })
    expect(listed).toMatchObject({ total: 1, items: [{ id: uploaded.id, name: 'Klingon', uploaderName: 'alice' }] })
    const body = await i18n.downloadI18nPostBody(uploaded.id)
    expect(body).toMatchObject({ version: 1, kind: 'i18n', pack })
    expect(i18n.validateI18nExport(body).ok).toBe(true)
    await i18n.updateI18nPostOnHub(token, uploaded.id, { ...pack, version: '1.0.1' })
    const stamps = await i18n.fetchI18nPackTimestamps([uploaded.id, 'gone'])
    expect(stamps.items).toEqual([{ id: uploaded.id, updated_at: expect.any(String) }])
    await i18n.deleteI18nPostFromHub(token, uploaded.id)
    await expect(i18n.downloadI18nPostBody(uploaded.id)).rejects.toThrow('Hub i18n download failed: 404')

    const colors = Object.fromEntries(['surface', 'surface-alt', 'surface-dim', 'surface-raised', 'content', 'content-secondary', 'content-muted', 'content-inverse',
      'edge', 'edge-subtle', 'edge-strong', 'accent', 'accent-hover', 'accent-alt', 'success', 'warning', 'danger', 'pending',
      'key-bg', 'key-bg-hover', 'key-bg-active', 'key-border', 'key-shadow', 'key-label', 'key-sublabel', 'key-label-remap', 'key-bg-multi-selected',
      'tab-bg-active', 'tab-text', 'tab-text-active', 'picker-bg', 'picker-item-bg', 'picker-item-hover', 'picker-item-text', 'picker-item-border'].map((key) => [key, '#123456']))
    const themePack = { name: 'Night', version: '2.0.0', colorScheme: 'dark' as const, colors }
    const themeUploaded = await theme.uploadThemePostToHub(token, themePack)
    expect(await theme.fetchThemePostList({ q: 'nig' })).toMatchObject({ total: 1, items: [{ id: themeUploaded.id }] })
    expect(await theme.downloadThemePostBody(themeUploaded.id)).toEqual(themePack)
    await theme.updateThemePostOnHub(token, themeUploaded.id, themePack)
    expect((await theme.fetchThemePackTimestamps([themeUploaded.id])).items).toHaveLength(1)
    await theme.deleteThemePostFromHub(token, themeUploaded.id)
    await expect(theme.downloadThemePostBody(themeUploaded.id)).rejects.toThrow('Hub theme download failed: 404')
  })

  it('uploads, finds, downloads, updates and deletes key labels', async () => {
    const client = await import('../../src/main/hub/hub-client')
    const labels = await import('../../src/main/hub/hub-key-labels')
    const { token } = await client.authenticateWithHub('test:alice@example.com')
    const created = await labels.uploadKeyLabel(token, { name: 'Dvorak', map: { KC_A: 'a' }, keymapApplicable: true })
    expect(created).toMatchObject({ name: 'Dvorak', composite_labels: null, keymap_applicable: true, uploader_name: 'alice' })
    await expect(labels.uploadKeyLabel(token, { name: 'dvorak', map: {} })).rejects.toThrow(client.Hub409Error)
    expect(await labels.fetchKeyLabelList({ q: 'vor' })).toMatchObject({ total: 1, items: [{ id: created.id }] })
    expect(await labels.fetchKeyLabelDetail(created.id)).toMatchObject({ id: created.id })
    expect(await labels.downloadKeyLabel(created.id)).toEqual({ name: 'Dvorak', map: { KC_A: 'a' }, composite_labels: null, keymap_applicable: true })
    const updated = await labels.updateKeyLabel(token, created.id, { name: 'Dvorak', map: { KC_A: 'A' }, compositeLabels: { KC_B: 'b' } })
    // The client always sends keymap_applicable, false when unset.
    expect(updated).toMatchObject({ map: { KC_A: 'A' }, composite_labels: { KC_B: 'b' }, keymap_applicable: false })
    expect((await labels.fetchKeyLabelTimestamps([created.id])).items).toEqual([{ id: created.id, updated_at: updated.updated_at }])
    await labels.deleteKeyLabel(token, created.id)
    await expect(labels.fetchKeyLabelDetail(created.id)).rejects.toThrow('Hub key-label fetch failed: 404 {"ok":false,"error":"Key label not found"}')
  })
})
