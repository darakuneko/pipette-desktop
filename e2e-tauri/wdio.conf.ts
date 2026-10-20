// SPDX-License-Identifier: GPL-2.0-or-later
//
// WebdriverIO configuration of the Tauri build's e2e tests
// (`pnpm test:e2e:tauri`). Each spec file is one session: tauri-driver starts
// the debug build (`pnpm tauri:build:debug`, which has the dev-tools commands
// the tests drive the virtual keyboard with) with a userData directory of its
// own. On Linux it needs WebKitWebDriver on PATH and a display (CI runs it
// under xvfb-run and dbus-run-session). The window-state test needs a screen
// of at least 1600x1160 (CI's Xvfb screen is 1920x1200) and is skipped on a
// smaller one. The app is a single instance per
// D-Bus session bus: while a Tauri build of Pipette runs on the desktop's
// bus, run the tests under dbus-run-session, or every launch hands over to
// that app and exits.
//
// PIPETTE_E2E_SHARD=<index>/<total> runs one shard of the specs
// (helpers/shard.ts); CI runs each shard as a job of its own, since the
// driver's ports and the app's single-instance name allow one run per
// display and session bus. Without it every spec runs.

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Options } from '@wdio/types'
import { APP_BINARY, DRIVER_HOST, DRIVER_PORT, startDriver, stopDriver } from './helpers/driver'
import { startHubDriver, stopHubHarness } from './helpers/hub-harness'
import { startResidentDriver, stopResidentHarness } from './helpers/resident-harness'
import { parseShard, shardSpecs } from './helpers/shard'
import { startSyncDriver, stopSyncHarness } from './helpers/sync-harness'
import { startUpdaterDriver, stopUpdaterHarness } from './helpers/updater-harness'

const SYNC_SPEC = '/specs/sync.e2e.ts'
const HUB_SPEC = '/specs/hub.e2e.ts'
const RESIDENT_SPEC = '/specs/resident.e2e.ts'
const UPDATER_SPEC = '/specs/updater.e2e.ts'

const SPECS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'specs')

function specFiles(): string[] {
  const shard = parseShard(process.env.PIPETTE_E2E_SHARD)
  if (!shard) return ['./specs/**/*.e2e.ts']
  const all = readdirSync(SPECS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.e2e.ts'))
    .sort()
  return shardSpecs(all, shard).map((name) => join(SPECS_DIR, name))
}

/** Whether a test of the current session failed; afterTest and afterSession
 *  run in the same worker. */
let sessionFailed = false

export const config: Options.Testrunner & { capabilities: WebdriverIO.Capabilities[] } = {
  runner: 'local',
  hostname: DRIVER_HOST,
  port: DRIVER_PORT,
  specs: specFiles(),
  maxInstances: 1,
  capabilities: [
    {
      // WebKitWebDriver speaks WebDriver classic only.
      'wdio:enforceWebDriverClassic': true,
      'tauri:options': { application: APP_BINARY },
    } as WebdriverIO.Capabilities,
  ],
  // The display comes from the caller (xvfb-run on CI, the desktop session
  // locally), never from the runner.
  autoXvfb: false,
  logLevel: 'warn',
  waitforTimeout: 15_000,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60_000,
  },

  onPrepare() {
    if (!existsSync(APP_BINARY)) {
      throw new Error(`${APP_BINARY} does not exist. Build it first with \`pnpm tauri:build:debug\`.`)
    }
  },

  // The sync spec's app talks to a fake Drive the worker runs
  // (helpers/sync-harness.ts), the Hub spec's to a fake Hub
  // (helpers/hub-harness.ts), the resident spec's to a fake notice server
  // (helpers/resident-harness.ts), the updater spec's to a fake update
  // server and a fake notice server (helpers/updater-harness.ts); every
  // other spec's app has no sync endpoints, no update manifest, and a Hub
  // and notice address nothing listens on.
  async beforeSession(_config, _capabilities, specs) {
    sessionFailed = false
    if (specs.some((spec) => spec.endsWith(SYNC_SPEC))) await startSyncDriver()
    else if (specs.some((spec) => spec.endsWith(HUB_SPEC))) await startHubDriver()
    else if (specs.some((spec) => spec.endsWith(RESIDENT_SPEC))) await startResidentDriver()
    else if (specs.some((spec) => spec.endsWith(UPDATER_SPEC))) await startUpdaterDriver()
    else await startDriver()
  },

  afterTest(_test, _context, result) {
    if (!result.passed) sessionFailed = true
  },

  async afterSession() {
    try {
      await stopDriver({ keepUserData: sessionFailed })
    } finally {
      await Promise.all([stopSyncHarness(), stopHubHarness(), stopResidentHarness(), stopUpdaterHarness()])
    }
  },
}
