// SPDX-License-Identifier: GPL-2.0-or-later
// The Tauri window's CSP (src-tauri/tauri.conf.json) must stay the Electron
// policy from src/main/csp.ts plus only the sources Tauri's IPC needs, so a
// change to either side cannot loosen or drift from the other unnoticed.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCsp } from '../../main/csp'

/** Tauri's IPC: the custom protocol and its http fallback on Linux/Windows. */
const TAURI_ADDITIONS: Record<string, string[]> = {
  'connect-src': ['ipc:', 'http://ipc.localhost'],
}

type Policy = Record<string, string[]>

function parseCsp(csp: string): Policy {
  const policy: Policy = {}
  for (const directive of csp.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/)
    policy[name] = sources
  }
  return policy
}

function sortedPolicy(policy: Policy): Policy {
  return Object.fromEntries(
    Object.entries(policy)
      .map(([name, sources]): [string, string[]] => [name, [...sources].sort()])
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}

function expectedPolicy(isDev: boolean): Policy {
  const policy = parseCsp(buildCsp(isDev))
  for (const [name, sources] of Object.entries(TAURI_ADDITIONS)) {
    policy[name] = [...(policy[name] ?? []), ...sources]
  }
  return sortedPolicy(policy)
}

function tauriPolicy(key: 'csp' | 'devCsp'): Policy {
  const conf = JSON.parse(
    readFileSync(resolve(__dirname, '../../../src-tauri/tauri.conf.json'), 'utf8'),
  ) as { app: { security: Record<'csp' | 'devCsp', Record<string, string>> } }
  return sortedPolicy(
    Object.fromEntries(
      Object.entries(conf.app.security[key]).map(([name, value]) => [name, value.split(/\s+/)]),
    ),
  )
}

describe('Tauri CSP', () => {
  it('matches the Electron production policy plus the Tauri IPC sources', () => {
    expect(tauriPolicy('csp')).toEqual(expectedPolicy(false))
  })

  it('matches the Electron dev policy plus the Tauri IPC sources', () => {
    expect(tauriPolicy('devCsp')).toEqual(expectedPolicy(true))
  })
})
