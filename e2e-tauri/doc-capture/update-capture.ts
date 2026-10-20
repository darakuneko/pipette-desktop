// SPDX-License-Identifier: GPL-2.0-or-later
//
// The update side of the in-app update screenshots (specs/update.ts, which
// wdio.conf.ts starts with this harness): the fake update server of
// scripts/fake-update on 127.0.0.1 announces one release, signed with the
// test-only key the development tools' build verifies with. Nothing reaches
// GitHub, and the capture never installs the release.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeUpdateEnv, startFakeUpdate, type FakeUpdate } from '../../scripts/fake-update/server'
import { startDriver } from '../helpers/driver'

const PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json')

/** The release the screenshots offer: the release of the app's own
 *  pre-release (0.5.0 for 0.5.0-beta.3), or the next patch release of a
 *  release (0.5.1 for 0.5.0). Either is newer than the app. */
export function offeredRelease(): string {
  const version = (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string }).version
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version)
  if (!match) throw new Error(`package.json has the version ${version}`)
  const [, major, minor, patch, pre] = match
  return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${Number(patch) + 1}`
}

let server: FakeUpdate | null = null

/** Starts the fake update server with {@link offeredRelease}, then
 *  tauri-driver with an app that reads its manifest from it. */
export async function startUpdateCaptureDriver(): Promise<void> {
  if (server) throw new Error('the update capture harness is already running')
  try {
    server = await startFakeUpdate()
    server.setRelease({ version: offeredRelease() })
    await startDriver(fakeUpdateEnv(server.url))
  } catch (err) {
    // afterSession does not run for a session that never started.
    await stopUpdateCaptureHarness()
    throw err
  }
}

/** Stops the fake update server, if it runs. */
export async function stopUpdateCaptureHarness(): Promise<void> {
  const running = server
  server = null
  await running?.close()
}
