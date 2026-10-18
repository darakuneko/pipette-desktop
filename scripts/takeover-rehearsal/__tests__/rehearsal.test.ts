// SPDX-License-Identifier: GPL-2.0-or-later
//
// The rehearsal script's own checks, on temporary directories only: the
// refusals before a launch (with stand-ins for the real home and
// configuration directories), the comparison of a launch without
// operations, and the read rules after a launch with operations. The app is
// a stand-in that changes the copy the way each case needs.

import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { layoutOf, realPathsOf, refusalOf, type Layout, type RealPaths } from '../layout'
import { appEnv, parseArgs, preflight, rehearse, RefusedError, type Launcher, type Options } from '../rehearsal'
import { checkReadable } from '../rules'

const SCRIPT = resolve(__dirname, '../rehearsal.ts')

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(tag: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `pipette-rehearsal-test-${tag}-`)))
  made.push(dir)
  return dir
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** A stand-in for the user's own directories, apart from the rehearsal. */
function fakeReal(): RealPaths {
  const home = tempDir('real-home')
  return realPathsOf(home, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') })
}

/** A rehearsal root holding a copy of a small userData directory and an
 *  autostart entry, and an app file. */
function rehearsalRoot(): { root: string; layout: Layout; app: string } {
  const root = tempDir('root')
  const layout = layoutOf(root)
  write(join(layout.userData, 'config.json'), '{\n\t"autoLaunch": true,\n\t"windowState": {"x": 1}\n}')
  write(join(layout.userData, 'sync/favorites/tapDance/index.json'), '{"entries":[]}')
  write(join(layout.userData, 'logs/pipette-0.log'), '[2026-01-01T00:00:00.000Z] [INFO] old\n')
  write(join(layout.autostart, 'pipette.desktop'), '[Desktop Entry]\nExec="/opt/old"\n')
  const app = join(root, 'app')
  write(app, '')
  return { root, layout, app }
}

function options(root: string, app: string, mode: Options['mode'] = 'launch-only'): Options {
  return { mode, root, app, firejail: false, timeoutMinutes: 1 }
}

/** A launcher that runs `change` on the layout as the app would. */
function fakeApp(layout: Layout, change: (layout: Layout, launch: number) => void): Launcher {
  let launch = 0
  return (env, outputFile) => {
    launch += 1
    expect(env.HOME).toBe(layout.home)
    write(outputFile, '[2026-01-01T00:00:00.000Z] [WARN] something to look at\n')
    change(layout, launch)
    return Promise.resolve(0)
  }
}

const quiet = (): void => {}

describe('refusals before a launch', () => {
  it('accepts a root apart from the real directories', () => {
    const { layout } = rehearsalRoot()
    expect(refusalOf(layout, fakeReal())).toBeNull()
  })

  it('refuses a root inside or holding a real home directory', () => {
    const real = fakeReal()
    const home = real.homes[0]
    expect(refusalOf(layoutOf(join(home, 'rehearsal')), real)).toMatch(/inside the home directory/)
    expect(refusalOf(layoutOf(home), real)).toMatch(/inside the home directory/)
    expect(refusalOf(layoutOf(dirname(home)), real)).toMatch(/holds the home directory/)
  })

  it('refuses a copy whose directories lead into a real directory through a link', () => {
    const real = fakeReal()
    const root = tempDir('linked')
    mkdirSync(join(root, 'home'))
    mkdirSync(real.configs[0], { recursive: true })
    symlinkSync(real.configs[0], join(root, 'home', '.config'))
    expect(refusalOf(layoutOf(root), real)).toMatch(/inside the real directory/)
  })

  it('refuses a missing copy, Singleton files, links and a missing app', () => {
    const real = fakeReal()
    const empty = tempDir('empty')
    expect(() => preflight(options(empty, '/bin/true'), real)).toThrow(/no copy/)

    const singleton = rehearsalRoot()
    write(join(singleton.layout.userData, 'SingletonCookie'), '1')
    expect(() => preflight(options(singleton.root, singleton.app), real)).toThrow(/SingletonCookie/)

    const symlinked = rehearsalRoot()
    symlinkSync(real.homes[0], join(symlinked.layout.userData, 'escape'))
    expect(() => preflight(options(symlinked.root, symlinked.app), real)).toThrow(/symbolic link/)

    const hardLinked = rehearsalRoot()
    const outside = join(tempDir('outside'), 'file')
    write(outside, 'x')
    linkSync(outside, join(hardLinked.layout.userData, 'linked'))
    expect(() => preflight(options(hardLinked.root, hardLinked.app), real)).toThrow(/2 hard links/)

    const noApp = rehearsalRoot()
    expect(() => preflight(options(noApp.root, join(noApp.root, 'missing')), real)).toThrow(/no app/)

    const ok = rehearsalRoot()
    expect(preflight(options(ok.root, ok.app), real).userData).toBe(ok.layout.userData)
  })

  it('the script exits with 2 for a root inside a stand-in HOME, before it starts anything', () => {
    const home = tempDir('cli-home')
    const root = join(home, 'rehearsal')
    const marker = join(home, 'started')
    // The app would leave a file if it ran.
    const app = join(home, 'app.sh')
    write(app, `#!/bin/sh\ntouch ${marker}\n`)
    const run = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, 'launch-only', '--root', root, '--app', app], {
      cwd: resolve(__dirname, '../../..'),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
      timeout: 60_000,
    })
    expect(run.status).toBe(2)
    expect(run.stderr).toMatch(/refused: the rehearsal root .* is inside the home directory/)
    expect(() => readFileSync(marker)).toThrow()
  })

  it('takes absolute paths and a known mode only', () => {
    expect(() => parseArgs(['launch-only', '--root', 'relative', '--app', '/x'])).toThrow(RefusedError)
    expect(() => parseArgs(['other', '--root', '/r', '--app', '/x'])).toThrow(RefusedError)
    expect(() => parseArgs(['operate', '--root', '/r'])).toThrow(RefusedError)
    expect(parseArgs(['operate', '--root', '/r', '--app', '/x', '--firejail'])).toEqual({
      mode: 'operate',
      root: '/r',
      app: '/x',
      firejail: true,
      timeoutMinutes: 120,
    })
  })
})

describe('the environment of the app', () => {
  it('puts every per-user location under the rehearsal and drops inherited Pipette variables', () => {
    const layout = layoutOf('/r')
    const env = appEnv(layout, {
      HOME: '/home/u',
      PIPETTE_USER_DATA_DIR: '/x',
      PIPETTE_DEV_AUTOSTART_DIR: '/y',
      APPIMAGE: '/a',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_CONFIG_HOME: '/home/u/.config',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DISPLAY: ':0',
    })
    expect(env).toMatchObject({
      HOME: '/r/home',
      XDG_CONFIG_HOME: '/r/home/.config',
      XDG_DATA_HOME: '/r/home/.local/share',
      XDG_CACHE_HOME: '/r/home/.cache',
      XDG_STATE_HOME: '/r/home/.local/state',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DISPLAY: ':0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/r/no-session-bus',
      PIPETTE_HUB_TEST: '1',
      PIPETTE_HUB_URL: 'http://127.0.0.1:9',
      PIPETTE_E2E: '1',
    })
    expect(env.PIPETTE_USER_DATA_DIR).toBeUndefined()
    expect(env.PIPETTE_DEV_AUTOSTART_DIR).toBeUndefined()
    expect(env.APPIMAGE).toBeUndefined()
  })
})

/** What a launch of the release does to the copy without operations. */
function expectedLaunch(layout: Layout): void {
  write(join(layout.userData, 'logs/pipette-0.log'), '[2026-01-01T00:00:00.000Z] [INFO] old\n[2026-01-02T00:00:00.000Z] [INFO] new\n')
  write(join(layout.userData, 'logs/pipette-1.log'), 'x\n')
  write(join(layout.userData, 'config.json'), '{\n\t"autoLaunch": true,\n\t"windowState": {"x": 2}\n}')
  write(join(layout.userData, 'local/typing-analytics.db'), 'db')
  write(join(layout.userData, 'local/typing-analytics.db-wal'), 'wal')
  write(join(layout.autostart, 'pipette.desktop'), '[Desktop Entry]\nExec="/r/Pipette.AppImage"\n')
  write(join(layout.home, '.local/share/app.pipette.desktop/webkit'), 'w')
}

describe('a launch without operations', () => {
  it('passes when only the listed files change', async () => {
    const { layout } = rehearsalRoot()
    const report = await rehearse('launch-only', layout, fakeApp(layout, expectedLaunch), quiet)
    expect(report.launches[0].findings.filter((finding) => finding.verdict === 'violation')).toEqual([])
    expect(report.launches[0].findings.find((finding) => finding.path.endsWith('webkit'))?.verdict).toBe('outside')
    expect(report.logLines).toEqual(['[2026-01-01T00:00:00.000Z] [WARN] something to look at'])
    expect(report.passed).toBe(true)
  })

  const violations: [string, (layout: Layout) => void, RegExp][] = [
    ['a removed store file', (l) => unlinkSync(join(l.userData, 'sync/favorites/tapDance/index.json')), /favorites/],
    ['a changed store file', (l) => write(join(l.userData, 'sync/favorites/tapDance/index.json'), '{}'), /favorites/],
    ['a new file in the data', (l) => write(join(l.userData, 'sync/new.json'), '{}'), /sync\/new\.json/],
    ['another config key', (l) => write(join(l.userData, 'config.json'), '{"autoLaunch": false}'), /config\.json/],
    ['a rewritten log', (l) => write(join(l.userData, 'logs/pipette-0.log'), 'rotated\n'), /pipette-0\.log/],
    ['another autostart entry', (l) => write(join(l.autostart, 'other.desktop'), 'x'), /other\.desktop/],
  ]
  for (const [name, change, path] of violations) {
    it(`stops at ${name}`, async () => {
      const { layout } = rehearsalRoot()
      const report = await rehearse(
        'launch-only',
        layout,
        fakeApp(layout, (l) => {
          expectedLaunch(l)
          change(l)
        }),
        quiet,
      )
      const stopped = report.launches[0].findings.filter((finding) => finding.verdict === 'violation')
      expect(stopped.map((finding) => finding.path)).toEqual([expect.stringMatching(path)])
      expect(report.passed).toBe(false)
    })
  }

  it('lets the config store add defaults and reorder keys', async () => {
    const { layout } = rehearsalRoot()
    const report = await rehearse(
      'launch-only',
      layout,
      fakeApp(layout, (l) =>
        write(join(l.userData, 'config.json'), '{\n\t"theme": "system",\n\t"windowState": {"x": 3},\n\t"autoLaunch": true\n}'),
      ),
      quiet,
    )
    expect(report.launches[0].findings).toEqual([
      expect.objectContaining({ verdict: 'allowed', reason: 'windowState; defaults added: theme' }),
    ])
    expect(report.passed).toBe(true)
  })

  it('lets the autostart entry go when autoLaunch is off', async () => {
    const { layout } = rehearsalRoot()
    const report = await rehearse('launch-only', layout, fakeApp(layout, (l) => unlinkSync(join(l.autostart, 'pipette.desktop'))), quiet)
    expect(report.passed).toBe(true)
  })
})

function analyticsDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE minutes (minute INTEGER, keys INTEGER); INSERT INTO minutes VALUES (1, 2), (3, 4);')
  db.close()
}

describe('a launch with operations', () => {
  it('reads every new or changed data file by its kind', async () => {
    const { layout } = rehearsalRoot()
    const report = await rehearse(
      'operate',
      layout,
      fakeApp(layout, (l, launch) => {
        if (launch !== 1) return
        write(join(l.userData, 'sync/favorites/tapDance/index.json'), '{"entries":[{"id":"a"}]}')
        unlinkSync(join(l.userData, 'logs/pipette-0.log'))
        write(join(l.userData, 'sync/keyboards/k/devices/h/days/2026-01-01.jsonl'), '{"a":1}\n{"b":2}\n')
        write(join(l.userData, 'local/installation-id'), 'id')
        analyticsDb(join(l.userData, 'local/typing-analytics.db'))
      }),
      quiet,
    )
    expect(report.launches).toHaveLength(2)
    const byPath = Object.fromEntries(report.readable.map((result) => [result.path.split('/').pop(), result]))
    expect(byPath['index.json'].verdict).toBe('readable')
    expect(byPath['2026-01-01.jsonl']).toMatchObject({ verdict: 'readable', reason: 'JSON Lines, 2 lines' })
    expect(byPath['typing-analytics.db']).toMatchObject({ verdict: 'readable', reason: 'integrity ok; minutes 2' })
    expect(byPath['installation-id'].verdict).toBe('unchecked')
    // The removal is listed for the user to match against the operations.
    expect(report.launches[0].findings).toContainEqual(expect.objectContaining({ change: 'removed', path: '.config/pipette-desktop/logs/pipette-0.log' }))
    expect(report.passed).toBe(true)
  })

  it('stops at a file that cannot be read', async () => {
    const { layout } = rehearsalRoot()
    const report = await rehearse(
      'operate',
      layout,
      fakeApp(layout, (l, launch) => {
        if (launch === 1) write(join(l.userData, 'sync/broken.json'), '{"a":')
      }),
      quiet,
    )
    expect(report.readable).toEqual([expect.objectContaining({ verdict: 'unreadable', path: '.config/pipette-desktop/sync/broken.json' })])
    expect(report.passed).toBe(false)
  })

  it('stops at a change outside the data', async () => {
    const { layout } = rehearsalRoot()
    const report = await rehearse('operate', layout, fakeApp(layout, (l) => write(join(l.autostart, 'other.desktop'), 'x')), quiet)
    expect(report.passed).toBe(false)
  })
})

describe('the read rules', () => {
  it('names the line of a broken JSON Lines file and a broken database', () => {
    const home = tempDir('rules')
    write(join(home, 'a.jsonl'), '{"a":1}\n{oops\n')
    write(join(home, 'b.db'), 'not a database')
    const [lines, db] = checkReadable(home, ['a.jsonl', 'b.db'])
    expect(lines).toMatchObject({ verdict: 'unreadable', reason: expect.stringMatching(/line 2/) })
    expect(db.verdict).toBe('unreadable')
  })
})
