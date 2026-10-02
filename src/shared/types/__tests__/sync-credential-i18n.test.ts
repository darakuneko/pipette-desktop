// SPDX-License-Identifier: GPL-2.0-or-later
//
// Every `SyncCredentialFailureReason` can reach the UI through
// `syncCredentialI18nKey` (the sync status label uses `readiness`, the
// password form uses `changePasswordError`), so each pair needs a real
// string — a missing one shows the raw key on screen.

import { describe, it, expect } from 'vitest'
import english from '../../../renderer/i18n/locales/english.json'
import {
  syncCredentialI18nKey,
  type SyncCredentialFailureReason,
  type SyncCredentialI18nNamespace,
} from '../sync'

// `satisfies Record<…>` makes the compiler reject this list when a reason
// is added to the union but not here.
const REASONS = Object.keys({
  unauthenticated: true,
  noPasswordFile: true,
  decryptFailed: true,
  keystoreUnavailable: true,
  remoteCheckFailed: true,
} satisfies Record<SyncCredentialFailureReason, true>) as SyncCredentialFailureReason[]

const NAMESPACES: SyncCredentialI18nNamespace[] = ['readiness', 'changePasswordError']

function lookup(key: string): unknown {
  let node: unknown = english
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

describe('syncCredentialI18nKey', () => {
  for (const ns of NAMESPACES) {
    for (const reason of REASONS) {
      it(`has an english.json string for ${ns}.${reason}`, () => {
        const value = lookup(syncCredentialI18nKey(ns, reason))
        expect(typeof value).toBe('string')
        expect(value).not.toBe('')
      })
    }
  }
})
