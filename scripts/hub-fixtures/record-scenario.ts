// SPDX-License-Identifier: GPL-2.0-or-later
// Records the handler scenarios of scenarios/*.ts (handler-scenario.ts
// describes them) with the Electron Hub IPC handlers, in the Hub fixture
// harness (hub-harness.ts), against a scripted Hub that never connects, and
// writes one golden file per domain: ts_hub_handlers_<domain>.json. The
// generators call `setupHubIpc()` and `setAnswerActions({ clearHubTokenCache })`
// first, and `restoreFetch()` after each test.
//
// Run: pnpm run generate:hub-fixtures

import { expect } from 'vitest'
import { writeJsonFixture } from '../fixture-files'
import { tagged } from '../analytics-db-fixtures/tagged'
import { FIXED_INSTALLATION_ID, FIXED_NOW, seedUserData } from '../sync-fixtures/harness'
import {
  FAKE_ID_TOKEN,
  HUB_BASE,
  scriptedFetch,
  setIdToken,
  setRules,
  settledTree,
  waitForLog,
  takeRecorded,
  unusedRules,
  withRecordedHubSleeps,
} from './hub-harness'
import { expand } from './expand'
import { invokeHandler } from './ipc-handlers'
import { sortedLog } from './request-log'
import { hubFixturePath } from './paths'
import type { Call, Scenario, Step } from './handler-scenario'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { clearHubTokenCache } from '../../src/main/hub/hub-ipc'
import { startI18nStartupSync } from '../../src/main/hub/i18n-startup-sync'

const guarded = globalThis.fetch
const problems: string[] = []

function sorted<T>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)]
    return x < y ? -1 : x > y ? 1 : 0
  })
}

async function invoke(call: Call): Promise<unknown> {
  return tagged(await invokeHandler(IpcChannels[call.call], expand(call.args) as unknown[]))
}

async function runStep(step: Step, dir: string): Promise<unknown> {
  if ('call' in step) return invoke(step)
  if ('together' in step) return Promise.all(step.together.map(invoke))
  if ('idToken' in step) {
    setIdToken(step.idToken)
    return null
  }
  if ('clearHubTokenCache' in step) {
    clearHubTokenCache()
    return null
  }
  // The startup auto-update is fire-and-forget. A pass that checks packs
  // ends with its summary line (the broadcast comes right after it, in the
  // same call); every pass has ended once the userData has settled.
  startI18nStartupSync()
  if (step.summary) await waitForLog('i18n startup sync: checked=')
  await settledTree(dir)
  return null
}

async function record(scenario: Scenario): Promise<unknown> {
  clearHubTokenCache()
  setIdToken(FAKE_ID_TOKEN)
  const dir = seedUserData(scenario.tree ?? {})
  if (scenario.seed) await scenario.seed()
  const treeBefore = await settledTree(dir)
  takeRecorded()
  globalThis.fetch = scriptedFetch()
  setRules(scenario.rules)
  const steps = []
  try {
    for (const step of scenario.steps) {
      const answer = await withRecordedHubSleeps(() => runStep(step, dir))
      const recorded = takeRecorded()
      const parallel = scenario.unordered === true || 'together' in step
      // Parallel work finishes in any order: what it recorded is sorted.
      steps.push({
        step,
        answer,
        requests: parallel ? sortedLog(recorded.requests) : recorded.requests,
        sleeps: parallel ? sorted(recorded.sleeps) : recorded.sleeps,
        notified: parallel ? sorted(recorded.notified) : recorded.notified,
        events: parallel ? sorted(recorded.events) : recorded.events,
        logs: parallel ? sorted(recorded.logs) : recorded.logs,
      })
    }
  } finally {
    globalThis.fetch = guarded
  }
  const treeAfter = await settledTree(dir)
  // Checked before the file is written.
  problems.push(
    ...unusedRules().map((rule) => `${scenario.name}: answers nobody asked for: ${rule.method} ${rule.path}`),
    ...Object.entries(takeRecorded())
      .filter(([, list]) => list.length > 0)
      .map(([kind]) => `${scenario.name}: ${kind} recorded after the last step`),
  )
  return { name: scenario.name, rules: scenario.rules, treeBefore, steps, treeAfter }
}

/** How a domain's golden file describes itself besides the shared text. */
export interface DomainFile {
  /** The generator that writes the file, from the repository root. */
  generator: string
  /** Conditions of the recording, as sentences after the shared text. */
  about?: string
  /** Fields written before `scenarios`. */
  extra?: Record<string, unknown>
}

/** Records the scenarios of `domain` and writes ts_hub_handlers_<domain>.json.
 *  The scenarios at the indexes of `repeated` (the first by default) must
 *  give the same record on a second run. */
export async function recordDomain(
  domain: string,
  scenarios: readonly Scenario[],
  file: DomainFile,
  repeated: readonly number[] = [0],
): Promise<void> {
  const recorded = []
  for (const scenario of scenarios) recorded.push(await record(scenario))
  for (const index of repeated) {
    if (index < scenarios.length) expect(await record(scenarios[index])).toEqual(recorded[index])
  }
  expect(problems.splice(0)).toEqual([])
  writeJsonFixture(hubFixturePath(`ts_hub_handlers_${domain}.json`), {
    about: `The Electron Hub IPC handlers of the ${domain} scenarios (scripts/hub-fixtures/scenarios), as scripts/hub-fixtures/handler-scenario.ts describes: the scripted Hub's rules, the userData tree before (with the fixed installation id), per step the answer (tagged), requests, waits, notified sync units, broadcasts and log lines, then the tree after.${file.about ? ` ${file.about}` : ''} Generated by ${file.generator}; do not edit.`,
    hubBase: HUB_BASE,
    nowMs: FIXED_NOW,
    installationId: FIXED_INSTALLATION_ID,
    ...file.extra,
    scenarios: recorded,
  })
}

/** Puts back the guarded `fetch` after a test whose scenario failed. */
export function restoreFetch(): void {
  globalThis.fetch = guarded
}
