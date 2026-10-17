// SPDX-License-Identifier: GPL-2.0-or-later
// The environment every e2e session's app gets: a Hub on the loopback
// interface and the e2e mark, whatever the session or the shell adds.

import { describe, expect, it } from 'vitest'
import { E2E_HUB_URL, appEnv, isLoopbackUrl } from '../driver'

describe('appEnv', () => {
  it('points the Hub at the loopback interface and marks the run', () => {
    const env = appEnv('/tmp/user-data', {})
    expect(env.PIPETTE_HUB_URL).toBe(E2E_HUB_URL)
    expect(env.PIPETTE_E2E).toBe('1')
    expect(env.PIPETTE_HUB_TEST).toBe('1')
    expect(env.PIPETTE_USER_DATA_DIR).toBe('/tmp/user-data')
  })

  it('takes a session Hub on the loopback interface', () => {
    expect(appEnv('/tmp/u', { PIPETTE_HUB_URL: 'http://127.0.0.1:4321' }).PIPETTE_HUB_URL).toBe('http://127.0.0.1:4321')
    expect(appEnv('/tmp/u', { PIPETTE_HUB_URL: 'http://[::1]:4321' }).PIPETTE_HUB_URL).toBe('http://[::1]:4321')
  })

  it('refuses a Hub off the loopback interface or none', () => {
    for (const url of ['https://pipette-hub-worker.keymaps.workers.dev', 'http://localhost:8787', 'http://10.0.0.1', '', 'not a url']) {
      expect(() => appEnv('/tmp/u', { PIPETTE_HUB_URL: url }), url).toThrow(/PIPETTE_HUB_URL/)
    }
  })

  it('keeps the e2e mark whatever a session adds', () => {
    const env = appEnv('/tmp/u', { PIPETTE_E2E: '0', PIPETTE_HUB_TEST: '0', PIPETTE_USER_DATA_DIR: '/elsewhere' })
    expect([env.PIPETTE_E2E, env.PIPETTE_HUB_TEST, env.PIPETTE_USER_DATA_DIR]).toEqual(['1', '1', '/tmp/u'])
  })

  it('tells loopback URLs apart', () => {
    expect(isLoopbackUrl('http://127.0.0.1:9')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.2')).toBe(false)
    expect(isLoopbackUrl('ftp://127.0.0.1')).toBe(false)
    expect(isLoopbackUrl(undefined)).toBe(false)
  })
})
