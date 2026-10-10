// SPDX-License-Identifier: GPL-2.0-or-later
// Ties the pending sync units to the Google account they were changed
// under. `pendingChanges` always belongs to `pendingOwner` (nobody while
// signed out); another account's units wait in `heldPending`, which no
// upload path reads, until that account signs in again. Every pass that
// uploads pending units hands them to the signed-in account first
// (`adoptPendingForSignedInAccount`). Local data itself is shared by every
// account — only the record of what still has to be sent is kept apart.
//
// A sign-in stores its tokens only once no pass holds the sync lock and no
// analytics sync or remote day fetch (the Drive writers that don't take the
// lock) runs, holding the lock and keeping those writers from starting
// meanwhile; if they don't finish within `ACCOUNT_SWITCH_WAIT_MS`, the
// sign-in fails and the old tokens stay. So no Drive request of work
// started under one account is sent with another account's tokens. A
// sign-out waits the same way but goes ahead after the wait: requests sent
// after the tokens are gone fail instead of reaching another account. The
// exception is a password change, which a sign-out refuses instead of
// cutting short.
// Both forget what this process remembers about the previous account
// (`forgetAccountCaches`) once the stored sign-in has changed.

import { getAccountSub, signOut } from './google-auth'
import { forgetAccountCaches } from './sync-account-caches'
import {
  syncRuntime,
  markPending,
  commitPendingState,
  writePendingStateOrThrow,
  afterPendingChange,
  claimSyncLockWhenIdleBy,
} from './sync-runtime-state'

/** How long a sign-in or sign-out waits for running sync work. */
export const ACCOUNT_SWITCH_WAIT_MS = 30_000

export const ACCOUNT_SWITCH_BUSY_MESSAGE = 'Cannot switch accounts while sync is in progress. Try again in a moment.'

/** A sign-in or sign-out refused because sync work is running; `reason`
 *  reaches the renderer through the IPC result (sync-ipc-wrap.ts), which
 *  shows its own message for it. */
export class AccountSwitchBusyError extends Error {
  readonly reason = 'syncBusy' as const
  constructor() {
    super(ACCOUNT_SWITCH_BUSY_MESSAGE)
  }
}

/** Moves the active units to the held set of `owner`. */
function holdActiveFor(owner: string): void {
  const held = syncRuntime.heldPending.get(owner) ?? new Set<string>()
  for (const unit of syncRuntime.pendingChanges) held.add(unit)
  if (held.size > 0) syncRuntime.heldPending.set(owner, held)
  syncRuntime.pendingChanges.clear()
  syncRuntime.pendingGeneration.clear()
}

/** Makes `sub` the owner of the active units: units of another owner are
 *  held for it first, units held for `sub` become active again, and units
 *  changed while signed out go to `sub`. A null `sub` (signed out, or an
 *  account whose tokens carry no id) changes nothing. Returns whether
 *  anything changed. */
function adoptFor(sub: string | null): boolean {
  if (sub === null) return false
  const owner = syncRuntime.pendingOwner
  const heldForSub = syncRuntime.heldPending.get(sub)
  if (owner === sub && !heldForSub) return false
  if (owner !== null && owner !== sub) holdActiveFor(owner)
  syncRuntime.pendingOwner = sub
  if (heldForSub) {
    syncRuntime.heldPending.delete(sub)
    for (const unit of heldForSub) markPending(unit)
  }
  return true
}

/** Applies `change` (which returns whether it changed anything) and writes
 *  the result with a write that throws. When the write fails, the pending
 *  state is put back as it was and the error is rethrown, so the caller can
 *  stop before it switches tokens. */
function changeOwnershipDurably(change: () => boolean): void {
  const owner = syncRuntime.pendingOwner
  const generations = new Map(syncRuntime.pendingGeneration)
  const held = new Map([...syncRuntime.heldPending].map(([sub, units]) => [sub, new Set(units)]))
  if (!change()) return
  try {
    writePendingStateOrThrow()
  } catch (err) {
    syncRuntime.pendingOwner = owner
    syncRuntime.pendingChanges.clear()
    syncRuntime.pendingGeneration.clear()
    for (const [unit, generation] of generations) {
      syncRuntime.pendingChanges.add(unit)
      syncRuntime.pendingGeneration.set(unit, generation)
    }
    syncRuntime.heldPending = held
    throw err
  }
  afterPendingChange()
}

/** Hands the pending units to the account the stored tokens belong to (see
 *  `adoptFor`) and returns that account's id. Called by every pass
 *  that uploads pending units, after its credential check and before it
 *  reads the pending set, and once at startup. */
export async function adoptPendingForSignedInAccount(): Promise<string | null> {
  const sub = await getAccountSub()
  if (adoptFor(sub)) commitPendingState()
  return sub
}

/** Gives ownerless pending units to the account still signed in, before
 *  its tokens are replaced or removed: with no pass since the last launch
 *  (e.g. auto sync off) they were never handed over. Throws when that
 *  cannot be written. */
async function claimOwnerlessForSignedInAccount(): Promise<void> {
  if (syncRuntime.pendingOwner !== null || syncRuntime.pendingChanges.size === 0) return
  const sub = await getAccountSub()
  changeOwnershipDurably(() => {
    if (sub === null || syncRuntime.pendingOwner !== null) return false
    syncRuntime.pendingOwner = sub
    return true
  })
}

/** Runs `switchTokens` with `accountSwitching` set, after waiting (up to
 *  `ACCOUNT_SWITCH_WAIT_MS`) for the sync lock and for the lock-free
 *  writers to finish, holding the lock when it was free in time. When the
 *  wait runs out, `ifBusy: 'refuse'` throws `AccountSwitchBusyError`
 *  without running `switchTokens`; `'proceed'` runs it anyway. Only one
 *  switch runs at a time; another is refused at once. */
async function duringAccountSwitch(ifBusy: 'refuse' | 'proceed', switchTokens: () => Promise<void>): Promise<void> {
  if (syncRuntime.accountSwitching) throw new AccountSwitchBusyError()
  syncRuntime.accountSwitching = true
  let release: (() => void) | null = null
  try {
    const claim = await claimSyncLockWhenIdleBy(Date.now() + ACCOUNT_SWITCH_WAIT_MS)
    release = claim.release
    const idle = claim.idle
    if (!idle && ifBusy === 'refuse') throw new AccountSwitchBusyError()
    await switchTokens()
  } finally {
    release?.()
    syncRuntime.accountSwitching = false
  }
}

/** The token switch of a new sign-in (google-auth.ts `TokenSwitch`): once
 *  running sync work has finished (see the module comment), gives
 *  ownerless units to the account still signed in, hands the pending units
 *  to `newAccountSub`'s account, stores the new tokens, and forgets the
 *  previous account's caches before the lock is released. Each ownership
 *  change is written first; if it cannot be, the sign-in fails and the old
 *  tokens (and caches) stay. */
export async function switchAccountKeepingPending(
  storeTokens: () => Promise<void>,
  newAccountSub: string | null,
): Promise<void> {
  await duringAccountSwitch('refuse', async () => {
    await claimOwnerlessForSignedInAccount()
    changeOwnershipDurably(() => adoptFor(newAccountSub))
    // If storing fails, the old tokens stay and the next pass hands the
    // pending units back to their account.
    await storeTokens()
    // Those ids are files of the previous account's Drive.
    syncRuntime.createdFileIds.clear()
    forgetAccountCaches()
  })
}

/** Marks `syncUnit` pending for `owner`, the account a pass ran as: held
 *  for it when another account has signed in since the pass started. */
export function markPendingFor(owner: string | null, syncUnit: string): void {
  if (owner === null || owner === syncRuntime.pendingOwner) {
    if (!syncRuntime.pendingChanges.has(syncUnit)) markPending(syncUnit)
    return
  }
  const held = syncRuntime.heldPending.get(owner) ?? new Set<string>()
  if (held.has(syncUnit)) return
  held.add(syncUnit)
  syncRuntime.heldPending.set(owner, held)
  commitPendingState()
}

/** Signs out of Google (google-auth.ts `signOut`: the token file and the
 *  cached tokens), first holding the account's pending units for its next
 *  sign-in, then forgets the account's caches; changes made from here on
 *  belong to whoever signs in next. If the hold cannot be written, it
 *  throws and the tokens and caches stay. The caller holds the sync lock
 *  (a reset removing the stored sign-in). */
export async function signOutKeepingPendingLocked(): Promise<void> {
  await claimOwnerlessForSignedInAccount()
  changeOwnershipDurably(() => {
    const owner = syncRuntime.pendingOwner
    if (owner === null) return false
    holdActiveFor(owner)
    syncRuntime.pendingOwner = null
    return true
  })
  await signOut()
  syncRuntime.createdFileIds.clear()
  forgetAccountCaches()
}

/** Refusal of a sign-out while a password change runs (an i18n key). */
const SIGN_OUT_PASSWORD_CHANGING = 'sync.signOutPasswordChanging'

/** `signOutKeepingPendingLocked` once running sync work has finished, or
 *  after `ACCOUNT_SWITCH_WAIT_MS` anyway (see the module comment). Refused
 *  with `SIGN_OUT_PASSWORD_CHANGING` while a password change runs
 *  (`passwordChangeRun`), checked before the first await: removing the
 *  tokens would stop the change halfway. */
export async function signOutKeepingPending(): Promise<void> {
  if (syncRuntime.passwordChangeRun) throw new Error(SIGN_OUT_PASSWORD_CHANGING)
  await duringAccountSwitch('proceed', async () => {
    // Defensive only: no password change can start while `accountSwitching`
    // is set (`withSyncLock`, sync-password-change.ts, refuses it), so this
    // holds only if that guard is ever bypassed.
    if (syncRuntime.passwordChangeRun) throw new Error(SIGN_OUT_PASSWORD_CHANGING)
    await signOutKeepingPendingLocked()
  })
}
