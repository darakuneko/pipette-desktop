// SPDX-License-Identifier: GPL-2.0-or-later
//
// WebdriverIO configuration of the operation guide's screenshot capture
// (`pnpm doc:screenshots`). It drives the same debug build with the
// development tools as the e2e tests (`pnpm tauri:build:debug`), through the
// same tauri-driver harness (helpers/driver.ts): the virtual keyboard only,
// a fresh temporary userData directory per session, and Hub and notice
// addresses nothing listens on. Each spec under ./specs is one session.
//
// The screenshots are taken at the window's default size of 1440x1024: run
// it under an Xvfb screen of exactly that size (the spec refuses any other
// page size), with a session bus of its own, as CI does:
//
//   xvfb-run --auto-servernum --server-args="-screen 0 1440x1024x24" \
//     dbus-run-session -- pnpm doc:screenshots
//
// They go to docs/screenshots, or to PIPETTE_DOC_SCREENSHOT_DIR when that
// names a directory inside the temporary directory (capture-paths.ts).

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@wdio/types'
import { APP_BINARY, DRIVER_HOST, DRIVER_PORT, startDriver, stopDriver } from '../helpers/driver'
import { assertCaptureUserData, screenshotDir } from './capture-paths'

/** Whether a test of the current session failed; afterTest and afterSession
 *  run in the same worker. */
let sessionFailed = false

export const config: Options.Testrunner & { capabilities: WebdriverIO.Capabilities[] } = {
  runner: 'local',
  hostname: DRIVER_HOST,
  port: DRIVER_PORT,
  specs: ['./specs/**/*.ts'],
  maxInstances: 1,
  capabilities: [
    {
      // WebKitWebDriver speaks WebDriver classic only.
      'wdio:enforceWebDriverClassic': true,
      'tauri:options': { application: APP_BINARY },
    } as WebdriverIO.Capabilities,
  ],
  // The display comes from the caller, never from the runner.
  autoXvfb: false,
  logLevel: 'warn',
  waitforTimeout: 15_000,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    // One test walks the whole capture of a spec.
    timeout: 30 * 60_000,
  },

  onPrepare() {
    if (!existsSync(APP_BINARY)) {
      throw new Error(`${APP_BINARY} does not exist. Build it first with \`pnpm tauri:build:debug\`.`)
    }
  },

  // The app starts only when the session is created, after this hook, and
  // only through the tauri-driver it starts. A failed hook does not stop
  // WebdriverIO from creating the session, so every refusal leaves no
  // tauri-driver running: the session then cannot be created and no app
  // opens anything. Refused: a screenshot directory the capture may not
  // write, and a userData directory under a real configuration directory
  // (checked for the temporary directory before the session's directory
  // is made, and for that directory itself).
  async beforeSession() {
    sessionFailed = false
    screenshotDir()
    assertCaptureUserData(join(tmpdir(), 'pipette-doc-capture-check'))
    const session = await startDriver()
    try {
      assertCaptureUserData(session.userDataDir)
    } catch (err) {
      await stopDriver({ keepUserData: true })
      throw err
    }
  },

  afterTest(_test, _context, result) {
    if (!result.passed) sessionFailed = true
  },

  async afterSession() {
    await stopDriver({ keepUserData: sessionFailed })
  },
}
