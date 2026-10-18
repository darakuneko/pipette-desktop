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
//
// `pnpm doc:screenshots` runs every spec: the main capture
// (specs/doc-capture.ts, numbered and named screenshots) and the captures
// of one area each (the other specs, named screenshots only). One area
// alone:
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/<area>.ts

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Options } from '@wdio/types'
import { APP_BINARY, DRIVER_HOST, DRIVER_PORT, startDriver, stopDriver, userDataPath } from '../helpers/driver'
import { startHubDriver, stopHubHarness } from '../helpers/hub-harness'
import { assertCaptureUserData, screenshotDir } from './capture-paths'

/** The specs whose app talks to the fake Hub of scripts/fake-hub, signed in
 *  as the Hub test account (helpers/hub-harness.ts): their screenshots show
 *  the Hub's actions and search results. Every other spec's app has a Hub
 *  address nothing listens on. */
const HUB_SPECS = ['hub.ts', 'key-labels.ts', 'language-packs.ts', 'theme-packs.ts'].map((name) => `/specs/${name}`)

const PORT_CHECK_TIMEOUT_MS = 2_000

/** Whether something accepts connections on `host:port`. No answer within
 *  {@link PORT_CHECK_TIMEOUT_MS} counts as in use. */
function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (inUse: boolean): void => {
      socket.destroy()
      resolve(inUse)
    }
    socket.setTimeout(PORT_CHECK_TIMEOUT_MS, () => done(true))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Ends the worker for a refused run, so WebdriverIO never creates a
 *  session. The driver harness's exit handler stops what the session
 *  started. */
function refuse(err: unknown): never {
  console.error(`doc capture refused: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

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
  // only through a WebDriver server on DRIVER_HOST:DRIVER_PORT. A failed
  // hook does not stop WebdriverIO from creating the session, so a refusal
  // ends the worker instead ({@link refuse}). Refused: a screenshot
  // directory the capture may not write, a userData directory under a real
  // configuration directory (checked for the temporary directory before the
  // session's directory is made, and for that directory itself), and a
  // port another server already listens on (it would start the app without
  // the session's directory).
  async beforeSession(_config, _capabilities, specs) {
    sessionFailed = false
    try {
      screenshotDir()
      assertCaptureUserData(join(tmpdir(), 'pipette-doc-capture-check'))
      if (await portInUse(DRIVER_HOST, DRIVER_PORT)) {
        throw new Error(`something already listens on ${DRIVER_HOST}:${DRIVER_PORT}; stop it before the capture`)
      }
      if (specs.some((spec) => HUB_SPECS.some((hubSpec) => spec.endsWith(hubSpec)))) await startHubDriver()
      else await startDriver()
    } catch (err) {
      refuse(err)
    }
    try {
      assertCaptureUserData(userDataPath())
    } catch (err) {
      await stopDriver({ keepUserData: true })
      refuse(err)
    }
  },

  afterTest(_test, _context, result) {
    if (!result.passed) sessionFailed = true
  },

  async afterSession() {
    try {
      await stopDriver({ keepUserData: sessionFailed })
    } finally {
      await stopHubHarness()
    }
  },
}
