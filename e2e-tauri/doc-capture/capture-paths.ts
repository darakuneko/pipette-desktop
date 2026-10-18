// SPDX-License-Identifier: GPL-2.0-or-later
//
// The only places the capture writes: the session's userData directory,
// which must be a temporary directory away from any real configuration
// directory, and the screenshot directory, which is docs/screenshots or a
// directory inside the temporary directory.

import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWithin, resolveExisting } from '../helpers/driver'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The screenshots the operation guide shows. */
export const DOCS_SCREENSHOT_DIR = join(PROJECT_ROOT, 'docs', 'screenshots')

/** Names another screenshot directory, for a run that must not change the
 *  committed screenshots. */
export const SCREENSHOT_DIR_VARIABLE = 'PIPETTE_DOC_SCREENSHOT_DIR'

/** Where {@link screenshotDir} looks: the project and its
 *  docs/screenshots, and the system's temporary directory. */
export interface ScreenshotDirPlaces {
  projectRoot: string
  docsDir: string
  tempDir: string
}

const DEFAULT_PLACES: ScreenshotDirPlaces = {
  projectRoot: PROJECT_ROOT,
  docsDir: DOCS_SCREENSHOT_DIR,
  tempDir: tmpdir(),
}

/** The directory the screenshots go to, symbolic links resolved:
 *  docs/screenshots, or the absolute path in
 *  {@link SCREENSHOT_DIR_VARIABLE} when it is docs/screenshots or inside
 *  the temporary directory. docs/screenshots must resolve inside the
 *  project, and neither may resolve inside a real configuration directory
 *  ({@link realConfigDirs}). Anything else throws. */
export function screenshotDir(env: NodeJS.ProcessEnv = process.env, places: ScreenshotDirPlaces = DEFAULT_PLACES): string {
  const docs = resolveExisting(places.docsDir)
  if (!isWithin(docs, realpathSync(places.projectRoot))) {
    throw new Error(`${places.docsDir} resolves outside the project, to ${docs}`)
  }
  const wanted = env[SCREENSHOT_DIR_VARIABLE]
  let resolved = docs
  if (wanted !== undefined && wanted !== '') {
    if (!isAbsolute(wanted)) throw new Error(`${SCREENSHOT_DIR_VARIABLE} must be an absolute path, not ${wanted}`)
    resolved = resolveExisting(resolve(wanted))
    const temp = realpathSync(places.tempDir)
    if (resolved !== docs && (resolved === temp || !isWithin(resolved, temp))) {
      throw new Error(`${SCREENSHOT_DIR_VARIABLE} must be docs/screenshots or inside ${temp}, not ${wanted} (${resolved})`)
    }
  }
  assertOutsideRealConfig(resolved, env, 'the screenshot directory')
  return resolved
}

/** The path a screenshot named `filename` is written to in `dir` (a
 *  {@link screenshotDir} result). A symbolic link already at that name is
 *  removed first, so the write makes a new file there instead of writing
 *  through the link; any other non-file there throws. */
export function screenshotPath(dir: string, filename: string): string {
  if (filename !== basename(filename) || filename === '' || filename === '.' || filename === '..') {
    throw new Error(`a screenshot name must be a plain file name, not ${filename}`)
  }
  const path = join(dir, filename)
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return path
  }
  if (stat.isSymbolicLink()) unlinkSync(path)
  else if (!stat.isFile()) throw new Error(`${path} exists and is not a file`)
  return path
}

/** The configuration directories of the user (where the installed app and
 *  the Electron build keep their userData), for the home and
 *  configuration directories of this process and of `env`. */
function realConfigDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const homes = [homedir(), env.HOME, process.env.HOME]
  const configs = [env.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME]
  const dirs = [
    ...homes.filter((home): home is string => !!home && isAbsolute(home)).map((home) => join(home, '.config')),
    ...configs.filter((config): config is string => !!config && isAbsolute(config)),
  ]
  return [...new Set(dirs)]
}

/** Throws unless `userDataDir`, symbolic links resolved, is strictly inside
 *  `tempDir` and inside none of {@link realConfigDirs}. Returns the
 *  resolved path. */
export function assertCaptureUserData(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  tempDir: string = tmpdir(),
): string {
  const resolved = resolveExisting(resolve(userDataDir))
  assertOutsideRealConfig(resolved, env, "the capture's userData directory")
  const temp = realpathSync(tempDir)
  if (resolved === temp || !isWithin(resolved, temp)) {
    throw new Error(`the capture's userData directory ${resolved} is not inside the temporary directory ${temp}`)
  }
  return resolved
}

/** Throws when `resolved` (symbolic links resolved) is inside one of
 *  {@link realConfigDirs}. */
function assertOutsideRealConfig(resolved: string, env: NodeJS.ProcessEnv, what: string): void {
  for (const dir of realConfigDirs(env)) {
    let real = resolve(dir)
    try {
      real = resolveExisting(real)
    } catch {
      // A part of it cannot be resolved (a dangling link): compared as written.
    }
    if (isWithin(resolved, real)) {
      throw new Error(`${what} ${resolved} is inside the real configuration directory ${real}`)
    }
  }
}
