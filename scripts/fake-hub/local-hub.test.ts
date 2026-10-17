// SPDX-License-Identifier: GPL-2.0-or-later
// The conformance cases that need no control endpoints, against a local
// pipette-hub in its test mode, to check that the fake answers as the Hub
// does. Optional: it runs only when PIPETTE_HUB_LOCAL_URL names a local Hub
// (http://localhost:<port> or http://127.0.0.1:<port>) that answers, and
// is skipped otherwise. Start one first:
//   cd ../pipette-hub && pnpm run db:migrate:local && pnpm run dev:test
// then:
//   PIPETTE_HUB_LOCAL_URL=http://localhost:8787 pnpm run test:fake-hub
// Every run uses fresh accounts and names (a run tag in each case), so the
// local Hub's database can keep the records of earlier runs.

import { describe, expect, it } from 'vitest'
import { CONFORMANCE, runCase, runsWithoutControl } from './conformance-runner'

const LOCAL_URL = process.env.PIPETTE_HUB_LOCAL_URL

/** The URL when it is a loopback one; anything else is refused before a
 *  request is sent. */
function localBase(raw: string | undefined): string | null {
  if (!raw) return null
  const url = new URL(raw)
  if (url.protocol !== 'http:' || (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) {
    throw new Error(`PIPETTE_HUB_LOCAL_URL must be a loopback http URL, not ${raw}`)
  }
  return url.origin
}

async function answers(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/key-labels?per_page=1`, { signal: AbortSignal.timeout(2000) })
    return response.ok
  } catch {
    return false
  }
}

const base = localBase(LOCAL_URL)
const up = base !== null && (await answers(base))

describe.skipIf(!up)('a local pipette-hub', () => {
  it('passes the conformance cases without control steps', { timeout: 10 * 60_000 }, async () => {
    const cases = CONFORMANCE.cases.filter(runsWithoutControl)
    expect(cases.length).toBeGreaterThan(0)
    const tag = `r${Date.now().toString(36)}`
    for (const [index, testCase] of cases.entries()) {
      await runCase(base as string, testCase, { run: `${tag}c${index}`, retryRateLimited: true })
    }
  })
})
