// SPDX-License-Identifier: GPL-2.0-or-later
// What the Rust → TypeScript checks of the stores (scripts/*/verify-rust-
// stores.test.ts) share: every file and directory under a userData copy,
// so a check can tell that the Electron handlers wrote nothing to it.

import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Every file (path → its bytes as hex) and directory (`path/` → null)
 *  under `dir`, sorted by path. */
export function readTree(dir: string, prefix = ''): Record<string, string | null> {
  const tree: Record<string, string | null> = {}
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (lstatSync(path).isDirectory()) {
      tree[`${prefix}${name}/`] = null
      Object.assign(tree, readTree(path, `${prefix}${name}/`))
    } else {
      tree[`${prefix}${name}`] = readFileSync(path).toString('hex')
    }
  }
  return tree
}
