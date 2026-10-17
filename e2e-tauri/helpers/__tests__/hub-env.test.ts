// SPDX-License-Identifier: GPL-2.0-or-later
// The checks the Hub spec runs before each launch and after it: a session
// starts only against the fake Hub on 127.0.0.1, the test account's
// without Google endpoints and the Google session with all of them on
// 127.0.0.1, and goes on only when the app's Hub is the fake Hub.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_TOOLS_MARKER,
  HUB_TEST_ACCOUNT,
  assertDevToolsBinary,
  assertHubEnv,
  assertHubState,
  fileContains,
  hubSessionEnv,
} from '../hub-env'

const HUB = 'http://127.0.0.1:4100'
const GOOGLE = {
  PIPETTE_DRIVE_API_URL: 'http://127.0.0.1:4200/drive/v3',
  PIPETTE_DRIVE_UPLOAD_URL: 'http://127.0.0.1:4200/upload/drive/v3',
  PIPETTE_GOOGLE_AUTH_URL: 'http://127.0.0.1:4200/o/oauth2/v2/auth',
  PIPETTE_GOOGLE_TOKEN_URL: 'http://127.0.0.1:4200/token',
  PIPETTE_DEV_KEYSTORE: 'file',
  PIPETTE_DEV_SUPPRESS_BROWSER: '1',
}

describe('assertHubEnv', () => {
  it('takes the test account session against the fake Hub', () => {
    expect(() => assertHubEnv('testAccount', { PIPETTE_HUB_URL: HUB, PIPETTE_HUB_TEST_ACCOUNT: HUB_TEST_ACCOUNT }, HUB)).not.toThrow()
  })

  it('takes the Google session against the fake Hub and the fake Google', () => {
    expect(() => assertHubEnv('google', { PIPETTE_HUB_URL: HUB, ...GOOGLE }, HUB)).not.toThrow()
  })

  it('refuses a Hub other than the fake Hub', () => {
    for (const url of [undefined, '', 'http://127.0.0.1:9', 'https://pipette-hub-worker.keymaps.workers.dev']) {
      expect(() => assertHubEnv('testAccount', { PIPETTE_HUB_URL: url, PIPETTE_HUB_TEST_ACCOUNT: HUB_TEST_ACCOUNT }, HUB), String(url))
        .toThrow(/PIPETTE_HUB_URL/)
    }
    expect(() => assertHubEnv('testAccount', { PIPETTE_HUB_URL: 'http://localhost:4100' }, 'http://localhost:4100'))
      .toThrow(/127\.0\.0\.1/)
  })

  it('refuses a test account session without the account or with Google endpoints', () => {
    expect(() => assertHubEnv('testAccount', { PIPETTE_HUB_URL: HUB }, HUB)).toThrow(/PIPETTE_HUB_TEST_ACCOUNT/)
    expect(() => assertHubEnv('testAccount', { PIPETTE_HUB_URL: HUB, PIPETTE_HUB_TEST_ACCOUNT: HUB_TEST_ACCOUNT, ...GOOGLE }, HUB))
      .toThrow(/PIPETTE_DRIVE_API_URL/)
  })

  it('refuses a Google session with the test account or a Google endpoint off 127.0.0.1', () => {
    expect(() => assertHubEnv('google', { PIPETTE_HUB_URL: HUB, PIPETTE_HUB_TEST_ACCOUNT: HUB_TEST_ACCOUNT, ...GOOGLE }, HUB))
      .toThrow(/PIPETTE_HUB_TEST_ACCOUNT/)
    for (const name of Object.keys(GOOGLE).filter((key) => key.endsWith('_URL'))) {
      expect(() => assertHubEnv('google', { PIPETTE_HUB_URL: HUB, ...GOOGLE, [name]: undefined }, HUB), name).toThrow(name)
      expect(() => assertHubEnv('google', { PIPETTE_HUB_URL: HUB, ...GOOGLE, [name]: 'https://oauth2.googleapis.com/token' }, HUB), name)
        .toThrow(name)
    }
    expect(() => assertHubEnv('google', { PIPETTE_HUB_URL: HUB, ...GOOGLE, PIPETTE_DEV_KEYSTORE: undefined }, HUB))
      .toThrow(/PIPETTE_DEV_KEYSTORE/)
    expect(() => assertHubEnv('google', { PIPETTE_HUB_URL: HUB, ...GOOGLE, PIPETTE_DEV_SUPPRESS_BROWSER: '0' }, HUB))
      .toThrow(/PIPETTE_DEV_SUPPRESS_BROWSER/)
  })
})

describe('assertHubEnv on hosts', () => {
  it('refuses localhost and [::1] for the Hub and the Google endpoints', () => {
    for (const url of ['http://localhost:4100', 'http://[::1]:4100']) {
      expect(() => assertHubEnv('testAccount', { PIPETTE_HUB_URL: url, PIPETTE_HUB_TEST_ACCOUNT: HUB_TEST_ACCOUNT }, url), url)
        .toThrow(/127\.0\.0\.1/)
      expect(() => assertHubEnv('google', { PIPETTE_HUB_URL: HUB, ...GOOGLE, PIPETTE_GOOGLE_TOKEN_URL: `${url}/token` }, HUB), url)
        .toThrow(/PIPETTE_GOOGLE_TOKEN_URL/)
    }
  })
})

describe('hubSessionEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('answers the app environment of a session it takes', () => {
    const env = hubSessionEnv('testAccount', '/tmp/u', { PIPETTE_HUB_URL: HUB, PIPETTE_HUB_TEST_ACCOUNT: HUB_TEST_ACCOUNT }, HUB)
    expect([env.PIPETTE_HUB_URL, env.PIPETTE_E2E, env.PIPETTE_USER_DATA_DIR]).toEqual([HUB, '1', '/tmp/u'])
  })

  it('refuses a Google endpoint the worker inherits into the test account session', () => {
    vi.stubEnv('PIPETTE_GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token')
    expect(() => hubSessionEnv('testAccount', '/tmp/u', { PIPETTE_HUB_URL: HUB, PIPETTE_HUB_TEST_ACCOUNT: HUB_TEST_ACCOUNT }, HUB))
      .toThrow(/PIPETTE_GOOGLE_TOKEN_URL/)
  })

  it('refuses a test account the worker inherits into the Google session', () => {
    vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', HUB_TEST_ACCOUNT)
    expect(() => hubSessionEnv('google', '/tmp/u', { PIPETTE_HUB_URL: HUB, ...GOOGLE }, HUB)).toThrow(/PIPETTE_HUB_TEST_ACCOUNT/)
  })
})

describe('assertDevToolsBinary', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('finds the marker anywhere in the file, across chunk boundaries too', () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-env-'))
    const path = join(dir, 'app')
    const chunk = 8 * 1024 * 1024
    const bytes = Buffer.alloc(chunk + 64, 0)
    Buffer.from(DEV_TOOLS_MARKER).copy(bytes, chunk - 4)
    writeFileSync(path, bytes)
    expect(fileContains(path, DEV_TOOLS_MARKER)).toBe(true)
    expect(() => assertDevToolsBinary(path)).not.toThrow()
  })

  it('refuses a binary without the marker', () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-env-'))
    const path = join(dir, 'app')
    writeFileSync(path, Buffer.from('a release build: dev_hub_stat'))
    expect(fileContains(path, DEV_TOOLS_MARKER)).toBe(false)
    expect(() => assertDevToolsBinary(path)).toThrow(/development tools/)
  })
})

describe('assertHubState', () => {
  const state = { base: HUB, loopback: true, blocked: false, tokenCached: false }

  it('takes the app whose Hub is the fake Hub', () => {
    expect(() => assertHubState(state, HUB)).not.toThrow()
    expect(() => assertHubState(state, `${HUB}/`)).not.toThrow()
  })

  it('refuses an app whose Hub is another, blocked or not on the loopback interface', () => {
    expect(() => assertHubState({ ...state, base: 'https://pipette-hub-worker.keymaps.workers.dev' }, HUB)).toThrow(/fake Hub/)
    expect(() => assertHubState({ ...state, blocked: true }, HUB)).toThrow(/loopback/)
    expect(() => assertHubState({ ...state, loopback: false }, HUB)).toThrow(/loopback/)
    expect(() => assertHubState(null, HUB)).toThrow(/dev_hub_state/)
  })
})
