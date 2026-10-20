// SPDX-License-Identifier: GPL-2.0-or-later
// The fake update server: loopback only, the manifest of every platform
// and the file it names, signed with the test-only key, the tampered
// releases, 204 and a body that is not JSON, through the programmatic API
// and the control endpoints.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifySignature } from '../update-manifest/minisign'
import { FAKE_PLATFORMS, UPDATE_FILE, fakeUpdateEnv, payloadOf, startFakeUpdate, type FakeUpdate } from './server'
import { TEST_ONLY_PUBKEY } from './test-only-signer'

let fake: FakeUpdate

beforeEach(async () => {
  fake = await startFakeUpdate()
})

afterEach(async () => {
  await fake.close()
})

interface Manifest {
  version: string
  platforms: Record<string, { url: string; signature: string }>
}

async function manifest(): Promise<Manifest> {
  const res = await fetch(fake.manifestUrl)
  expect(res.status).toBe(200)
  return (await res.json()) as Manifest
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url)
  expect(res.status).toBe(200)
  return Buffer.from(await res.arrayBuffer())
}

describe('fake update server', () => {
  it('listens on 127.0.0.1 and points the app at itself with the test key', () => {
    expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(fakeUpdateEnv(fake.url)).toEqual({
      PIPETTE_UPDATER_MANIFEST_URL: `${fake.url}/manifest.json`,
      PIPETTE_DEV_UPDATER_PUBKEY: TEST_ONLY_PUBKEY,
    })
  })

  it('answers 204 without a release', async () => {
    expect((await fetch(fake.manifestUrl)).status).toBe(204)
  })

  it('serves a signed release for every platform', async () => {
    fake.setRelease({ version: '0.5.0-beta.3' })
    const served = await manifest()
    expect(served.version).toBe('0.5.0-beta.3')
    expect(Object.keys(served.platforms)).toEqual([...FAKE_PLATFORMS])
    const entry = served.platforms['linux-x86_64']
    expect(entry.url).toBe(`${fake.url}/download/${UPDATE_FILE}`)
    const data = await download(entry.url)
    expect(data).toEqual(payloadOf('0.5.0-beta.3'))
    verifySignature(data, entry.signature, TEST_ONLY_PUBKEY, '0.5.0-beta.3')
    expect(fake.requests.map((r) => r.path)).toEqual(['/manifest.json', `/download/${UPDATE_FILE}`])
  })

  it('serves the tampered releases', async () => {
    fake.setRelease({ version: '0.5.0-beta.3', tamper: 'signature' })
    let entry = (await manifest()).platforms['darwin-aarch64']
    expect(() => verifySignature(payloadOf('0.5.0-beta.3'), entry.signature, TEST_ONLY_PUBKEY, '0.5.0-beta.3')).toThrow('does not verify')
    fake.setRelease({ version: '0.5.0-beta.3', tamper: 'version' })
    entry = (await manifest()).platforms['darwin-aarch64']
    expect(() => verifySignature(payloadOf('0.5.0-beta.3'), entry.signature, TEST_ONLY_PUBKEY, '0.5.0-beta.3')).toThrow('signed for version 0.0.1')
  })

  it('answers 204 or a body that is not JSON when told to', async () => {
    fake.setRelease({ version: '0.5.0-beta.3' })
    fake.setMode('noContent')
    expect((await fetch(fake.manifestUrl)).status).toBe(204)
    fake.setMode('notJson')
    const res = await fetch(fake.manifestUrl)
    expect(res.status).toBe(200)
    await expect(res.json()).rejects.toThrow()
  })

  it('takes the same through the control endpoints', async () => {
    const control = (path: string, body: unknown) =>
      fetch(`${fake.url}/__control/${path}`, { method: 'POST', body: JSON.stringify(body) })
    expect((await control('release', { version: '0.5.0-beta.4' })).status).toBe(200)
    expect((await manifest()).version).toBe('0.5.0-beta.4')
    await control('mode', { mode: 'noContent' })
    expect((await fetch(fake.manifestUrl)).status).toBe(204)
    const log = (await (await fetch(`${fake.url}/__control/requests`)).json()) as unknown[]
    expect(log).toHaveLength(2)
    await control('reset', {})
    expect((await fetch(fake.manifestUrl)).status).toBe(204)
    expect(fake.requests).toHaveLength(1)
  })
})
