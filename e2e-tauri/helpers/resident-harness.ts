// SPDX-License-Identifier: GPL-2.0-or-later
//
// The resident spec's session: the Node fake notice server of
// scripts/fake-notification (on 127.0.0.1) runs in the worker and the app
// fetches its startup notices from it, and the app's autostart directory is
// `autostart` inside the session's userData directory (driver.ts refuses
// any other place, and the app writes nowhere else). The notices the app
// finds at its first launch are scripted before it starts.

import { join } from 'node:path'
import {
  fakeNotificationEnv,
  firestoreTimestamp,
  notice,
  startFakeNotification,
  type FakeNotification,
} from '../../scripts/fake-notification/server'
import { AUTOSTART_DIR_VARIABLE, startDriver } from './driver'

const DAY_MS = 24 * 60 * 60 * 1000

let notices: FakeNotification | null = null
/** `Date.now()` right before the session's first launch. */
let launchedAt = 0

/** The running fake notice server. */
export function fakeNotices(): FakeNotification {
  if (!notices) throw new Error('the fake notice server is not running')
  return notices
}

/** `Date.now()` right before the first launch of the session. */
export function firstLaunchAt(): number {
  return launchedAt
}

export interface StartupNotices {
  older: Record<string, unknown>
  newer: Record<string, unknown>
}

let startup: StartupNotices | null = null

/** The two notices of the first launch, the older one as a Firestore
 *  timestamp and the newer one as an ISO string. The server lists the
 *  newer one last, so the modal's order is the app's own sort. Made when
 *  the harness starts, two and one days back. */
export function startupNotices(): StartupNotices {
  if (!startup) throw new Error('the fake notice server is not running')
  return startup
}

/** The autostart directory of a session with userData directory `dir`. */
export function autostartDirOf(dir: string): string {
  return join(dir, 'autostart')
}

/** Starts the fake notice server with the startup notices, then
 *  tauri-driver with a session pointed at it. */
export async function startResidentDriver(): Promise<void> {
  if (notices) throw new Error('the fake notice server is already running')
  const now = Date.now()
  startup = {
    older: notice({ title: 'E2E older notice', body: 'Older', type: 'Info', publishedAt: firestoreTimestamp(now - 2 * DAY_MS) }),
    newer: notice({ title: 'E2E newer notice', body: 'Newer', type: 'Update', publishedAt: new Date(now - DAY_MS).toISOString() }),
  }
  notices = await startFakeNotification()
  notices.setNotifications([startup.older, startup.newer])
  const url = notices.url
  try {
    launchedAt = Date.now()
    await startDriver((dir) => ({ ...fakeNotificationEnv(url), [AUTOSTART_DIR_VARIABLE]: autostartDirOf(dir) }))
  } catch (err) {
    // afterSession does not run for a session that never started.
    await stopResidentHarness()
    throw err
  }
}

/** Stops the fake notice server, if it runs. */
export async function stopResidentHarness(): Promise<void> {
  const running = notices
  notices = null
  await running?.close()
}
