// SPDX-License-Identifier: GPL-2.0-or-later
//
// WebdriverIO configuration of the Tauri build's e2e tests
// (`pnpm test:e2e:tauri`). Each spec file is one session: tauri-driver starts
// the debug build (`pnpm tauri:build:debug`, which has the dev-tools commands
// the tests drive the virtual keyboard with) with a userData directory of its
// own. On Linux it needs WebKitWebDriver on PATH and a display (CI runs it
// under xvfb-run and dbus-run-session). The app is a single instance per
// D-Bus session bus: while a Tauri build of Pipette runs on the desktop's
// bus, run the tests under dbus-run-session, or every launch hands over to
// that app and exits.

import { existsSync } from 'node:fs'
import type { Options } from '@wdio/types'
import { APP_BINARY, DRIVER_HOST, DRIVER_PORT, startDriver, stopDriver } from './helpers/driver'

/** Whether a test of the current session failed; afterTest and afterSession
 *  run in the same worker. */
let sessionFailed = false

export const config: Options.Testrunner & { capabilities: WebdriverIO.Capabilities[] } = {
  runner: 'local',
  hostname: DRIVER_HOST,
  port: DRIVER_PORT,
  specs: ['./specs/**/*.e2e.ts'],
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

  async beforeSession() {
    sessionFailed = false
    await startDriver()
  },

  afterTest(_test, _context, result) {
    if (!result.passed) sessionFailed = true
  },

  async afterSession() {
    await stopDriver({ keepUserData: sessionFailed })
  },
}
