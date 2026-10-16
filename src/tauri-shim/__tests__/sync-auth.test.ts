// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The sign-in and password statuses, setting and re-entering the password,
// the password-check and the sync format status come from the backend; the
// password strength check runs in the shim and gives the answers of the
// Electron main process's checkPasswordStrength
// (src-tauri/tests/fixtures/password-strength.json, recorded by
// scripts/sync-fixtures/record-secrets-auth.test.ts).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { syncAuthApi } from '../api/sync-auth'
import { syncExecuteApi } from '../api/sync-execute'
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

  it('sends the password to the backend and answers its result', async () => {
    const calls: Array<[string, unknown]> = []
    mockIPC((cmd, args) => {
      calls.push([cmd, args])
      if (cmd === 'sync_set_password') return { success: true }
      if (cmd === 'sync_replace_password') return { success: false, error: 'sync.passwordMismatch' }
      if (cmd === 'sync_check_password_exists') return true
      return undefined
    })
    await expect(syncPasswordApi.syncSetPassword('pw')).resolves.toEqual({ success: true })
    await expect(syncPasswordApi.syncReplacePassword('typo')).resolves.toEqual({ success: false, error: 'sync.passwordMismatch' })
    await expect(syncPasswordApi.syncCheckPasswordExists()).resolves.toBe(true)
    expect(calls.map(([cmd, args]) => [cmd, args && Object.fromEntries(Object.entries(args as object))])).toEqual([
      ['sync_set_password', { password: 'pw' }],
      ['sync_replace_password', { password: 'typo' }],
      ['sync_check_password_exists', {}],
    ])
  })
})

describe('sync format status', () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('answers the status from the backend and passes each change until unsubscribed', async () => {
    const status = { required: 3, supported: 2, updateRequired: true }
    mockIPC((cmd) => (cmd === 'sync_format_status' ? status : undefined), { shouldMockEvents: true })
    await expect(syncExecuteApi.syncFormatStatus()).resolves.toEqual(status)
    const callback = vi.fn()
    const unsubscribe = syncExecuteApi.syncOnFormatStatusChanged(callback)
    await settle()
    await emit('sync:format-status-changed', status)
    await emit('sync:format-status-changed', null)
    unsubscribe()
    await emit('sync:format-status-changed', status)
    expect(callback.mock.calls).toEqual([[status], [null]])
  })
})
