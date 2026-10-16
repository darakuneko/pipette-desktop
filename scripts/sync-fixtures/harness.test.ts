// SPDX-License-Identifier: GPL-2.0-or-later
// The sync fixture harness keeps the Electron sync code away from Google,
// the real userData, the browser and the OS key store, and gives the same
// clock and randomness on every run.
//
// Run: pnpm run test:sync-fixtures-harness

import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, symlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, net, safeStorage, shell } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listFiles } from '../../src/main/sync/google-drive'
import { retryTiming } from '../../src/main/sync/drive-retry'
import { fakeDriveEnv, startFakeDrive } from '../fake-drive/server'
import { FIXED_INSTALLATION_ID, FIXED_NOW, openedUrls, readTree, resetHarness, seedUserData, useUserData } from './harness'

vi.mock('../../src/main/sync/google-auth', () => ({ getAccessToken: async () => 'fixture-token' }))

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

/** A server on 127.0.0.1 that redirects every request to `location`. */
async function redirectingTo(location: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(302, { Location: location })
    res.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('the sync fixture harness', () => {
  it('refuses every request off 127.0.0.1, redirects included', async () => {
    for (const url of [
      'https://www.googleapis.com/drive/v3/files',
      'https://oauth2.googleapis.com/token',
      'https://accounts.google.com/o/oauth2/v2/auth',
      'http://localhost:1/',
      'http://[::1]:1/',
      'http://10.0.0.1/',
    ]) {
      await expect(fetch(url), url).rejects.toThrow(/refused a request/)
      await expect(net.fetch(url), url).rejects.toThrow(/refused a request/)
    }
    const local = await redirectingTo('https://www.googleapis.com/drive/v3/files')
    await expect(fetch(`${local}/x`)).rejects.toThrow(/refused a request to www\.googleapis\.com/)
    await expect(fetch(`${local}/x`, { method: 'POST', body: 'x' })).rejects.toThrow(/refused/)
  })

  it('lets requests to 127.0.0.1 through', async () => {
    const drive = await startFakeDrive()
    try {
      const response = await fetch(`${fakeDriveEnv(drive.url).PIPETTE_DRIVE_API_URL}/files?spaces=appDataFolder`, {
        headers: { Authorization: 'Bearer x' },
      })
      expect(await response.json()).toEqual({ files: [] })
      const local = await redirectingTo(`${drive.url}/drive/v3/files?spaces=appDataFolder`)
      expect((await fetch(`${local}/x`, { headers: { Authorization: 'Bearer x' } })).status).toBe(200)
    } finally {
      await drive.close()
    }
  })

  it('stops the Electron Drive client before it reaches Google', async () => {
    const sleep = retryTiming.sleep
    retryTiming.sleep = async () => {}
    try {
      await expect(listFiles()).rejects.toThrow(/refused a request to www\.googleapis\.com/)
    } finally {
      retryTiming.sleep = sleep
    }
  })

  it('answers app.getPath from the seeded userData only', () => {
    expect(() => app.getPath('userData')).toThrow(/before seedUserData/)
    const dir = seedUserData({ 'sync/favorites/macro/index.json': '{}' })
    expect(app.getPath('userData')).toBe(dir)
    expect(app.getPath('temp')).toBe(`${dir}-paths/temp`)
    expect(readTree(dir)).toEqual({
      'local/installation-id': FIXED_INSTALLATION_ID,
      'sync/favorites/macro/index.json': '{}',
    })
  })

  it('refuses the real userData of Pipette and of Electron', () => {
    for (const dir of ['pipette-desktop', 'pipette-desktop/sync', 'Electron', 'Electron/local']) {
      useUserData(join(homedir(), '.config', dir))
      expect(() => app.getPath('userData'), dir).toThrow(/refused the real userData/)
    }
    // A symlink to it, which seedUserData's directory would never be.
    const seeded = seedUserData()
    const link = join(seeded, 'link')
    symlinkSync(join(homedir(), '.config', 'pipette-desktop'), link)
    useUserData(join(link, 'sub'))
    expect(() => app.getPath('userData')).toThrow(/refused the real userData/)
  })

  it('removes the seeded userData when it resets', () => {
    const dir = seedUserData()
    expect(existsSync(dir)).toBe(true)
    resetHarness()
    expect(existsSync(dir)).toBe(false)
    expect(() => app.getPath('userData')).toThrow(/before seedUserData/)
  })

  it('records the URLs to open and opens none', async () => {
    await shell.openExternal('https://accounts.google.com/o/oauth2/v2/auth?state=x')
    expect(openedUrls()).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?state=x'])
  })

  it('encrypts with a fixed transformation instead of the key store', () => {
    const encrypted = safeStorage.encryptString('secret')
    expect(safeStorage.decryptString(encrypted)).toBe('secret')
    expect(() => safeStorage.decryptString(Buffer.from('other'))).toThrow()
  })

  it('fixes the clock and the randomness, the same after each reset', () => {
    expect(Date.now()).toBe(FIXED_NOW)
    expect(new Date().toISOString()).toBe('2026-10-16T00:00:00.000Z')
    const draw = (): unknown[] => [randomUUID(), randomUUID(), Math.random(), randomBytes(4).toString('hex')]
    const first = draw()
    expect(first.slice(0, 2)).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'])
    expect(first[2]).toBeGreaterThanOrEqual(0)
    expect(first[2]).toBeLessThan(1)
    expect(draw()).not.toEqual(first)
    resetHarness()
    expect(draw()).toEqual(first)
  })
})
