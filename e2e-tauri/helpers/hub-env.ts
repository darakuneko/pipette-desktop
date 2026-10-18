// SPDX-License-Identifier: GPL-2.0-or-later
//
// The environment of the Hub spec's two sessions, checked before each
// launch: both point the Hub at the fake Hub on 127.0.0.1; the first signs
// in as the Hub test account (`test:<email>`, which the app sends only to a
// Hub on localhost or 127.0.0.1) and has no Google endpoints, the second has
// no test account and every sync variable pointed at the fake Google of the
// fake Drive, so neither session can reach the real Hub or the real Google.
// The checks run on the environment the app gets: the session's variables
// over the worker's own (`appEnv`), so a variable the shell exports cannot
// slip in. Every Hub and Google address must be 127.0.0.1 itself, not
// localhost or [::1].

import { closeSync, openSync, readSync } from 'node:fs'
import { appEnv, isLocalHttpUrl } from './driver'

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

/** Throws unless `env` is the environment of a Hub session of `kind`
 *  against the fake Hub at `hubUrl`. */
export function assertHubEnv(kind: HubSessionKind, env: Record<string, string | undefined>, hubUrl: string): void {
  if (!isLocalHttpUrl(hubUrl)) throw new Error(`the fake Hub must listen on 127.0.0.1, not ${hubUrl}`)
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
    if (!isLocalHttpUrl(env[name])) throw new Error(`${name} must point at 127.0.0.1, not ${String(env[name])}`)
  }
  if (env.PIPETTE_DEV_KEYSTORE !== 'file') throw new Error('PIPETTE_DEV_KEYSTORE must be file')
  if (env.PIPETTE_DEV_SUPPRESS_BROWSER !== '1') throw new Error('PIPETTE_DEV_SUPPRESS_BROWSER must be 1')
}

/** The environment the app of a session with `extra` runs with, checked
 *  as a Hub session of `kind` against the fake Hub at `hubUrl`. */
export function hubSessionEnv(
  kind: HubSessionKind,
  userDataDir: string,
  extra: Record<string, string>,
  hubUrl: string,
): NodeJS.ProcessEnv {
  const env = appEnv(userDataDir, extra)
  assertHubEnv(kind, env, hubUrl)
  return env
}

/** A command only a build with the development tools has: the debug build
 *  without them would take the Hub address too, but answers no dev
 *  command and has no fake-endpoint guard of its own. */
export const DEV_TOOLS_MARKER = 'dev_hub_state'

const SCAN_CHUNK_BYTES = 8 * 1024 * 1024

/** Whether the file at `path` contains the bytes of `marker`, read a chunk
 *  at a time (the debug binary is hundreds of megabytes). */
export function fileContains(path: string, marker: string): boolean {
  const needle = Buffer.from(marker)
  const buffer = Buffer.alloc(SCAN_CHUNK_BYTES + needle.length)
  const fd = openSync(path, 'r')
  try {
    let carried = 0
    for (;;) {
      const read = readSync(fd, buffer, carried, SCAN_CHUNK_BYTES, null)
      if (read === 0) return false
      const filled = carried + read
      if (buffer.subarray(0, filled).includes(needle)) return true
      // Keeps the tail, so a marker across two chunks is found.
      carried = Math.min(needle.length - 1, filled)
      buffer.copy(buffer, 0, filled - carried, filled)
    }
  } finally {
    closeSync(fd)
  }
}

/** Throws unless the binary at `path` is a build with the development
 *  tools; checked before it is launched. */
export function assertDevToolsBinary(path: string): void {
  if (!fileContains(path, DEV_TOOLS_MARKER)) {
    throw new Error(`${path} is not a build with the development tools (no ${DEV_TOOLS_MARKER}); the Hub spec does not start it`)
  }
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
