// SPDX-License-Identifier: GPL-2.0-or-later
//
// Where a rehearsal keeps its home directory, the copied userData directory
// and the autostart directory, and the checks that keep all of them away
// from the real ones: the rehearsal never runs on the user's own data.

import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The directory name of the Electron build's userData, the one a
 *  distributed release takes over (`ELECTRON_USER_DATA_NAME` of
 *  src-tauri/crates/pipette-fs/src/user_data.rs). */
export const USER_DATA_NAME = 'pipette-desktop'

/** The paths of a rehearsal rooted at `root` (the directory the copy was
 *  made in). The app gets `home` as `HOME` and `config` as
 *  `XDG_CONFIG_HOME`, so its default userData directory is `userData` and
 *  its autostart directory `autostart`. */
export interface Layout {
  root: string
  home: string
  config: string
  userData: string
  autostart: string
  /** Where the reports and the app's output go, outside `home`. */
  reports: string
}

export function layoutOf(root: string): Layout {
  const home = join(root, 'home')
  const config = join(home, '.config')
  return {
    root,
    home,
    config,
    userData: join(config, USER_DATA_NAME),
    autostart: join(config, 'autostart'),
    reports: join(root, 'reports'),
  }
}

/** The places that belong to the user running the script: the home
 *  directories (the account's and `$HOME`) and every configuration or
 *  application data directory there may be. */
export interface RealPaths {
  homes: string[]
  configs: string[]
}

/** The real paths of this process: `accountHome` is the home directory in
 *  the system's user database (`os.userInfo().homedir`), `env` the
 *  process's environment. */
export function realPathsOf(accountHome: string, env: NodeJS.ProcessEnv): RealPaths {
  const homes = [accountHome, env.HOME].filter((dir): dir is string => !!dir && isAbsolute(dir))
  const configs = homes.flatMap((home) => [join(home, '.config'), join(home, 'Library')])
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    const dir = env[name]
    if (dir && isAbsolute(dir)) configs.push(dir)
  }
  return { homes, configs }
}

/** `path` with its symbolic links resolved: the longest part that exists,
 *  resolved, and the rest appended as written. */
export function resolveExisting(path: string): string {
  let existing = resolve(path)
  const missing: string[] = []
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..')
    if (parent === existing) break
    missing.unshift(relative(parent, existing))
    existing = parent
  }
  return join(realpathSync(existing), ...missing)
}

/** Whether `inner` is `outer` or inside it. */
export function isWithin(inner: string, outer: string): boolean {
  const rel = relative(outer, inner)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Why the rehearsal must not run on `layout`, or nothing. Every path is
 *  compared resolved: the root must lie outside every real home directory
 *  and contain none, and the home, userData and autostart directories must
 *  not be or lie inside any real home or configuration directory. */
export function refusalOf(layout: Layout, real: RealPaths): string | null {
  const homes = real.homes.map(resolveExisting)
  const configs = real.configs.map(resolveExisting)
  const root = resolveExisting(layout.root)
  for (const home of homes) {
    if (isWithin(root, home)) return `the rehearsal root ${root} is inside the home directory ${home}`
    if (isWithin(home, root)) return `the rehearsal root ${root} holds the home directory ${home}`
  }
  const paths: [string, string][] = [['home', layout.home], ['userData', layout.userData], ['autostart', layout.autostart]]
  for (const [name, path] of paths) {
    const resolved = resolveExisting(path)
    for (const real of [...homes, ...configs]) {
      if (isWithin(resolved, real)) return `the rehearsal ${name} ${resolved} is inside the real directory ${real}`
    }
    if (!isWithin(resolved, root)) return `the rehearsal ${name} ${resolved} leaves the rehearsal root ${root}`
  }
  return null
}
