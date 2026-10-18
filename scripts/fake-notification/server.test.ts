// SPDX-License-Identifier: GPL-2.0-or-later
// The fake startup-notice server: loopback only, the scripted answers, the
// request log and the faults, through the programmatic API and the control
// endpoints.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_DELAY_MS,
  checkedFault,
  fakeNotificationEnv,
  firestoreTimestamp,
  notice,
  startFakeNotification,
  type FakeNotification,
} from './server'

const QUERY = JSON.stringify({
  deviceId: 'all',
  type: 'notification',
  collection: 'pipette-notification',
  filters: [{ field: 'publishedAt', op: '<=', value: 1_760_000_000_000 }],
  orderBy: { field: 'publishedAt', direction: 'desc' },
  limit: 10,
})

let fake: FakeNotification

beforeEach(async () => {
  fake = await startFakeNotification()
})

afterEach(async () => {
  await fake.close()
})

function post(body = QUERY, path = '/'): Promise<Response> {
  return fetch(`${fake.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(5_000),
  })
}

function controlPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${fake.url}/__control/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
}

describe('the fake notice server', () => {
  it('listens on 127.0.0.1 and names itself in the variables', () => {
    expect(new URL(fake.url).hostname).toBe('127.0.0.1')
    expect(fakeNotificationEnv(fake.url)).toEqual({ PIPETTE_NOTIFICATION_URL: fake.url })
  })

  it('answers an empty list by default', async () => {
    const response = await post()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ notifications: [] })
  })

  it('answers the scripted notices as they are, timestamps of both kinds included', async () => {
    const list = [
      notice({ title: 'Old', publishedAt: '2025-01-01T00:00:00Z' }),
      notice({ title: 'New', publishedAt: firestoreTimestamp(1_750_000_000_500, 123) }),
      { title: 'broken' },
    ]
    fake.setNotifications(list)
    expect(await (await post()).json()).toEqual({ notifications: list })
    expect(firestoreTimestamp(1_750_000_000_500, 123)).toEqual({ _seconds: 1_750_000_000, _nanoseconds: 123 })
  })

  it('answers a whole scripted response, one without a list included', async () => {
    fake.setResponse({ notifications: 'not a list' })
    expect(await (await post()).json()).toEqual({ notifications: 'not a list' })
    const control = await controlPost('script', { response: { other: 1 } })
    expect(control.status).toBe(200)
    expect(await (await post()).json()).toEqual({ other: 1 })
    expect((await controlPost('script', { notifications: [notice({ publishedAt: 'x' })] })).status).toBe(200)
    expect(await (await post()).json()).toEqual({ notifications: [notice({ publishedAt: 'x' })] })
  })

  it('refuses a script without exactly one of the two', async () => {
    expect((await controlPost('script', {})).status).toBe(400)
    expect((await controlPost('script', { notifications: [], response: {} })).status).toBe(400)
    expect((await controlPost('script', { notifications: {} })).status).toBe(400)
  })

  it('logs each notice request with the exact body and leaves the control requests out', async () => {
    const before = Date.now()
    await post()
    await post('not json', '/other')
    expect(fake.requests).toHaveLength(2)
    expect((await controlPost('clear-requests', {})).status).toBe(200)
    await post()
    await fetch(`${fake.url}/`, { method: 'GET' })
    const logged = await (await fetch(`${fake.url}/__control/requests`)).json() as typeof fake.requests
    expect(logged).toHaveLength(2)
    expect(logged[0]).toMatchObject({ method: 'POST', path: '/', contentType: 'application/json', bodyText: QUERY, json: JSON.parse(QUERY) })
    expect(logged[0].receivedAt).toBeGreaterThanOrEqual(before)
    expect(logged[1]).toMatchObject({ method: 'GET', path: '/', bodyText: '' })
    expect(logged[1]).not.toHaveProperty('json')
    expect(fake.requests).toEqual(logged)
  })

  it('logs a body that is not JSON as its text only', async () => {
    await post('{"broken"')
    expect(fake.requests[0].bodyText).toBe('{"broken"')
    expect(fake.requests[0]).not.toHaveProperty('json')
  })

  it('answers 405 to anything but a POST', async () => {
    expect((await fetch(`${fake.url}/`, { method: 'GET' })).status).toBe(405)
  })

  it('gives the next requests the faults in the order they were queued', async () => {
    fake.setNotifications([notice({ publishedAt: '2025-01-01T00:00:00Z' })])
    fake.inject({ kind: 'status', count: 2, status: 500 })
    fake.inject({ kind: 'notJson', count: 1 })
    fake.inject({ kind: 'status', count: 1, status: 503, body: 'down' })
    const first = await post()
    expect([first.status, await first.json()]).toEqual([500, { error: 'Internal Server Error' }])
    expect((await post()).status).toBe(500)
    const third = await post()
    expect(third.status).toBe(200)
    await expect(third.clone().json()).rejects.toThrow()
    const fourth = await post()
    expect([fourth.status, await fourth.text()]).toEqual([503, 'down'])
    expect(await (await post()).json()).toEqual({ notifications: [notice({ publishedAt: '2025-01-01T00:00:00Z' })] })
    expect(fake.requests).toHaveLength(5)
  })

  it('takes faults through the control endpoint and refuses malformed ones', async () => {
    expect((await controlPost('faults', { kind: 'status', count: 1, status: 502 })).status).toBe(200)
    expect((await post()).status).toBe(502)
    for (const bad of [
      { kind: 'status', count: 1, status: 99 },
      { kind: 'status', count: 0, status: 500 },
      { kind: 'status', count: 1, status: 500, body: 1 },
      { kind: 'delay', count: 1, delayMs: MAX_DELAY_MS + 1 },
      { kind: 'delay', count: 1, delayMs: -1 },
      { kind: 'other', count: 1 },
    ]) {
      expect((await controlPost('faults', bad)).status, JSON.stringify(bad)).toBe(400)
      expect(() => checkedFault(bad)).toThrow()
    }
    expect(() => fake.inject({ kind: 'notJson', count: 1.5 })).toThrow(/count/)
  })

  it('answers a delayed request after the delay', async () => {
    fake.setNotifications([])
    fake.inject({ kind: 'delay', count: 1, delayMs: 300 })
    const start = Date.now()
    const response = await post()
    expect(Date.now() - start).toBeGreaterThanOrEqual(250)
    expect(await response.json()).toEqual({ notifications: [] })
    // The fault is used up: the next request is not held.
    await post()
    expect(fake.requests).toHaveLength(2)
  })

  it('closes at once with a delayed answer pending', async () => {
    fake.inject({ kind: 'delay', count: 1, delayMs: MAX_DELAY_MS })
    const pending = post().then(() => 'answered', () => 'failed')
    // Waits until the request has arrived before closing.
    const deadline = Date.now() + 5_000
    while (fake.requests.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    const start = Date.now()
    await fake.close()
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(await pending).toBe('failed')
    fake = await startFakeNotification()
  })

  it('goes back to the default on reset', async () => {
    fake.setNotifications([notice({ publishedAt: 'x' })])
    fake.inject({ kind: 'status', count: 5, status: 500 })
    await post()
    expect((await controlPost('reset', {})).status).toBe(200)
    expect(fake.requests).toHaveLength(0)
    const response = await post()
    expect([response.status, await response.json()]).toEqual([200, { notifications: [] }])
  })

  it('answers 404 to an unknown control endpoint', async () => {
    expect((await controlPost('nothing', {})).status).toBe(404)
  })
})
