// SPDX-License-Identifier: GPL-2.0-or-later
// The Tauri window's CSP (src-tauri/tauri.conf.json) must stay the Electron
// policy from src/main/csp.ts plus only the sources Tauri's IPC needs, and
// its response headers the Electron ones, so a change to either side cannot
// loosen or drift from the other unnoticed.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCsp, securityHeaders } from '../../main/csp'

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

/**
 * Electron headers Tauri cannot send, each with the directive of the CSP
 * that does the same job. Tauri accepts only a fixed list of header names.
 */
const REPLACED_HEADERS: Record<string, [directive: string, sources: string[]]> = {
  'X-Frame-Options': ['frame-ancestors', ["'none'"]],
}

interface TauriSecurity {
  csp: Record<string, string>
  devCsp: Record<string, string>
  headers: Record<string, string>
}

const security = (
  JSON.parse(readFileSync(resolve(__dirname, '../../../src-tauri/tauri.conf.json'), 'utf8')) as {
    app: { security: TauriSecurity }
  }
).app.security

function tauriPolicy(key: 'csp' | 'devCsp'): Policy {
  return sortedPolicy(
    Object.fromEntries(
      Object.entries(security[key]).map(([name, value]) => [name, value.split(/\s+/)]),
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

  it('allows neither inline code nor eval in production', () => {
    const sources = Object.values(tauriPolicy('csp')).flat()
    expect(sources).not.toContain("'unsafe-inline'")
    expect(sources).not.toContain("'unsafe-eval'")
  })
})

describe('Tauri security headers', () => {
  it('sends the Electron headers it can, and no others', () => {
    const expected = Object.fromEntries(
      Object.entries(securityHeaders)
        .filter(([name]) => !(name in REPLACED_HEADERS))
        .map(([name, values]) => [name, values.join(', ')]),
    )
    expect(security.headers).toEqual(expected)
  })

  it.each(Object.entries(REPLACED_HEADERS))(
    'covers %s with a CSP directive in both policies',
    (_header, [directive, sources]) => {
      expect(tauriPolicy('csp')[directive]).toEqual(sources)
      expect(tauriPolicy('devCsp')[directive]).toEqual(sources)
    },
  )
})
