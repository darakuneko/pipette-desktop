// SPDX-License-Identifier: GPL-2.0-or-later
// The environment every e2e session's app gets: a Hub and a startup-notice
// server on the loopback interface, an autostart directory only inside the
// session's directory, and the e2e mark, whatever the session or the shell
// adds.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOSTART_DIR_VARIABLE,
  E2E_HUB_URL,
  E2E_NOTIFICATION_URL,
  appEnv,
  assertAutostartDir,
  isLocalHttpUrl,
  isLoopbackUrl,
  realAutostartDirs,
} from '../driver'

describe('appEnv', () => {
  it('points the Hub at the loopback interface and marks the run', () => {
    const env = appEnv('/tmp/user-data', {})
    expect(env.PIPETTE_HUB_URL).toBe(E2E_HUB_URL)
    expect(env.PIPETTE_E2E).toBe('1')
    expect(env.PIPETTE_HUB_TEST).toBe('1')
    expect(env.PIPETTE_DEV_SUPPRESS_BROWSER).toBe('1')
    expect(env.PIPETTE_USER_DATA_DIR).toBe('/tmp/user-data')
  })

  it('takes a session Hub on the loopback interface', () => {
    expect(appEnv('/tmp/u', { PIPETTE_HUB_URL: 'http://127.0.0.1:4321' }).PIPETTE_HUB_URL).toBe('http://127.0.0.1:4321')
    expect(appEnv('/tmp/u', { PIPETTE_HUB_URL: 'http://[::1]:4321' }).PIPETTE_HUB_URL).toBe('http://[::1]:4321')
  })

  it('refuses a Hub off the loopback interface or none', () => {
    for (const url of ['https://pipette-hub-worker.keymaps.workers.dev', 'http://localhost:8787', 'http://10.0.0.1', '', 'not a url']) {
      expect(() => appEnv('/tmp/u', { PIPETTE_HUB_URL: url }), url).toThrow(/PIPETTE_HUB_URL/)
    }
  })

  it('keeps the e2e mark whatever a session adds', () => {
    const env = appEnv('/tmp/u', {
      PIPETTE_E2E: '0',
      PIPETTE_HUB_TEST: '0',
      PIPETTE_DEV_SUPPRESS_BROWSER: '0',
      PIPETTE_USER_DATA_DIR: '/elsewhere',
    })
    expect([env.PIPETTE_E2E, env.PIPETTE_HUB_TEST, env.PIPETTE_DEV_SUPPRESS_BROWSER, env.PIPETTE_USER_DATA_DIR])
      .toEqual(['1', '1', '1', '/tmp/u'])
  })

  it('tells loopback URLs apart', () => {
    expect(isLoopbackUrl('http://127.0.0.1:9')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.2')).toBe(false)
    expect(isLoopbackUrl('ftp://127.0.0.1')).toBe(false)
    expect(isLoopbackUrl(undefined)).toBe(false)
  })
})

describe('appEnv: the startup-notice address', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('points the notices at an address nothing listens on, whatever the shell exports', () => {
    vi.stubEnv('PIPETTE_NOTIFICATION_URL', 'https://getnotifications-svtx62766a-uc.a.run.app')
    expect(appEnv('/tmp/u', {}).PIPETTE_NOTIFICATION_URL).toBe(E2E_NOTIFICATION_URL)
    expect(isLocalHttpUrl(E2E_NOTIFICATION_URL)).toBe(true)
  })

  it('takes a session notice server on 127.0.0.1', () => {
    expect(appEnv('/tmp/u', { PIPETTE_NOTIFICATION_URL: 'http://127.0.0.1:4321' }).PIPETTE_NOTIFICATION_URL)
      .toBe('http://127.0.0.1:4321')
  })

  it('refuses a session notice address that is not http on 127.0.0.1', () => {
    for (const url of [
      'https://getnotifications-svtx62766a-uc.a.run.app',
      'https://127.0.0.1:4321',
      'http://localhost:4321',
      'http://[::1]:4321',
      'http://127.0.0.2',
      '',
      'not a url',
    ]) {
      expect(() => appEnv('/tmp/u', { PIPETTE_NOTIFICATION_URL: url }), url).toThrow(/PIPETTE_NOTIFICATION_URL/)
    }
  })
})

describe('appEnv: the autostart directory', () => {
  let sessionDir: string
  let outsideDir: string

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'pipette-driver-test-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'pipette-driver-test-outside-'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(sessionDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('is left out unless the session names it, whatever the shell exports', () => {
    vi.stubEnv(AUTOSTART_DIR_VARIABLE, join(homedir(), '.config', 'autostart'))
    expect(appEnv(sessionDir, {})).not.toHaveProperty(AUTOSTART_DIR_VARIABLE)
  })

  it('takes a directory inside the session, existing or not yet', () => {
    const missing = join(sessionDir, 'autostart')
    expect(appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: missing })[AUTOSTART_DIR_VARIABLE]).toBe(missing)
    mkdirSync(missing)
    expect(appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: missing })[AUTOSTART_DIR_VARIABLE]).toBe(missing)
    const nested = join(sessionDir, 'a', 'b', 'autostart')
    expect(appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: nested })[AUTOSTART_DIR_VARIABLE]).toBe(nested)
  })

  it('refuses a relative path, the session directory itself and a path outside it', () => {
    for (const dir of ['autostart', '', sessionDir, join(sessionDir, '..'), join(sessionDir, '..', 'elsewhere'), outsideDir, join(outsideDir, 'autostart')]) {
      expect(() => appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: dir }), dir).toThrow(new RegExp(AUTOSTART_DIR_VARIABLE))
    }
  })

  it('refuses the real autostart directory', () => {
    const real = join(homedir(), '.config', 'autostart')
    expect(realAutostartDirs({})).toContain(real)
    expect(() => appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: real })).toThrow(new RegExp(AUTOSTART_DIR_VARIABLE))
  })

  it('refuses a link inside the session that leads outside it, to the real autostart directory included', () => {
    const toOutside = join(sessionDir, 'to-outside')
    symlinkSync(outsideDir, toOutside)
    expect(() => appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: toOutside })).toThrow(/inside the session/)
    expect(() => appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: join(toOutside, 'autostart') })).toThrow(/inside the session/)
    // The link is only read, never written through. It is refused whether
    // the real directory exists (the link leads outside) or not (dangling).
    const toReal = join(sessionDir, 'to-real')
    symlinkSync(join(homedir(), '.config', 'autostart'), toReal)
    expect(() => appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: toReal })).toThrow(new RegExp(AUTOSTART_DIR_VARIABLE))
    const home = join(outsideDir, 'home')
    const toHome = join(sessionDir, 'to-home')
    symlinkSync(join(home, '.config', 'autostart'), toHome)
    expect(() => appEnv(sessionDir, { HOME: home, [AUTOSTART_DIR_VARIABLE]: toHome })).toThrow(/cannot be resolved/)
    mkdirSync(join(home, '.config', 'autostart'), { recursive: true })
    expect(() => appEnv(sessionDir, { HOME: home, [AUTOSTART_DIR_VARIABLE]: toHome })).toThrow(/inside the session/)
  })

  it('refuses . and .. components, which a link could carry out of the session', () => {
    // <session>/link -> <home>/.config: `link/../.config/autostart` reads as
    // <session>/.config/autostart, but the filesystem follows the link
    // first and reaches <home>/.config/autostart.
    const home = join(outsideDir, 'home')
    mkdirSync(join(home, '.config'), { recursive: true })
    const link = join(sessionDir, 'link')
    symlinkSync(join(home, '.config'), link)
    for (const dir of [`${link}/../.config/autostart`, `${sessionDir}/./autostart`, `${sessionDir}/a/../autostart`]) {
      expect(() => appEnv(sessionDir, { HOME: home, [AUTOSTART_DIR_VARIABLE]: dir }), dir).toThrow(/\. or \.\. components/)
    }
  })

  it('passes the app the normalized path it checked', () => {
    const dir = `${sessionDir}//autostart/`
    expect(appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: dir })[AUTOSTART_DIR_VARIABLE]).toBe(join(sessionDir, 'autostart'))
  })

  it('names a session directory that does not exist', () => {
    const missing = join(outsideDir, 'no-session')
    expect(() => appEnv(missing, { [AUTOSTART_DIR_VARIABLE]: join(missing, 'autostart') })).toThrow(/session's directory .* cannot be resolved/)
  })

  it('refuses a dangling link', () => {
    const dangling = join(sessionDir, 'dangling')
    symlinkSync(join(outsideDir, 'missing'), dangling)
    expect(() => appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: dangling })).toThrow(/PIPETTE_DEV_AUTOSTART_DIR cannot be resolved/)
    expect(() => appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: join(dangling, 'autostart') }))
      .toThrow(/PIPETTE_DEV_AUTOSTART_DIR cannot be resolved/)
  })

  it('refuses a link loop', () => {
    const loop = join(sessionDir, 'loop')
    symlinkSync(loop, loop)
    expect(() => appEnv(sessionDir, { [AUTOSTART_DIR_VARIABLE]: join(loop, 'autostart') })).toThrow(/PIPETTE_DEV_AUTOSTART_DIR cannot be resolved/)
  })

  it('refuses the autostart directory of the home the app gets, directly or through a link', () => {
    const home = join(sessionDir, 'home')
    const autostart = join(home, '.config', 'autostart')
    mkdirSync(autostart, { recursive: true })
    expect(() => appEnv(sessionDir, { HOME: home, [AUTOSTART_DIR_VARIABLE]: autostart })).toThrow(/real autostart/)
    const link = join(sessionDir, 'link')
    symlinkSync(autostart, link)
    expect(() => appEnv(sessionDir, { HOME: home, [AUTOSTART_DIR_VARIABLE]: link })).toThrow(/real autostart/)
    expect(() => appEnv(sessionDir, { HOME: home, [AUTOSTART_DIR_VARIABLE]: join(link, 'sub') })).toThrow(/real autostart/)
    const config = join(sessionDir, 'xdg')
    expect(() => appEnv(sessionDir, { XDG_CONFIG_HOME: config, [AUTOSTART_DIR_VARIABLE]: join(config, 'autostart') }))
      .toThrow(/real autostart/)
  })

  it('checks a resolved session directory', () => {
    const linkedSession = join(outsideDir, 'session-link')
    symlinkSync(sessionDir, linkedSession)
    expect(() => assertAutostartDir(join(linkedSession, 'autostart'), sessionDir, [])).not.toThrow()
    expect(() => assertAutostartDir(join(sessionDir, 'autostart'), linkedSession, [])).not.toThrow()
  })
})
