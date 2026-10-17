// SPDX-License-Identifier: GPL-2.0-or-later
// The Hub fixture harness keeps the Electron Hub code away from the real
// Hub, Google and the real userData, and gives the same bytes on every
// run.
//
// Run: pnpm run test:hub-fixtures-harness

import { symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { HUB_API_DEFAULT, getHubApiBase } from '../../src/main/hub/hub-base'
import { fetchAuthMe, fetchMyPosts, uploadFeaturePostToHub, Hub429Error } from '../../src/main/hub/hub-client'
import { fetchI18nPostList } from '../../src/main/hub/hub-i18n'
import { downloadKeyLabel } from '../../src/main/hub/hub-key-labels'
import { getIdToken } from '../../src/main/sync/google-auth'
import { getMachineHash } from '../../src/main/typing-analytics/machine-hash'
import { FIXED_NOW, seedUserData, useUserData } from '../sync-fixtures/harness'
import {
  FAKE_ID_TOKEN,
  FIXED_MACHINE_HASH,
  HUB_BASE,
  scriptedFetch,
  setIdToken,
  setRules,
  readSafeTree,
  settledTree,
  takeRecorded,
  unusedRules,
  withRecordedHubSleeps,
} from './hub-harness'
import { multipartParts } from './request-log'

const guarded = globalThis.fetch

afterEach(() => {
  globalThis.fetch = guarded
})

describe('the hub fixture harness', () => {
  it('refuses the real Hub and Google, with and without the override', async () => {
    expect(getHubApiBase()).toBe(HUB_BASE)
    for (const url of [
      `${HUB_API_DEFAULT}/api/auth/me`,
      'https://pipette-hub-worker.keymaps.workers.dev/api/files',
      'https://oauth2.googleapis.com/token',
      'http://localhost:9/api/auth/me',
      'http://[::1]:9/',
    ]) {
      await expect(fetch(url), url).rejects.toThrow(/refused a request/)
    }

    // Without the override the Electron code goes to the real Hub, and
    // the guarded fetch stops it before connecting.
    delete process.env.PIPETTE_HUB_URL
    expect(getHubApiBase()).toBe(HUB_API_DEFAULT)
    await expect(fetchAuthMe('jwt')).rejects.toThrow(/refused a request to pipette-hub-worker\.keymaps\.workers\.dev/)
    await expect(downloadKeyLabel('abc')).rejects.toThrow(/refused a request/)
    // The override is ignored without PIPETTE_HUB_TEST (a release build).
    process.env.PIPETTE_HUB_URL = HUB_BASE
    delete process.env.PIPETTE_HUB_TEST
    expect(getHubApiBase()).toBe(HUB_API_DEFAULT)
    await expect(fetchI18nPostList({})).rejects.toThrow(/refused a request/)
  })

  it('answers scripted requests to the loopback Hub only', async () => {
    globalThis.fetch = scriptedFetch()
    setRules([{ method: 'GET', path: '/api/auth/me', responses: [{ status: 200, json: { ok: true, data: { id: 'u1' } } }] }])
    expect(await fetchAuthMe('jwt-1')).toEqual({ id: 'u1' })
    // No rule answers a second request; nothing goes out.
    await expect(fetchAuthMe('jwt-1')).rejects.toThrow(/no rule answers GET \/api\/auth\/me/)
    await expect(fetch(`${HUB_API_DEFAULT}/api/auth/me`)).rejects.toThrow(/refused a request/)
    expect(unusedRules()).toEqual([])
    const { requests } = takeRecorded()
    expect(requests).toEqual([
      { method: 'GET', path: '/api/auth/me', query: [], headers: { authorization: 'Bearer jwt-1' } },
      { method: 'GET', path: '/api/auth/me', query: [], headers: { authorization: 'Bearer jwt-1' } },
    ])
  })

  it('records a multipart body with its boundary as a template', async () => {
    globalThis.fetch = scriptedFetch()
    setRules([{ method: 'POST', path: '/api/files', responses: [{ status: 200, json: { ok: true, data: { id: 'p1', title: 't' } } }] }])
    await uploadFeaturePostToHub('jwt', 'Title\r\nline', 'macro', { name: 'macro.json', data: Buffer.from([0x7b, 0xff, 0x7d]) })
    const [request] = takeRecorded().requests
    expect(request.headers['content-type']).toBe('multipart/form-data')
    if (request.body === undefined || !('multipart' in request.body)) throw new Error('not multipart')
    const { boundary, parts, normalized } = request.body.multipart
    expect(boundary).toBe('----PipetteBoundary{now}')
    expect(parts.map((part) => part.headers)).toEqual([
      'Content-Disposition: form-data; name="title"',
      'Content-Disposition: form-data; name="post_type"',
      'Content-Disposition: form-data; name="json"; filename="macro.json"\r\nContent-Type: application/json',
    ])
    expect(parts[0].text).toBe('Title line')
    expect(parts[2].base64).toBe(Buffer.from([0x7b, 0xff, 0x7d]).toString('base64'))
    expect(Buffer.from(normalized, 'base64').toString('latin1')).toMatch(/^--\{boundary\}\r\n/)
    expect(() => multipartParts(Buffer.from('x'), 'b')).toThrow(/not a multipart body/)
  })

  it('records the waits of a 429 and does not sleep', async () => {
    globalThis.fetch = scriptedFetch()
    setRules([
      {
        method: 'GET',
        path: '/api/files/me',
        responses: [
          { status: 429, text: 'slow down', headers: { 'Retry-After': '30' } },
          { status: 200, json: { ok: true, data: { items: [], total: 0, page: 1, per_page: 20 } } },
          { status: 429, text: 'daily', headers: { 'Retry-After': '86400' } },
        ],
      },
    ])
    const started = performance.now()
    const result = await withRecordedHubSleeps(async () => {
      const first = await fetchMyPosts('jwt')
      const second = await fetchMyPosts('jwt').catch((err: unknown) => err)
      return [first, second]
    })
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(result[1]).toBeInstanceOf(Hub429Error)
    expect(takeRecorded().sleeps).toEqual([30_000])
  })

  it('answers the fake id_token and nothing from Google', async () => {
    expect(await getIdToken()).toBe(FAKE_ID_TOKEN)
    setIdToken(null)
    expect(await getIdToken()).toBeNull()
  })

  it('refuses the real userData', () => {
    expect(() => app.getPath('userData')).toThrow(/before seedUserData/)
    useUserData(join(homedir(), '.config', 'pipette-desktop'))
    expect(() => app.getPath('userData')).toThrow(/refused the real userData/)
    useUserData(join(homedir(), '.config', 'Electron', 'sync'))
    expect(() => app.getPath('userData')).toThrow(/refused the real userData/)
  })

  it('reads a tree once it stops changing', async () => {
    const dir = seedUserData({ 'a.json': '1' })
    // A write nobody awaits lands after the read starts.
    setTimeout(() => writeFileSync(join(dir, 'b.json'), '2'), 15)
    const tree = await settledTree(dir)
    expect(tree['b.json']).toBe('2')
    expect(Date.now()).toBe(FIXED_NOW)
  })

  it('reads a tree without following symbolic links', async () => {
    const dir = seedUserData({ 'a.json': '1' })
    expect(readSafeTree(dir)['a.json']).toBe('1')
    symlinkSync(join(homedir(), '.config', 'pipette-desktop'), join(dir, 'link'))
    expect(() => readSafeTree(dir)).toThrow(/refused the symbolic link link/)
    await expect(settledTree(dir)).rejects.toThrow(/refused the symbolic link/)
    expect(() => readSafeTree(join(homedir(), '.config', 'pipette-desktop'))).toThrow(/refused the real userData/)
  })

  it('answers a fixed machine hash', async () => {
    expect(await getMachineHash()).toBe(FIXED_MACHINE_HASH)
    expect(FIXED_MACHINE_HASH).toMatch(/^[0-9a-f]{64}$/)
  })
})
