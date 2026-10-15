// SPDX-License-Identifier: GPL-2.0-or-later
// File output shared by the fixture generators under scripts/.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Writes `content` to `path`, creating the parent directories. */
export function writeFixture(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Writes `value` as two-space indented JSON with a trailing newline. */
export function writeJsonFixture(path: string, value: unknown): void {
  writeFixture(path, JSON.stringify(value, null, 2) + '\n')
}
