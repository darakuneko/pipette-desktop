// SPDX-License-Identifier: GPL-2.0-or-later
//
// What a rehearsal accepts. (a) A launch with no operation may change only
// a short list of files; nothing may be removed. (b) After a launch with
// operations, every file that is new or changed in the userData directory
// must still be readable, by the rule of its kind.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { USER_DATA_NAME } from './layout'
import { sha256Of, type Snapshot, type TreeDiff } from './tree'

/** The userData and autostart directories relative to the home directory,
 *  as the snapshots name paths. */
export const USER_DATA_REL = `.config/${USER_DATA_NAME}`
export const AUTOSTART_REL = '.config/autostart'
/** The app's config, kept before a launch to compare with afterwards. */
export const CONFIG_REL = `${USER_DATA_REL}/config.json`

export type ChangeKind = 'added' | 'changed' | 'removed'

export interface Finding {
  path: string
  change: ChangeKind
  /** `allowed`: on the list; `outside`: a new file outside the userData
   *  and autostart directories (the WebView's own data), listed only;
   *  `violation`: stops the rehearsal for the user to look at. */
  verdict: 'allowed' | 'outside' | 'violation'
  reason: string
}

const ANALYTICS_DB = 'local/typing-analytics.db'
const SQLITE_SIDE_FILES = [`${ANALYTICS_DB}-wal`, `${ANALYTICS_DB}-shm`]
/** The quit sequence's marker (`PENDING_MARKER_FILE` of
 *  src-tauri/src/shutdown.rs), written at quit and removed when it ends. */
const QUIT_MARKER = 'quit-pending.json'
/** Chromium's lock file, which the app keeps open on Windows. */
const WINDOWS_LOCKFILE = 'lockfile'
/** Directories the allowed files may need. */
const ALLOWED_NEW_DIRS = ['logs', 'local']

function inside(path: string, dir: string): string | null {
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path === dir ? '' : null
}

/** The config without `windowState`, as JSON text, or null when it is not
 *  an object. */
function configWithoutWindowState(text: string): string | null {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const rest: Record<string, unknown> = { ...(parsed as Record<string, unknown>) }
  delete rest.windowState
  return JSON.stringify(rest)
}

function configVerdict(dataDir: string, change: ChangeKind, configBefore: string | undefined): [boolean, string] {
  if (change === 'removed') return [false, 'the config was removed']
  try {
    const after = configWithoutWindowState(readFileSync(join(dataDir, 'config.json'), 'utf-8'))
    const before = configBefore === undefined ? '{}' : configWithoutWindowState(configBefore)
    if (after !== null && after === before) return [true, 'only windowState changed']
    return [false, 'a key other than windowState changed']
  } catch (err) {
    return [false, `the config cannot be read: ${String(err)}`]
  }
}

/** A launch's changes in a userData directory: the directory, the snapshots
 *  around the launch, the prefix of the directory's paths in them (empty
 *  when they were taken of the directory itself) and the config's text
 *  before the launch. */
export interface DataLaunch {
  dataDir: string
  before: Snapshot
  after: Snapshot
  prefix: string
  configBefore: string | undefined
}

/** The verdict on one change inside the userData directory (`rel` relative
 *  to it). */
function userDataVerdict(rel: string, change: ChangeKind, launch: DataLaunch): [boolean, string] {
  const key = launch.prefix ? `${launch.prefix}/${rel}` : rel
  if (launch.after.get(key)?.kind === 'dir' && change === 'added') {
    return ALLOWED_NEW_DIRS.includes(rel) ? [true, 'a directory the log or the cache needs'] : [false, 'a new directory']
  }
  if (rel.startsWith('logs/')) {
    if (change === 'added') return [true, 'a new log file']
    if (change === 'removed') return [false, 'a log file was removed (rotation)']
    const old = launch.before.get(key)
    if (old?.kind === 'file' && sha256Of(join(launch.dataDir, rel), old.size) === old.sha256) {
      return [true, 'lines appended to the log']
    }
    return [false, 'a log file was rewritten (rotation)']
  }
  if (rel === 'config.json') return configVerdict(launch.dataDir, change, launch.configBefore)
  if (rel === ANALYTICS_DB) {
    return change === 'removed' ? [false, 'the analytics cache was removed'] : [true, 'the analytics cache']
  }
  if (SQLITE_SIDE_FILES.includes(rel)) return [true, "SQLite's journal of the analytics cache"]
  if (rel === QUIT_MARKER) return [true, 'the quit marker']
  if (rel === WINDOWS_LOCKFILE && change === 'added') return [true, "Chromium's lock file (Windows)"]
  return [false, 'not on the list of files a launch may change']
}

function changesOf(diff: TreeDiff): [string, ChangeKind][] {
  return [
    ...diff.added.map((path): [string, ChangeKind] => [path, 'added']),
    ...diff.changed.map((path): [string, ChangeKind] => [path, 'changed']),
    ...diff.removed.map((path): [string, ChangeKind] => [path, 'removed']),
  ]
}

/** The findings of a launch without operations in a userData directory
 *  whose snapshots were taken of the directory itself (`launch.prefix`
 *  empty): the rehearsal of a temporary OS user on Windows and macOS. */
export function judgeDataDir(diff: TreeDiff, launch: DataLaunch): Finding[] {
  return changesOf(diff).map(([path, change]) => {
    const [ok, reason] = userDataVerdict(path, change, launch)
    return { path, change, verdict: ok ? 'allowed' : 'violation', reason }
  })
}

/** The findings of a launch without operations: every change from
 *  `before` to `after` (snapshots of `home`), `configBefore` being the
 *  config's text before the launch. */
export function judgeLaunchOnly(
  diff: TreeDiff,
  home: string,
  before: Snapshot,
  after: Snapshot,
  configBefore: string | undefined,
): Finding[] {
  const launch: DataLaunch = { dataDir: join(home, USER_DATA_REL), before, after, prefix: USER_DATA_REL, configBefore }
  return changesOf(diff).map(([path, change]) => {
    const rel = inside(path, USER_DATA_REL)
    if (rel !== null && rel !== '') {
      const [ok, reason] = userDataVerdict(rel, change, launch)
      return { path, change, verdict: ok ? 'allowed' : 'violation', reason }
    }
    if (path === `${AUTOSTART_REL}/pipette.desktop`) {
      return { path, change, verdict: 'allowed', reason: 'the autostart entry, taken over' }
    }
    if (path === AUTOSTART_REL && change === 'added') {
      return { path, change, verdict: 'allowed', reason: 'the autostart directory' }
    }
    if (change === 'added' && rel === null && inside(path, AUTOSTART_REL) === null) {
      return { path, change, verdict: 'outside', reason: 'a new file outside the data (the WebView keeps its own)' }
    }
    return { path, change, verdict: 'violation', reason: 'a change outside the list' }
  })
}

export interface ReadResult {
  path: string
  verdict: 'readable' | 'unreadable' | 'unchecked'
  reason: string
}

function checkJson(text: string): void {
  JSON.parse(text)
}

function checkJsonLines(text: string): number {
  let lines = 0
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    try {
      JSON.parse(line)
    } catch (err) {
      throw new Error(`line ${index + 1}: ${String(err)}`, { cause: err })
    }
    lines += 1
  }
  return lines
}

/** Opens a copy of the database (and its journal) and checks it: the
 *  integrity check passes and every table can be counted. */
function checkDatabase(path: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pipette-rehearsal-db-'))
  try {
    const copy = join(dir, basename(path))
    copyFileSync(path, copy)
    for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix)
    const db = new DatabaseSync(copy)
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all()
      const first = integrity[0] as Record<string, unknown> | undefined
      if (integrity.length !== 1 || first?.integrity_check !== 'ok') {
        throw new Error(`integrity_check: ${JSON.stringify(integrity)}`)
      }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      const counts = tables.map((row) => {
        const name = String((row as Record<string, unknown>).name)
        const count = db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as Record<string, unknown>
        return `${name} ${String(count.n)}`
      })
      return `integrity ok; ${counts.join(', ')}`
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Reads each of `paths` (relative to `home`) by the rule of its kind:
 *  JSON parses, JSON Lines parse line by line, the SQLite cache opens and
 *  passes its integrity check. Logs, the cache's journal and files of other
 *  kinds are listed as unchecked. */
export function checkReadable(home: string, paths: string[]): ReadResult[] {
  return paths.map((path) => {
    const full = join(home, path)
    try {
      if (path.endsWith('.log') || SQLITE_SIDE_FILES.some((side) => path.endsWith(side))) {
        return { path, verdict: 'unchecked', reason: 'a log or a journal' }
      }
      if (path.endsWith('.json')) {
        checkJson(readFileSync(full, 'utf-8'))
        return { path, verdict: 'readable', reason: 'JSON' }
      }
      if (path.endsWith('.jsonl')) {
        const lines = checkJsonLines(readFileSync(full, 'utf-8'))
        return { path, verdict: 'readable', reason: `JSON Lines, ${lines} lines` }
      }
      if (path.endsWith('.db')) return { path, verdict: 'readable', reason: checkDatabase(full) }
      return { path, verdict: 'unchecked', reason: 'no rule for this kind of file' }
    } catch (err) {
      return { path, verdict: 'unreadable', reason: String(err) }
    }
  })
}
