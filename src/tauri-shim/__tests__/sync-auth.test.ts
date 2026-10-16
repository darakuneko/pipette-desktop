// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The sign-in and password statuses come from the backend; the password
// strength check runs in the shim and gives the answers of the Electron
// main process's checkPasswordStrength
// (src-tauri/tests/fixtures/password-strength.json, recorded by
// scripts/sync-fixtures/record-secrets-auth.test.ts).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { syncAuthApi } from '../api/sync-auth'
import { syncPasswordApi } from '../api/sync-password'

interface StrengthRow {
  password: string
  score: number
  feedback: string[]
}

const STRENGTH: StrengthRow[] = JSON.parse(
  readFileSync(resolve(__dirname, '../../../src-tauri/tests/fixtures/password-strength.json'), 'utf8'),
)

afterEach(() => {
  clearMocks()
})

describe('sync sign-in and password', () => {
  it('answers the statuses from the backend', async () => {
    mockIPC((cmd) => {
      if (cmd === 'sync_auth_status') return { authenticated: true }
      if (cmd === 'sync_password_status') return 'keystoreUnavailable'
      return undefined
    })
    await expect(syncAuthApi.syncAuthStatus()).resolves.toEqual({ authenticated: true })
    await expect(syncPasswordApi.syncPasswordStatus()).resolves.toBe('keystoreUnavailable')
  })

  it('signs in and out through the backend, answering its results', async () => {
    const calls: string[] = []
    mockIPC((cmd) => {
      calls.push(cmd)
      if (cmd === 'sync_auth_start') {
        return { success: false, error: 'Cannot switch accounts while sync is in progress. Try again in a moment.', reason: 'syncBusy' }
      }
      if (cmd === 'sync_auth_sign_out') return { success: true }
      return undefined
    })
    await expect(syncAuthApi.syncAuthStart()).resolves.toEqual({
      success: false,
      error: 'Cannot switch accounts while sync is in progress. Try again in a moment.',
      reason: 'syncBusy',
    })
    await expect(syncAuthApi.syncAuthSignOut()).resolves.toEqual({ success: true })
    expect(calls).toEqual(['sync_auth_start', 'sync_auth_sign_out'])
  })

  it('rates passwords as the Electron main process does, without the backend', async () => {
    const backend = vi.fn()
    mockIPC(backend)
    expect(STRENGTH.length).toBeGreaterThan(10)
    for (const { password, score, feedback } of STRENGTH) {
      await expect(syncPasswordApi.syncValidatePassword(password), password).resolves.toEqual({ score, feedback })
    }
    expect(backend).not.toHaveBeenCalled()
  })
})
