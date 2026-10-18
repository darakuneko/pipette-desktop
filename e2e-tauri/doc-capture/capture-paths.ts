// SPDX-License-Identifier: GPL-2.0-or-later
//
// The only places the capture writes: the session's userData directory,
// which must be a temporary directory away from any real configuration
// directory, and the screenshot directory, which is docs/screenshots or a
// directory inside the temporary directory.

import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWithin, resolveExisting } from '../helpers/driver'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The screenshots the operation guide shows. */
export const DOCS_SCREENSHOT_DIR = join(PROJECT_ROOT, 'docs', 'screenshots')

/** Names another screenshot directory, for a run that must not change the
 *  committed screenshots. */
export const SCREENSHOT_DIR_VARIABLE = 'PIPETTE_DOC_SCREENSHOT_DIR'

/** The directory the screenshots go to, symbolic links resolved:
 *  docs/screenshots, or the absolute path in
 *  {@link SCREENSHOT_DIR_VARIABLE} when it is docs/screenshots or inside
 *  `tempDir` (the system's temporary directory). Anything else throws. */
export function screenshotDir(env: NodeJS.ProcessEnv = process.env, tempDir: string = tmpdir()): string {
  const docs = resolveExisting(DOCS_SCREENSHOT_DIR)
  const wanted = env[SCREENSHOT_DIR_VARIABLE]
  if (wanted === undefined || wanted === '') return docs
  if (!isAbsolute(wanted)) throw new Error(`${SCREENSHOT_DIR_VARIABLE} must be an absolute path, not ${wanted}`)
  const resolved = resolveExisting(resolve(wanted))
  if (resolved === docs) return resolved
  const temp = realpathSync(tempDir)
  if (resolved !== temp && isWithin(resolved, temp)) return resolved
  throw new Error(`${SCREENSHOT_DIR_VARIABLE} must be docs/screenshots or inside ${temp}, not ${wanted} (${resolved})`)
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
  for (const dir of realConfigDirs(env)) {
    let real = resolve(dir)
    try {
      real = resolveExisting(real)
    } catch {
      // A part of it cannot be resolved (a dangling link): compared as written.
    }
    if (isWithin(resolved, real)) {
      throw new Error(`the capture's userData directory ${resolved} is inside the real configuration directory ${real}`)
    }
  }
  const temp = realpathSync(tempDir)
  if (resolved === temp || !isWithin(resolved, temp)) {
    throw new Error(`the capture's userData directory ${resolved} is not inside the temporary directory ${temp}`)
  }
  return resolved
}
