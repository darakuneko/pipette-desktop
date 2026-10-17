// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-autostart: boots Electron's
// src/main/index.ts on the harness with a temporary HOME and records what
// the login-item registration does — at startup (`applyAutoLaunch` with the
// saved `autoLaunch`) and on each `autoLaunch` config change — for Linux
// (the bytes of `$HOME/.config/autostart/pipette.desktop`, with and without
// APPIMAGE and with paths holding spaces, quotes and other characters), for
// an unpackaged build, for Windows / macOS (`setLoginItemSettings`), and
// when the file system refuses.
//
// Run: pnpm run generate:resident-fixtures

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'vitest'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { boot, withPlatformAndEnv } from './boot'
import { changeConfig, useTemporaryHome } from './harness'
import { step, takeRecorded, type Step } from './steps'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-autostart/tests/fixtures/autostart.json')

/** `process.execPath` of the recorded app. */
const EXEC_PATH = '/opt/Pipette/pipette'

/** The autostart directory after a step: each entry, a file with its text
 *  (`pipette.desktop` is written as UTF-8), or a directory. */
function autostartTree(home: string): Record<string, string | null> | 'missing' | 'not a directory' {
  const dir = join(home, '.config', 'autostart')
  if (!existsSync(dir)) return 'missing'
  if (!lstatSync(dir).isDirectory()) return 'not a directory'
  const out: Record<string, string | null> = {}
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    out[name] = lstatSync(path).isDirectory() ? null : readFileSync(path, 'utf8')
  }
  return out
}

interface AutostartStep extends Step {
  autostart: ReturnType<typeof autostartTree>
}

/** Log lines with the temporary HOME written as `$HOME`. Messages that
 *  carry the operating system's error text are marked: only the level and
 *  the prefix up to the error text are meant to match. */
function normalizeLogs(step: Step, home: string): Step {
  if (step.logs === undefined) return step
  const logs = step.logs.map((line) => {
    const message = line.message.split(home).join('$HOME')
    const prefix = 'auto-launch: failed to update Linux autostart entry: '
    return message.startsWith(prefix) ? { level: line.level, message: prefix, osErrorFollows: true } : { level: line.level, message }
  })
  return { ...step, logs }
}

async function autostartStep(home: string, action: Record<string, unknown>, run: () => unknown): Promise<AutostartStep> {
  const recorded = normalizeLogs(await step(action, run), home)
  return { ...recorded, autostart: autostartTree(home) }
}

interface Scenario {
  name: string
  platform: NodeJS.Platform
  isPackaged: boolean
  env: Record<string, string | undefined>
  /** What the temporary HOME holds before the boot. */
  before: string
  boot: AutostartStep
  steps: AutostartStep[]
}

type Prepare = (home: string) => void

const PREPARE: Record<string, Prepare> = {
  'empty HOME': () => undefined,
  'HOME with .config': (home) => mkdirSync(join(home, '.config')),
  'an entry already there': (home) => {
    mkdirSync(join(home, '.config', 'autostart'), { recursive: true })
    writeFileSync(join(home, '.config', 'autostart', 'pipette.desktop'), 'old entry\n')
    writeFileSync(join(home, '.config', 'autostart', 'other.desktop'), 'someone else\n')
  },
  'autostart is a file': (home) => {
    mkdirSync(join(home, '.config'))
    writeFileSync(join(home, '.config', 'autostart'), 'not a directory')
  },
  'pipette.desktop is a directory': (home) => {
    mkdirSync(join(home, '.config', 'autostart', 'pipette.desktop'), { recursive: true })
  },
}

async function scenario(
  name: string,
  options: { platform?: NodeJS.Platform; isPackaged?: boolean; env?: Record<string, string | undefined>; before?: string; autoLaunch: boolean },
  changes: boolean[],
): Promise<Scenario> {
  const platform = options.platform ?? 'linux'
  const isPackaged = options.isPackaged ?? true
  const env = { APPIMAGE: undefined, ...options.env }
  const before = options.before ?? 'empty HOME'
  const home = useTemporaryHome()
  PREPARE[before](home)
  const realExecPath = process.execPath
  Object.defineProperty(process, 'execPath', { value: EXEC_PATH })
  try {
    return await withPlatformAndEnv(platform, env, async () => {
      takeRecorded()
      await boot({ isPackaged, config: { autoLaunch: options.autoLaunch } })
      const { calls, logs } = takeRecorded()
      const bootStep = normalizeLogs(
        {
          action: { boot: { autoLaunch: options.autoLaunch } },
          calls: calls.filter((c) => c.call === 'app.setLoginItemSettings'),
          logs: logs.filter((l) => l.message !== 'Pipette starting'),
        },
        home,
      )
      if (bootStep.logs?.length === 0) delete bootStep.logs
      const afterBoot = autostartTree(home)
      const steps: AutostartStep[] = []
      for (const value of changes) {
        steps.push(await autostartStep(home, { configChange: { key: 'autoLaunch', value } }, () => changeConfig('autoLaunch', value)))
      }
      return { name, platform, isPackaged, env, before, boot: { ...bootStep, autostart: afterBoot }, steps }
    })
  } finally {
    Object.defineProperty(process, 'execPath', { value: realExecPath })
  }
}

const APPIMAGES = [
  '/home/user/Applications/Pipette-1.2.3.AppImage',
  '/home/user/My Apps/Pipette 1.2.3.AppImage',
  '/home/user/"quoted"/Pipette.AppImage',
  '/home/user/$HOME/back\\slash/100%/Pipette.AppImage',
  '/home/user/アプリ/Pipette.AppImage',
  '/home/user/line\nbreak/Pipette.AppImage',
  '',
]

describe('autostart', () => {
  it('records the login-item registration of index.ts', async () => {
    const scenarios: Scenario[] = []
    scenarios.push(await scenario('linux: enable at boot, then off, off again, on', { autoLaunch: true }, [false, false, true]))
    scenarios.push(await scenario('linux: disabled at boot with no entry', { autoLaunch: false }, [true, true]))
    scenarios.push(await scenario('linux: HOME with .config', { autoLaunch: true, before: 'HOME with .config' }, []))
    scenarios.push(await scenario('linux: an entry already there', { autoLaunch: true, before: 'an entry already there' }, [false]))
    scenarios.push(await scenario('linux: disabled at boot over an entry', { autoLaunch: false, before: 'an entry already there' }, []))
    for (const appimage of APPIMAGES) {
      scenarios.push(await scenario(`linux: APPIMAGE ${JSON.stringify(appimage)}`, { autoLaunch: true, env: { APPIMAGE: appimage } }, []))
    }
    scenarios.push(await scenario('linux: autostart is a file', { autoLaunch: true, before: 'autostart is a file' }, [false]))
    scenarios.push(await scenario('linux: pipette.desktop is a directory', { autoLaunch: false, before: 'pipette.desktop is a directory' }, [true]))
    scenarios.push(await scenario('linux: unpackaged build', { autoLaunch: true, isPackaged: false }, [false, true]))
    for (const platform of ['win32', 'darwin'] as const) {
      scenarios.push(await scenario(`${platform}: login item`, { platform, autoLaunch: true }, [false, true]))
      scenarios.push(await scenario(`${platform}: unpackaged build`, { platform, autoLaunch: true, isPackaged: false }, [false]))
    }
    scenarios.push(await scenario('freebsd: nothing', { platform: 'freebsd', autoLaunch: true }, [false]))

    writeJsonFixture(OUT, {
      source: 'applyAutoLaunch of src/main/app-behavior.ts through src/main/index.ts booted on scripts/resident-fixtures',
      execPath: EXEC_PATH,
      autostartPath: '$HOME/.config/autostart/pipette.desktop',
      scenarios,
    })
  })
})
