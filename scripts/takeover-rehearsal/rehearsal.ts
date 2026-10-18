// SPDX-License-Identifier: GPL-2.0-or-later
//
// The takeover rehearsal on Linux: a distributed release started on a copy
// of the Electron build's data, with its home, configuration and autostart
// directories all inside the rehearsal root, to check that the takeover
// loses and corrupts nothing. The copy is made beforehand by the user (or
// with the user's permission), with the Electron build quit and without its
// Singleton* files; this script never copies, moves or deletes data.
//
//   tsx scripts/takeover-rehearsal/rehearsal.ts launch-only --root <dir> --app <AppImage> [--firejail]
//   tsx scripts/takeover-rehearsal/rehearsal.ts operate     --root <dir> --app <AppImage> [--firejail]
//
// <dir>/home/.config/pipette-desktop is the copy, <dir>/home/.config/autostart
// may hold a copy of the autostart entry. Reports go to <dir>/reports.
// Exit codes: 0 passed, 1 findings to look at, 2 refused before the launch.

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Layout, type RealPaths, layoutOf, realPathsOf, refusalOf } from './layout'
import { CONFIG_REL, USER_DATA_REL, checkReadable, judgeLaunchOnly, type Finding, type ReadResult } from './rules'
import { LinkError, diffTrees, snapshotTree, type Snapshot, type TreeDiff } from './tree'

export type Mode = 'launch-only' | 'operate'

export interface Options {
  mode: Mode
  root: string
  app: string
  firejail: boolean
  timeoutMinutes: number
}

export class RefusedError extends Error {}

const USAGE = 'usage: rehearsal.ts launch-only|operate --root <dir> --app <AppImage> [--firejail] [--timeout-minutes <n>]'

export function parseArgs(argv: string[]): Options {
  const [mode, ...rest] = argv
  if (mode !== 'launch-only' && mode !== 'operate') throw new RefusedError(USAGE)
  const options: Options = { mode, root: '', app: '', firejail: false, timeoutMinutes: 120 }
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (flag === '--firejail') {
      options.firejail = true
      continue
    }
    if (value === undefined) throw new RefusedError(USAGE)
    if (flag === '--root') options.root = value
    else if (flag === '--app') options.app = value
    else if (flag === '--timeout-minutes' && Number(value) > 0) options.timeoutMinutes = Number(value)
    else throw new RefusedError(USAGE)
    i += 1
  }
  if (!isAbsolute(options.root) || !isAbsolute(options.app)) throw new RefusedError(`${USAGE}\n(--root and --app must be absolute paths)`)
  return options
}

/** Inherited variables the app does not get: every Pipette variable (so
 *  the default userData directory and the autostart takeover run as for
 *  the user) and those of an AppImage the script itself might run in. */
const DROPPED = ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'DBUS_SESSION_BUS_ADDRESS']

/** The environment the app runs with: every per-user location under the
 *  rehearsal home (the display and the runtime directory stay the
 *  session's), the Hub and the startup notices kept off the network, and a
 *  session bus that does not exist, so the app neither hands over to a
 *  Pipette the user has running nor reaches the user's keyring or tray. */
export function appEnv(layout: Layout, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (!name.startsWith('PIPETTE_') && !DROPPED.includes(name)) env[name] = value
  }
  return {
    ...env,
    HOME: layout.home,
    XDG_CONFIG_HOME: layout.config,
    XDG_DATA_HOME: join(layout.home, '.local/share'),
    XDG_CACHE_HOME: join(layout.home, '.cache'),
    XDG_STATE_HOME: join(layout.home, '.local/state'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(layout.root, 'no-session-bus')}`,
    PIPETTE_HUB_TEST: '1',
    PIPETTE_HUB_URL: 'http://127.0.0.1:9',
    PIPETTE_NOTIFICATION_URL: 'http://127.0.0.1:9',
    PIPETTE_E2E: '1',
  }
}

/** Runs the app once and waits for it to end: `launch` starts it with the
 *  environment and the file its output goes to, and resolves with its exit
 *  code. */
export type Launcher = (env: NodeJS.ProcessEnv, outputFile: string) => Promise<number | null>

export function processLauncher(options: Options): Launcher {
  return (env, outputFile) =>
    new Promise((resolvePromise, reject) => {
      const [command, args] = options.firejail
        ? ['firejail', ['--quiet', '--noprofile', '--net=none', options.app]]
        : [options.app, []]
      const output = createWriteStream(outputFile)
      const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.pipe(output, { end: false })
      child.stderr.pipe(output, { end: false })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 30_000).unref()
      }, options.timeoutMinutes * 60_000)
      child.on('error', (err) => {
        clearTimeout(timer)
        output.end()
        reject(err)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        output.end()
        resolvePromise(code)
      })
    })
}

/** The checks before any launch: the paths, the copy, and the copy free of
 *  links. Throws {@link RefusedError}. */
export function preflight(options: Options, real: RealPaths): Layout {
  const layout = layoutOf(resolve(options.root))
  const refusal = refusalOf(layout, real)
  if (refusal) throw new RefusedError(`refused: ${refusal}`)
  if (!existsSync(layout.userData) || !statSync(layout.userData).isDirectory()) {
    throw new RefusedError(`refused: no copy at ${layout.userData}; the copy is made before the rehearsal, not by it`)
  }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    if (existsSync(join(layout.userData, name))) throw new RefusedError(`refused: the copy holds ${name}; copy without the Singleton* files`)
  }
  if (!existsSync(options.app)) throw new RefusedError(`refused: no app at ${options.app}`)
  if (options.firejail && spawnSync('firejail', ['--version']).status !== 0) {
    throw new RefusedError('refused: --firejail was given but firejail does not run')
  }
  takeSnapshot(layout)
  return layout
}

function takeSnapshot(layout: Layout): Snapshot {
  try {
    return snapshotTree(layout.home)
  } catch (err) {
    if (err instanceof LinkError) throw new RefusedError(`refused: ${err.message}`)
    throw err
  }
}

function readConfig(layout: Layout): string | undefined {
  const path = join(layout.home, CONFIG_REL)
  return existsSync(path) ? readFileSync(path, 'utf-8') : undefined
}

export interface LaunchReport {
  exitCode: number | null
  output: string
  diff: TreeDiff
  findings: Finding[]
}

export interface Report {
  mode: Mode
  layout: Layout
  launches: LaunchReport[]
  readable: ReadResult[]
  /** ERROR and WARN lines of the last launch's output, for the user. */
  logLines: string[]
  passed: boolean
}

async function launchOnce(layout: Layout, launch: Launcher, index: number): Promise<LaunchReport> {
  const before = takeSnapshot(layout)
  const configBefore = readConfig(layout)
  const output = join(layout.reports, `launch-${index}.log`)
  const exitCode = await launch(appEnv(layout, process.env), output)
  const after = takeSnapshot(layout)
  const diff = diffTrees(before, after)
  return { exitCode, output, diff, findings: judgeLaunchOnly(diff, layout.home, before, after, configBefore) }
}

/** (a) or (b) on `layout`, with `launch` starting the app. (a): one launch,
 *  every change on the list, nothing removed. (b): a launch the user
 *  operates in, then every new or changed file of the userData directory
 *  read by its rule, then a second launch to see the app read it; removals
 *  are listed for the user to match against the operations. */
export async function rehearse(mode: Mode, layout: Layout, launch: Launcher, say: (line: string) => void): Promise<Report> {
  mkdirSync(layout.reports, { recursive: true })
  const launches: LaunchReport[] = []
  let readable: ReadResult[] = []
  if (mode === 'launch-only') {
    say('Launch 1 of 1: look at the window, do nothing, then Quit from the tray or the window.')
    launches.push(await launchOnce(layout, launch, 1))
  } else {
    say('Launch 1 of 2: go through every keyboard, snapshot, favorite, setting, pack, Key Label, Analyze and Typing Test, then Quit.')
    launches.push(await launchOnce(layout, launch, 1))
    const { added, changed } = launches[0].diff
    readable = checkReadable(
      layout.home,
      [...added, ...changed].filter((path) => inUserData(path) && existsFile(join(layout.home, path))),
    )
    say('Launch 2 of 2: check that everything you did is there, then Quit.')
    launches.push(await launchOnce(layout, launch, 2))
  }
  const last = launches[launches.length - 1]
  const logLines = existsSync(last.output)
    ? readFileSync(last.output, 'utf-8').split('\n').filter((line) => /\[(ERROR|WARN)\]/.test(line))
    : []
  // With operations the data changes by design: what must hold is that it
  // stays readable and that nothing outside it changed.
  const passed =
    mode === 'launch-only'
      ? last.findings.every((finding) => finding.verdict !== 'violation')
      : readable.every((result) => result.verdict !== 'unreadable') &&
        launches.every((launch) => launch.findings.every((finding) => finding.verdict !== 'violation' || inUserData(finding.path)))
  return { mode, layout, launches, readable, logLines, passed }
}

function inUserData(path: string): boolean {
  return path.startsWith(`${USER_DATA_REL}/`)
}

function existsFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function summarize(report: Report, say: (line: string) => void): void {
  for (const [index, launch] of report.launches.entries()) {
    say(`launch ${index + 1}: exit code ${String(launch.exitCode)}, output in ${launch.output}`)
    for (const finding of launch.findings) {
      // With operations, new and changed data files are listed by the read
      // check below instead.
      if (report.mode === 'operate' && inUserData(finding.path) && finding.change !== 'removed') continue
      say(`  ${finding.verdict.padEnd(9)} ${finding.change.padEnd(7)} ${finding.path} (${finding.reason})`)
    }
  }
  for (const result of report.readable) say(`  ${result.verdict.padEnd(10)} ${result.path} (${result.reason})`)
  for (const line of report.logLines) say(`  log: ${line}`)
  say(report.passed ? 'PASSED' : 'FINDINGS: look at the lines above before going further')
}

async function main(): Promise<number> {
  const say = (line: string): void => console.log(line)
  let options: Options
  let layout: Layout
  try {
    options = parseArgs(process.argv.slice(2))
    layout = preflight(options, realPathsOf(userInfo().homedir, process.env))
  } catch (err) {
    if (err instanceof RefusedError) {
      console.error(err.message)
      return 2
    }
    throw err
  }
  const report = await rehearse(options.mode, layout, processLauncher(options), say)
  const file = join(layout.reports, `${options.mode}-${new Date().toISOString().replaceAll(':', '-')}.json`)
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  summarize(report, say)
  say(`report: ${file}`)
  return report.passed ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err)
      process.exit(1)
    },
  )
}
