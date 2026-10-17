// SPDX-License-Identifier: GPL-2.0-or-later
//
// The environment of the Hub spec's two sessions, checked before each
// launch: both point the Hub at the fake Hub on 127.0.0.1; the first signs
// in as the Hub test account (`test:<email>`, which the app sends only to a
// Hub on localhost or 127.0.0.1) and has no Google endpoints, the second has
// no test account and every sync variable pointed at the fake Google of the
// fake Drive, so neither session can reach the real Hub or the real Google.

/** The Hub test account of the first session. */
export const HUB_TEST_ACCOUNT = 'e2e-hub@example.com'

/** The Google endpoint variables of a development build; a session with
 *  any of them needs all four on 127.0.0.1. */
export const GOOGLE_ENDPOINT_VARIABLES = [
  'PIPETTE_DRIVE_API_URL',
  'PIPETTE_DRIVE_UPLOAD_URL',
  'PIPETTE_GOOGLE_AUTH_URL',
  'PIPETTE_GOOGLE_TOKEN_URL',
] as const

export type HubSessionKind = 'testAccount' | 'google'

/** Whether `value` is an http URL on 127.0.0.1. */
function onLoopback(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

/** Throws unless `env` is the environment of a Hub session of `kind`
 *  against the fake Hub at `hubUrl`. */
export function assertHubEnv(kind: HubSessionKind, env: Record<string, string | undefined>, hubUrl: string): void {
  if (!onLoopback(hubUrl)) throw new Error(`the fake Hub must listen on 127.0.0.1, not ${hubUrl}`)
  if (env.PIPETTE_HUB_URL !== hubUrl) {
    throw new Error(`PIPETTE_HUB_URL must be the fake Hub (${hubUrl}), not ${String(env.PIPETTE_HUB_URL)}`)
  }
  if (kind === 'testAccount') {
    if (env.PIPETTE_HUB_TEST_ACCOUNT !== HUB_TEST_ACCOUNT) {
      throw new Error(`PIPETTE_HUB_TEST_ACCOUNT must be ${HUB_TEST_ACCOUNT}, not ${String(env.PIPETTE_HUB_TEST_ACCOUNT)}`)
    }
    for (const name of GOOGLE_ENDPOINT_VARIABLES) {
      if (env[name] !== undefined) throw new Error(`${name} is set in the test account's session`)
    }
    return
  }
  if (env.PIPETTE_HUB_TEST_ACCOUNT !== undefined) throw new Error('PIPETTE_HUB_TEST_ACCOUNT is set in the Google session')
  for (const name of GOOGLE_ENDPOINT_VARIABLES) {
    if (!onLoopback(env[name])) throw new Error(`${name} must point at 127.0.0.1, not ${String(env[name])}`)
  }
  if (env.PIPETTE_DEV_KEYSTORE !== 'file') throw new Error('PIPETTE_DEV_KEYSTORE must be file')
  if (env.PIPETTE_DEV_SUPPRESS_BROWSER !== '1') throw new Error('PIPETTE_DEV_SUPPRESS_BROWSER must be 1')
}

/** What `dev_hub_state` answers (never the token). */
export interface DevHubState {
  base: string
  loopback: boolean
  blocked: boolean
  tokenCached: boolean
  tokenInflight: boolean
  tokenGeneration: number
  displayNamePending: boolean
  startupSyncDone: boolean
  startupSync: { checked: number; updated: number; missingOnHub: number; errors: number } | null
}

/** Throws unless `state` (the answer of `dev_hub_state`, which only a
 *  build with the development tools has) shows the app's Hub at `hubUrl`. */
export function assertHubState(state: unknown, hubUrl: string): asserts state is DevHubState {
  if (typeof state !== 'object' || state === null) throw new Error(`dev_hub_state answered ${JSON.stringify(state)}`)
  const { base, loopback, blocked } = state as Partial<DevHubState>
  if (typeof base !== 'string' || base.replace(/\/$/, '') !== hubUrl.replace(/\/$/, '')) {
    throw new Error(`the app's Hub is ${String(base)}, not the fake Hub ${hubUrl}`)
  }
  if (loopback !== true || blocked !== false) {
    throw new Error(`the app's Hub is not usable on the loopback interface: ${JSON.stringify(state)}`)
  }
}
