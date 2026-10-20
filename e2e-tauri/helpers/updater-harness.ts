// SPDX-License-Identifier: GPL-2.0-or-later
//
// The updater spec's session: the fake update server of scripts/fake-update
// and the fake notice server of scripts/fake-notification (both on
// 127.0.0.1) run in the worker. The app reads its update manifest from the
// first, verifies with the test-only key, and records an update in
// `fake-install.json` of the session's userData directory instead of
// installing it; it fetches one startup notice from the second, so the
// order of the two modals can be seen.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeNotificationEnv, notice, startFakeNotification, type FakeNotification } from '../../scripts/fake-notification/server'
import { fakeUpdateEnv, startFakeUpdate, type FakeUpdate } from '../../scripts/fake-update/server'
import { startDriver } from './driver'

const DAY_MS = 24 * 60 * 60 * 1000

/** The file a fake install writes, in the session's userData directory. */
export const FAKE_INSTALL_FILE = 'fake-install.json'

/** The title of the startup notice of the first launch. */
export const STARTUP_NOTICE_TITLE = 'E2E updater notice'

const PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json')

/** Two versions above the app's own (package.json): `X.Y.(Z+1)-e2e.1` and
 *  `-e2e.2`, newer than a pre-release and a release of `X.Y.Z` alike. */
export function releasesAboveApp(): { next: string; newer: string } {
  const version = (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string }).version
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) throw new Error(`package.json has the version ${version}`)
  const base = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
  return { next: `${base}-e2e.1`, newer: `${base}-e2e.2` }
}

let updates: FakeUpdate | null = null
let notices: FakeNotification | null = null

export function fakeUpdates(): FakeUpdate {
  if (!updates) throw new Error('the fake update server is not running')
  return updates
}

export function fakeUpdateNotices(): FakeNotification {
  if (!notices) throw new Error('the fake notice server is not running')
  return notices
}

/** Starts both fake servers, the `next` release of {@link releasesAboveApp}
 *  on the update server and one notice on the notice server, then
 *  tauri-driver. */
export async function startUpdaterDriver(): Promise<void> {
  if (updates || notices) throw new Error('the updater harness is already running')
  try {
    updates = await startFakeUpdate()
    updates.setRelease({ version: releasesAboveApp().next })
    notices = await startFakeNotification()
    notices.setNotifications([
      notice({ title: STARTUP_NOTICE_TITLE, body: 'Notice', type: 'Info', publishedAt: new Date(Date.now() - DAY_MS).toISOString() }),
    ])
    const updateUrl = updates.url
    const noticeUrl = notices.url
    await startDriver((dir) => ({
      ...fakeNotificationEnv(noticeUrl),
      ...fakeUpdateEnv(updateUrl),
      PIPETTE_DEV_UPDATER_FAKE_INSTALL: join(dir, FAKE_INSTALL_FILE),
    }))
  } catch (err) {
    // afterSession does not run for a session that never started.
    await stopUpdaterHarness()
    throw err
  }
}

/** Stops the fake servers, if they run. */
export async function stopUpdaterHarness(): Promise<void> {
  const running = [updates, notices]
  updates = null
  notices = null
  await Promise.all(running.map((server) => server?.close()))
}
