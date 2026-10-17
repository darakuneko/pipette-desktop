// SPDX-License-Identifier: GPL-2.0-or-later
// Handler scenarios: a seeded userData, a scripted Hub and a
// list of steps that call the Electron Hub IPC handlers as the renderer
// would. The recorder (record-hub-handler-fixtures.test.ts) writes, per
// scenario:
//   - the rules of the scripted Hub and the userData tree before;
//   - per step: the step, the handler's answer, the requests it sent
//     (request-log.ts), the waits of a 429, the sync units it notified
//     (`notifyChange`), the broadcasts and the log lines;
//   - the userData tree after the last step, once it has settled.
// The Rust tests seed the tree, give the in-memory Hub the same rules, run
// the same steps through the Rust handlers and compare all of it.

import type { Tree } from '../sync-fixtures/harness'
import type { HubRule } from './hub-harness'
import type { IpcChannels } from '../../src/shared/ipc/channels'

export type Channel = keyof typeof IpcChannels

export interface Call {
  call: Channel
  args: readonly unknown[]
}

export type Step =
  /** Calls a handler and waits for its answer. */
  | Call
  /** Calls the handlers at once; the answers are in this order. The
   *  requests of the step are written sorted. */
  | { together: Call[] }
  /** The id_token `getIdToken` answers from now on (null: signed out). */
  | { idToken: string | null }
  /** Signing in or out: `clearHubTokenCache` (hub-ipc-token.ts). */
  | { clearHubTokenCache: true }
  /** The startup auto-update of Hub-linked language packs
   *  (`startI18nStartupSync`, i18n-startup-sync.ts), run to its end.
   *  `summary`: the pass checks Hub-linked packs and so ends with its
   *  `i18n startup sync: checked=` log line, which the recorder waits for
   *  before it waits for the userData to settle. */
  | { startupSync: true; summary: boolean }

export interface Scenario {
  name: string
  /** Files of the userData before the steps (besides the fixed
   *  installation id). */
  tree?: Tree
  /** Entries made through the Electron stores after `tree` is written;
   *  the tree the Rust tests seed is the one recorded after this. */
  seed?: () => Promise<void>
  rules: HubRule[]
  steps: Step[]
  /** Requests within a step run in parallel, so each step's log is
   *  written sorted. */
  unordered?: boolean
}

/** A scripted answer `{ ok: true, data }`. */
export const ok = (data: unknown, status = 200) => ({ status, json: { ok: true, data } })

/** The Hub user every token answer carries. */
export const USER = { id: 'u-1', email: 'user@example.com', display_name: 'User', role: 'user' }

/** Answers of `/api/auth/token` with the JWTs `jwt-1`, `jwt-2`, … */
export function tokenRule(count: number, extra: HubRule['responses'] = []): HubRule {
  return {
    method: 'POST',
    path: '/api/auth/token',
    responses: [...extra, ...Array.from({ length: count }, (_, i) => ok({ token: `jwt-${i + 1}`, user: USER }))],
  }
}
