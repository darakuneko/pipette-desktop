// SPDX-License-Identifier: GPL-2.0-or-later
// The Node fake Hub against the conformance cases it shares with the
// in-memory Hub of the pipette-hub crate (conformance-cases.json), and the
// control endpoints.
//
// Run: pnpm run test:fake-hub

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  it('logs each request with its route, account and body, without credentials', async () => {
    const { data } = (await (await fetch(`${hub.url}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: 'test:alice@example.com' }),
    })).json()) as { data: { token: string } }
    await fetch(`${hub.url}/api/files/me?page=2`, { headers: { Authorization: `Bearer ${data.token}` } })
    await fetch(`${hub.url}/api/nothing?token=pt_v1_x&q=x`)
    expect(hub.requests).toEqual([
      { method: 'POST', path: '/api/auth/token', query: {}, op: 'auth.token', account: null, contentType: 'application/json', body: { json: { id_token: '[redacted]' } } },
      { method: 'GET', path: '/api/files/me', query: { page: '2' }, op: 'files.me', account: 'alice@example.com', contentType: null, body: null },
      { method: 'GET', path: '/api/nothing', query: { token: '[redacted]', q: 'x' }, op: null, account: null, contentType: null, body: null },
    ])
    expect(JSON.stringify(hub.requests)).not.toContain(data.token)
    expect(JSON.stringify(hub.requests)).not.toContain('test:alice')
    expect(JSON.stringify(hub.requests)).not.toContain('pt_v1_x')
    expect(await json('/__control/requests')).toEqual(hub.requests)
    await control('/__control/clear-requests')
    expect(hub.requests).toEqual([])
  })

  it('refuses a fault it could not apply', async () => {
    for (const fault of [{ status: '429', count: 1 }, { status: 429, count: 0 }, { status: 429, count: 1.5 }, { status: 429, count: 1, only: 'files.upload' }, { status: 429, count: 1, retryAfter: 1 }]) {
      const response = await fetch(`${hub.url}/__control/faults`, { method: 'POST', body: JSON.stringify(fault) })
      expect(response.status, JSON.stringify(fault)).toBe(400)
    }
    expect((await fetch(`${hub.url}/api/key-labels`)).status).toBe(200)
  })

  it('reads uploaded JSON with a byte order mark as the Hub does', async () => {
    const { data } = (await (await fetch(`${hub.url}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: 'test:alice@example.com' }),
    })).json()) as { data: { token: string } }
    const pack = JSON.stringify({ version: 1, kind: 'i18n', exportedAt: '2026-01-01T00:00:00.000Z', pack: { name: 'Bom', version: '1.0.0' } })
    const boundary = 'b'
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="json"; filename="p.json"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`${pack}\r\n--${boundary}--\r\n`),
    ])
    const response = await fetch(`${hub.url}/api/i18n-packs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    })
    expect(response.status).toBe(201)
    const { data: created } = (await response.json()) as { data: { id: string } }
    expect(await (await fetch(`${hub.url}/api/i18n-packs/${created.id}/download`)).text()).toBe(JSON.stringify(JSON.parse(pack), null, 2))
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
