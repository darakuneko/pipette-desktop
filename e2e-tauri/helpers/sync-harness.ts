// SPDX-License-Identifier: GPL-2.0-or-later
//
// The sync spec's sessions: the Node fake Drive of scripts/fake-drive (Drive
// v3 and the Google authorization and token endpoints, on 127.0.0.1) runs in
// the worker, and every app of the spec is pointed at it. A development
// build that has any of the endpoint variables needs all four, and only
// then refuses every destination but loopback (pipette_net); the harness
// checks the whole set before each launch, so a session never starts
// against the real Google endpoints, the OS key store or the system
// browser.

import { browser } from '@wdio/globals'
import { fakeDriveEnv, startFakeDrive, type FakeDrive } from '../../scripts/fake-drive/server'
import type { Fault } from '../../scripts/fake-drive/drive-state'
import { invokeCommand } from './app'
import { retireDriver, startDriver } from './driver'

/** The variables a sync session cannot start without, and the value each
 *  must have; null for a loopback URL. */
const REQUIRED_SYNC_ENV: Record<string, string | null> = {
  PIPETTE_DRIVE_API_URL: null,
  PIPETTE_DRIVE_UPLOAD_URL: null,
  PIPETTE_GOOGLE_AUTH_URL: null,
  PIPETTE_GOOGLE_TOKEN_URL: null,
  PIPETTE_DEV_KEYSTORE: 'file',
  PIPETTE_DEV_SUPPRESS_BROWSER: '1',
}

/** Throws unless `env` has every variable of {@link REQUIRED_SYNC_ENV}, the
 *  endpoints on 127.0.0.1. */
function assertSyncEnv(env: Record<string, string | undefined>): void {
  for (const [name, expected] of Object.entries(REQUIRED_SYNC_ENV)) {
    const value = env[name]
    if (value === undefined || value === '') throw new Error(`${name} is not set; the sync session is not started`)
    if (expected !== null) {
      if (value !== expected) throw new Error(`${name} must be ${expected}, not ${value}`)
    } else if (new URL(value).hostname !== '127.0.0.1') {
      throw new Error(`${name} must point at 127.0.0.1, not ${value}`)
    }
  }
}

let drive: FakeDrive | null = null
let syncEnv: Record<string, string> | null = null

/** The running fake Drive. */
export function fakeDrive(): FakeDrive {
  if (!drive) throw new Error('the fake Drive is not running')
  return drive
}

/** Starts the fake Drive, then tauri-driver with a session pointed at it. */
export async function startSyncDriver(): Promise<void> {
  if (drive) throw new Error('the fake Drive is already running')
  drive = await startFakeDrive()
  try {
    syncEnv = {
      ...fakeDriveEnv(drive.url),
      PIPETTE_DEV_KEYSTORE: 'file',
      PIPETTE_DEV_SUPPRESS_BROWSER: '1',
    }
    assertSyncEnv(syncEnv)
    await startDriver(syncEnv)
  } catch (err) {
    // afterSession does not run for a session that never started.
    await stopSyncHarness()
    throw err
  }
}

/** Throws unless the running app has the development tools. Only their
 *  build reads the endpoint variables; any other build would sync with the
 *  real Google endpoints, so a sync spec checks this before it signs in. */
export async function assertDevToolsBuild(): Promise<void> {
  let state: unknown
  try {
    state = await invokeCommand<unknown>('dev_sync_state')
  } catch (err) {
    throw new Error(`the app has no development tools (dev_sync_state: ${String(err)}); the sync spec stops here`)
  }
  if (typeof state !== 'object' || state === null || !('workRunning' in state)) {
    throw new Error(`dev_sync_state answered ${JSON.stringify(state)}; the sync spec stops here`)
  }
}

/** Stops the fake Drive, if it runs. */
export async function stopSyncHarness(): Promise<void> {
  const running = drive
  drive = null
  syncEnv = null
  await running?.close()
}

/** Goes on as another machine: once the app of the running session has
 *  quit, ends the session and starts a new one with a fresh userData
 *  directory (so another installation id and machine hash), pointed at the
 *  same fake Drive. The app is a single instance, so the two machines run
 *  one after the other. */
export async function switchMachine(): Promise<void> {
  if (!syncEnv) throw new Error('the sync harness is not running')
  assertSyncEnv(syncEnv)
  // Ended while tauri-driver still answers; the reload below then only
  // starts the new session.
  await browser.deleteSession()
  await retireDriver()
  await startDriver(syncEnv)
  await browser.reloadSession()
  await assertDevToolsBuild()
}

/** Makes the next requests of the fake Drive fail, through its control
 *  endpoint. */
export async function injectDriveFault(fault: Fault): Promise<void> {
  const response = await fetch(`${fakeDrive().url}/__control/faults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fault),
  })
  if (!response.ok) throw new Error(`the fake Drive refused the fault: ${response.status}`)
}
