// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the secret store, the sign-in and the password
// strength of the Tauri build: runs the Electron main process's
// sync-crypto.ts, sync-secret-file.ts and google-auth.ts in the sync
// fixture harness (setup.ts) and records
//   - the stored password status for each state of the file and the key
//     store (crates/pipette-secret-store/tests/fixtures/ts_secret_status.json);
//   - authorization URLs with their verifier and state, the token requests
//     of a code exchange and of a refresh, and the stored token JSON, with
//     and without a refresh token in the exchange's answer
//     (crates/pipette-google-auth/tests/fixtures/ts_auth.json);
//   - `checkPasswordStrength` over a table of passwords
//     (src-tauri/tests/fixtures/password-strength.json), which the shim's
//     strength check must match.
//
// Run: pnpm run generate:sync-auth-fixtures

import { resolve } from 'node:path'
import { safeStorage } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkPasswordStrength, storedPasswordStatus } from '../../src/main/sync/sync-crypto'
import { exchangeCodeForTokens, generateAuthUrl, getAccessToken, signOut } from '../../src/main/sync/google-auth'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { readTree, seedUserData } from './harness'

const SECRET_STATUS_OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-secret-store/tests/fixtures/ts_secret_status.json')
const AUTH_OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-google-auth/tests/fixtures/ts_auth.json')
const STRENGTH_OUT = resolve(REPO_ROOT, 'src-tauri/tests/fixtures/password-strength.json')

/** What the harness's safeStorage writes for `plain`. */
const sealed = (plain: string): string => `fixture-safe-storage:${plain}`

afterEach(() => {
  vi.mocked(safeStorage.isEncryptionAvailable).mockImplementation(() => true)
  vi.unstubAllGlobals()
})

describe('record the secret store fixtures', () => {
  it('records the stored password status for each file and key store state', async () => {
    const files = { missing: null, opens: sealed('hunter2'), damaged: 'not sealed by safeStorage' } as const
    const rows: Array<{ file: keyof typeof files; keystoreAvailable: boolean; status: string }> = []
    for (const file of ['missing', 'opens', 'damaged'] as const) {
      for (const keystoreAvailable of [true, false]) {
        // A file that opens needs the key, which an unavailable key store
        // does not give: Electron never reaches that state.
        if (file === 'opens' && !keystoreAvailable) continue
        const content = files[file]
        seedUserData(content === null ? {} : { 'local/auth/sync-password.enc': content })
        vi.mocked(safeStorage.isEncryptionAvailable).mockImplementation(() => keystoreAvailable)
        rows.push({ file, keystoreAvailable, status: await storedPasswordStatus() })
      }
    }
    expect(rows.map((row) => row.status)).toEqual([
      'noPasswordFile',
      'keystoreUnavailable',
      'readable',
      'decryptFailed',
      'keystoreUnavailable',
    ])
    writeJsonFixture(SECRET_STATUS_OUT, rows)
  })
})

describe('record the sign-in fixtures', () => {
  it('records authorization URLs, the token requests and the stored tokens', async () => {
    const authUrls = [8080, 54321].map((port) => ({ port, ...generateAuthUrl(port) }))

    const requests: Array<{ method: string; url: string; headers: unknown; body: string }> = []
    const answers = [
      { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3599, token_type: 'Bearer', id_token: 'h.e30.s' },
      { access_token: 'fixture-refreshed', expires_in: 3599, token_type: 'Bearer' },
      { access_token: 'fixture-access-only', expires_in: 3599, token_type: 'Bearer' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string; headers: unknown; body: string }) => {
      requests.push({ method: init.method, url, headers: init.headers, body: init.body })
      return { ok: true, json: async () => answers[requests.length - 1] }
    }))

    const userData = seedUserData()
    await signOut()
    await exchangeCodeForTokens('fixture-code/+?&=', authUrls[0].codeVerifier, 8080)
    const storedAfterExchange = readTree(userData)['local/auth/oauth-tokens.enc']

    // A token that expired: the next access refreshes it.
    await signOut()
    const expired = { accessToken: 'old', refreshToken: 'fixture-refresh/+?&=', expiresAt: 0, idToken: 'h.e30.s' }
    seedUserData({ 'local/auth/oauth-tokens.enc': sealed(JSON.stringify(expired)) })
    expect(await getAccessToken()).toBe('fixture-refreshed')
    await signOut()

    // An exchange whose answer has no refresh token.
    const withoutRefreshToken = seedUserData()
    await exchangeCodeForTokens('fixture-code', authUrls[0].codeVerifier, 8080)
    const storedWithoutRefreshToken = readTree(withoutRefreshToken)['local/auth/oauth-tokens.enc']
    await signOut()

    expect(requests).toHaveLength(3)
    writeJsonFixture(AUTH_OUT, {
      now: Date.now(),
      authUrls,
      exchange: { code: 'fixture-code/+?&=', codeVerifier: authUrls[0].codeVerifier, port: 8080, request: requests[0] },
      refresh: { refreshToken: expired.refreshToken, request: requests[1] },
      storedAfterExchange: storedAfterExchange?.replace(/^fixture-safe-storage:/, ''),
      storedWithoutRefreshToken: storedWithoutRefreshToken?.replace(/^fixture-safe-storage:/, ''),
    })
  })
})

describe('record the password strength fixtures', () => {
  it('records checkPasswordStrength over a table of passwords', () => {
    const passwords = [
      '',
      'a',
      'password',
      'P@ssw0rd',
      'qwertyuiop',
      '1234567890',
      'aaaaaaaaaaaa',
      'Tr0ub4dor&3',
      'correct horse battery staple',
      'kX9#mQ2$vL7!pZ',
      'pipette-sync-2026',
      'パスワード日本語テスト',
      'john.smith@example.com',
      'Summer2024!',
    ]
    writeJsonFixture(STRENGTH_OUT, passwords.map((password) => ({ password, ...checkPasswordStrength(password) })))
  })
})
