// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Hub spec's sessions: the Node fake Hub of scripts/fake-hub (on
// 127.0.0.1) runs in the worker and every app of the spec is pointed at it.
// The first session signs in to the Hub as the Hub test account, whose
// account the harness creates on the fake Hub beforehand without a display
// name; the second has no test account and signs in with the fake Google of
// scripts/fake-drive, which the harness starts for it. Before each launch
// the harness checks that the binary is a build with the development tools
// and the environment the app will get (hub-env.ts), and after it that the
// app's Hub is the fake Hub (`dev_hub_state`), so no session reaches the
// real Hub or Google.

import { browser } from '@wdio/globals'
import { fakeDriveEnv, startFakeDrive, type FakeDrive } from '../../scripts/fake-drive/server'
import { startFakeHub, type FakeHub, type LoggedRequest } from '../../scripts/fake-hub/server'
import type { Fault } from '../../scripts/fake-hub/hub-state'
import { invokeCommand } from './app'
import { APP_BINARY, retireDriver, startDriver } from './driver'
import {
  HUB_TEST_ACCOUNT,
  assertDevToolsBinary,
  assertHubState,
  hubSessionEnv,
  type DevHubState,
  type HubSessionKind,
} from './hub-env'

let hub: FakeHub | null = null
let drive: FakeDrive | null = null

/** The running fake Hub. */
export function fakeHub(): FakeHub {
  if (!hub) throw new Error('the fake Hub is not running')
  return hub
}

const CONTROL_TIMEOUT_MS = 10_000

/** Calls a control endpoint of the fake Hub (`/__control/<path>`, see
 *  scripts/fake-hub/server.ts) and answers its JSON; the request and the
 *  read of its answer give up after {@link CONTROL_TIMEOUT_MS}. */
export async function hubControl<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${fakeHub().url}/__control/${path}`, {
    method: path === 'state' || path === 'requests' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`the fake Hub refused ${path}: ${response.status} ${text}`)
  return JSON.parse(text) as T
}

/** Makes the next requests of the fake Hub fail. */
export function injectHubFault(fault: Fault): Promise<unknown> {
  return hubControl('faults', fault)
}

/** The requests the fake Hub has logged since `from` (an index into its
 *  log). */
export function hubRequestsSince(from: number): LoggedRequest[] {
  return fakeHub().requests.slice(from)
}

function sessionEnv(kind: HubSessionKind): Record<string, string> {
  const base = { PIPETTE_HUB_URL: fakeHub().url }
  if (kind === 'testAccount') return { ...base, PIPETTE_HUB_TEST_ACCOUNT: HUB_TEST_ACCOUNT }
  if (!drive) throw new Error('the fake Google is not running')
  return { ...base, ...fakeDriveEnv(drive.url), PIPETTE_DEV_KEYSTORE: 'file', PIPETTE_DEV_SUPPRESS_BROWSER: '1' }
}

/** The variables of a session of `kind`, once the binary is a build with
 *  the development tools and the app's whole environment is that of a Hub
 *  session of `kind`. */
function checkSession(kind: HubSessionKind): Record<string, string> {
  assertDevToolsBinary(APP_BINARY)
  const env = sessionEnv(kind)
  hubSessionEnv(kind, '/e2e-hub-env-check', env, fakeHub().url)
  return env
}

async function startChecked(kind: HubSessionKind): Promise<void> {
  await startDriver(checkSession(kind))
}

/** Starts the fake Hub with the test account (no display name), then
 *  tauri-driver with the test account's session pointed at it. */
export async function startHubDriver(): Promise<void> {
  if (hub) throw new Error('the fake Hub is already running')
  hub = await startFakeHub()
  try {
    await hubControl('users', { email: HUB_TEST_ACCOUNT, displayName: null })
    await startChecked('testAccount')
  } catch (err) {
    // afterSession does not run for a session that never started.
    await stopHubHarness()
    throw err
  }
}

/** What the app's Hub is (`dev_hub_state`). */
export function hubState(): Promise<DevHubState> {
  return invokeCommand<DevHubState>('dev_hub_state')
}

/** Throws unless the running app has the development tools and its Hub is
 *  the fake Hub. Only that build answers `dev_hub_state`; the spec stops
 *  here otherwise. */
export async function assertHubSession(): Promise<void> {
  let state: unknown
  try {
    state = await invokeCommand<unknown>('dev_hub_state')
  } catch (err) {
    throw new Error(`the app has no development tools (dev_hub_state: ${String(err)}); the Hub spec stops here`)
  }
  assertHubState(state, fakeHub().url)
}

/** Goes on with the second session: ends the running one and starts a new
 *  app with a fresh userData directory, without the test account, pointed
 *  at the fake Hub and at a fake Google started now. */
export async function switchToGoogleSession(): Promise<void> {
  if (!drive) drive = await startFakeDrive()
  // Checked before the running session ends, so a refused one leaves it.
  checkSession('google')
  // Ended while tauri-driver still answers; the reload below then only
  // starts the new session.
  await browser.deleteSession()
  await retireDriver()
  await startChecked('google')
  await browser.reloadSession()
  await assertHubSession()
}

/** Stops the fake Hub and the fake Google, if they run. */
export async function stopHubHarness(): Promise<void> {
  const runningHub = hub
  const runningDrive = drive
  hub = null
  drive = null
  await Promise.all([runningHub?.close(), runningDrive?.close()])
}
