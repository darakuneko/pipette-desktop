// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the sync password of the Tauri build: set, replace,
// status, the strength check and whether Drive has a password-check. All but
// the strength check are the backend's (src-tauri/src/sync_commands/password.rs);
// the password goes to the backend and never comes back to the page. The
// strength check runs here, with the library and dictionaries
// `checkPasswordStrength` of src/main/sync/sync-crypto.ts uses, loaded the
// first time a password is checked.
// coverage.test.ts lists the members each of these modules holds.

import type { ZxcvbnFactory } from '@zxcvbn-ts/core'
import type { PasswordStrength, SyncOperationResult } from '../../shared/types/sync'
import type { VialAPI } from '../../shared/types/vial-api'
import type { StoredPasswordStatus } from '../generated/StoredPasswordStatus'
import { call } from '../ipc'

let checker: Promise<ZxcvbnFactory> | null = null

/** The strength checker, built once with the options of sync-crypto.ts. A
 *  failed load is tried again on the next check. */
function loadChecker(): Promise<ZxcvbnFactory> {
  checker ??= Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
    import('@zxcvbn-ts/language-en'),
  ]).then(
    ([core, common, en]) =>
      new core.ZxcvbnFactory({
        translations: en.translations,
        graphs: common.adjacencyGraphs,
        dictionary: { ...common.dictionary, ...en.dictionary },
      }),
    (err: unknown) => {
      checker = null
      throw err
    },
  )
  return checker
}

/** `checkPasswordStrength` of src/main/sync/sync-crypto.ts. */
async function checkPasswordStrength(password: string): Promise<PasswordStrength> {
  if (password === '') return { score: 0, feedback: [] }
  const result = (await loadChecker()).check(password)
  return {
    score: result.score,
    feedback: [...(result.feedback.warning ? [result.feedback.warning] : []), ...result.feedback.suggestions],
  }
}

export const syncPasswordApi = {
  syncSetPassword: (password) => call<SyncOperationResult>('sync_set_password', { password }),
  syncReplacePassword: (password) => call<SyncOperationResult>('sync_replace_password', { password }),
  syncPasswordStatus: () => call<StoredPasswordStatus>('sync_password_status'),
  syncValidatePassword: checkPasswordStrength,
  syncCheckPasswordExists: () => call<boolean>('sync_check_password_exists'),
} satisfies Partial<VialAPI>
