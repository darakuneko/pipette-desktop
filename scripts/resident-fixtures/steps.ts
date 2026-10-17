// SPDX-License-Identifier: GPL-2.0-or-later
// Scenario recording for the resident fixture generators: each step is an
// action on the booted app and everything it did (the calls electron-mock.ts
// recorded, the log lines, the value it answered).

import { resolve } from 'node:path'
import { REPO_ROOT } from '../fixture-vitest-config'
import { harnessState, type RecordedCall } from './harness'

export interface Step {
  action: Record<string, unknown>
  result?: unknown
  calls: RecordedCall[]
  logs?: { level: string; message: string }[]
}

export interface Scenario {
  name: string
  boot: Record<string, unknown>
  /** What the boot itself did. */
  bootCalls: RecordedCall[]
  steps: Step[]
}

/** Takes what was recorded since the last take. */
export function takeRecorded(): { calls: RecordedCall[]; logs: { level: string; message: string }[] } {
  const state = harnessState()
  const out = { calls: state.calls, logs: state.logs }
  state.calls = []
  state.logs = []
  return out
}

/** Runs `run` and returns the step: the action, what `run` returned (left
 *  out when undefined) and what was recorded meanwhile (log lines left out
 *  when there are none). */
export async function step(action: Record<string, unknown>, run: () => unknown): Promise<Step> {
  takeRecorded()
  const result = await run()
  const { calls, logs } = takeRecorded()
  return {
    action,
    ...(result === undefined ? {} : { result }),
    calls,
    ...(logs.length === 0 ? {} : { logs }),
  }
}

/** Where the goldens of the app crate (src-tauri/tests) go. */
export function residentFixturePath(name: string): string {
  return resolve(REPO_ROOT, 'src-tauri/tests/fixtures/resident', name)
}
