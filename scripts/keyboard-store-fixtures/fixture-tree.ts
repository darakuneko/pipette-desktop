// SPDX-License-Identifier: GPL-2.0-or-later
// The userData trees the store fixture generators of this directory build
// before a scenario and record after it (path → content), and the
// response text they record for a step.

import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A userData tree: file path → UTF-8 content (`{ hex }` for bytes that are
 *  not UTF-8), or null for a directory. */
export type Tree = Record<string, string | { hex: string } | null>

export function buildTree(dir: string, tree: Tree): void {
  for (const [path, content] of Object.entries(tree)) {
    const target = join(dir, path)
    if (content === null) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, typeof content === 'string' ? content : Buffer.from(content.hex, 'hex'))
  }
}

/** Every file and directory (`path/` → null) under `dir`. */
export function recordTree(dir: string, prefix = ''): Tree {
  const tree: Tree = {}
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (lstatSync(path).isDirectory()) {
      tree[`${prefix}${name}/`] = null
      Object.assign(tree, recordTree(path, `${prefix}${name}/`))
    } else {
      const bytes = readFileSync(path)
      const text = bytes.toString('utf-8')
      tree[`${prefix}${name}`] = Buffer.from(text, 'utf-8').equals(bytes) ? text : { hex: bytes.toString('hex') }
    }
  }
  return tree
}

/** The response as JSON text, with the text of an error the crate does
 *  not copy replaced: a file-system error's (the OS's and Node's) as
 *  `<os error>`, and a JSON.parse error's (V8's) as `<syntax error>`. */
export function outcomeText(response: unknown): string | null {
  const r = response as { error?: unknown }
  if (typeof r?.error === 'string' && /^Error: E[A-Z]+:/.test(r.error)) {
    return JSON.stringify({ ...r, error: '<os error>' })
  }
  if (typeof r?.error === 'string' && r.error.startsWith('SyntaxError: ')) {
    return JSON.stringify({ ...r, error: '<syntax error>' })
  }
  return JSON.stringify(response) ?? null
}
