// SPDX-License-Identifier: GPL-2.0-or-later
// The checks the Hub spec runs before each launch and after it: a session
// starts only against the fake Hub on 127.0.0.1, the test account's
// without Google endpoints and the Google session with all of them on
// 127.0.0.1, and goes on only when the app's Hub is the fake Hub.

import { describe, expect, it } from 'vitest'
import { HUB_TEST_ACCOUNT, assertHubEnv, assertHubState } from '../hub-env'

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
